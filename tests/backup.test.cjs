'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const scope = 'https://www.googleapis.com/auth/drive.file';
const date = '2026-11-02';
const copy = value => JSON.parse(JSON.stringify(value));
function diary(activity = '朝の散歩') {
  return {schemaVersion:2,records:{[date]:{amActivity:activity,amMood:60,pmActivity:'',pmMood:'',reflection:'日記',goal1Result:'',goal2Result:''}},
    weekGoals:{[date]:{goal1:'毎日歩く',goal2:'',updatedAt:null}},settings:{weekStartsOn:1},meta:{updatedAt:'2026-11-02T00:00:00Z'}};
}

function driveFixture(clientId = '123456-test.apps.googleusercontent.com') {
  const calls = [], clients = [], timers = new Map(), stored = new Map();
  let timerId=0, cloudText='', folder=false, file=false;
  const state = {response:{access_token:'private-test-token',scope,expires_in:3600},status:200,mismatch:false,requestCount:0};
  const sandbox = {
    URL, URLSearchParams, Headers, Blob, AbortController, console,
    setTimeout(fn,ms) {const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout(id) {timers.delete(id);},
    addEventListener() {},
    document:{querySelector(selector) {return selector.startsWith('meta') ? {content:clientId} : null;}},
    localStorage:{setItem(k,v){stored.set(k,v);}},
    google:{accounts:{oauth2:{initTokenClient(config) {
      assert.equal(config.scope,scope);assert.equal(config.include_granted_scopes,false);
      const client={config,requestAccessToken(options) {
        calls.push(options);
        if (state.popupError) queueMicrotask(()=>config.error_callback({type:'popup_closed'}));
        else if (!state.holdAuth) queueMicrotask(()=>config.callback(state.response));
      }};clients.push(client);return client;
    }}}},
    async fetch(input,options) {
      state.requestCount++;
      const url=new URL(input);
      assert.equal(url.origin,'https://www.googleapis.com');
      assert.match(url.pathname,/^\/(upload\/)?drive\/v3\/files/);
      assert.equal(options.headers.get('Authorization'),'Bearer private-test-token');
      for (const [key,value] of Object.entries({credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})) assert.equal(options[key],value);
      assert(!url.href.includes('private-test-token'));
      if (state.status!==200) return {ok:false,status:state.status,text(){throw Error('Error body must never be read');}};
      let result;
      if (url.pathname.startsWith('/upload/')) {
        const text=await options.body.text();
        assert(text.includes('komorebi-record-backup-v1'));
        assert(!text.includes('prismaAbyssType'));
        const match=/Content-Type: application\/json\r\n\r\n([\s\S]*)\r\n--[^\r]+--$/.exec(text);
        assert(match);cloudText=match[1];file=true;
        result={id:'file-1',name:'komorebi-backup.json'};
        state.lastMethod=options.method;
      } else if (url.searchParams.get('alt')==='media') return {ok:true,status:200,text:async()=>state.mismatch ? 'mismatched' : cloudText};
      else if (options.method==='POST') {
        const meta=JSON.parse(options.body);assert.equal(meta.name,'こもれび記録 Backups');
        assert.equal(meta.appProperties.komorebiType,'komorebi-backup-folder-v1');
        folder=true;result={id:'folder-1'};
      } else if (url.searchParams.get('q').includes('application/vnd.google-apps.folder')) result={files:folder?[{id:'folder-1'}]:[]};
      else result={files:file?[{id:'file-1'}]:[]};
      return {ok:true,status:200,json:async()=>result};
    }
  };
  sandbox.window=sandbox;
  const context=vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root,'google-drive.js'),'utf8'),context);
  return {drive:sandbox.KomorebiDrive,state,calls,timers,stored,clients};
}

test('Drive roundtrip isolates diary files, reads back uploads, and requests an account for each operation',async()=>{
  const {drive,calls,stored,state}=driveFixture();
  await drive.prepare();assert.equal(calls.length,0);assert.equal(state.requestCount,0);
  const text=JSON.stringify({format:'komorebi-record-backup',data:diary()});
  await drive.authorize();await drive.uploadBackup(text);assert.equal(state.lastMethod,'POST');drive.clearSession();
  await assert.rejects(drive.downloadBackup(),/認証期限/);
  await drive.authorize();await drive.uploadBackup(text);assert.equal(state.lastMethod,'PATCH');drive.clearSession();
  await drive.authorize();assert.equal((await drive.downloadBackup()).text,text);drive.clearSession();
  assert.equal(calls.length,3);for(const options of calls)assert.equal(options.prompt,'select_account');
  assert.equal(stored.size,0,'OAuth information must never be persisted');
});

test('Unconfigured Drive cannot initialize authentication',async()=>{
  const {drive,clients,state}=driveFixture('');
  assert.equal(drive.isConfigured(),false);await assert.rejects(drive.prepare(),/設定/);
  assert.equal(clients.length,0);assert.equal(state.requestCount,0);
});

test('Denied, excessive, and expired authorization never reaches Drive',async()=>{
  for(const response of [{error:'access_denied'}, {access_token:'private-test-token',scope:scope+' profile',expires_in:3600}, {access_token:'private-test-token',scope,expires_in:0}]) {
    const {drive,state}=driveFixture();state.response=response;await drive.prepare();
    await assert.rejects(drive.authorize());assert.equal(state.requestCount,0);
    await assert.rejects(drive.downloadBackup(),/認証期限/);
  }
});

test('Closed popups and authorization timeout allow another explicit attempt',async()=>{
  const {drive,state,timers}=driveFixture();await drive.prepare();state.popupError=true;
  await assert.rejects(drive.authorize(),/中止/);state.popupError=false;state.holdAuth=true;
  const pending=drive.authorize();const timeout=[...timers.values()].find(t=>t.ms===120000);assert(timeout);timeout.fn();
  await assert.rejects(pending,/タイムアウト/);assert.equal(drive.isReady(),false);
  state.holdAuth=false;await drive.prepare();await drive.authorize();drive.clearSession();
});

test('HTTP errors and upload mismatches cannot report a successful backup',async()=>{
  const {drive,state}=driveFixture();await drive.prepare();await drive.authorize();
  state.mismatch=true;await assert.rejects(drive.uploadBackup('{}'),/保存内容/);state.mismatch=false;
  state.status=401;await assert.rejects(drive.downloadBackup(),/401/);
  state.status=200;await assert.rejects(drive.downloadBackup(),/認証期限/);
});

test('Oversized multipart uploads fail before any Drive files are changed',async()=>{
  const {drive,state}=driveFixture();await drive.prepare();await drive.authorize();
  await assert.rejects(drive.uploadBackup('x'.repeat(5*1024*1024)),/5MB/);assert.equal(state.requestCount,0);
});

function appFixture({indexedDB=true}={}) {
  const storage=new Map(),database=new Map(),nodes=new Map();
  const control={rejectActivity:null,delayActivity:null,release:null};
  const rejected=value=>value?.records?.[date]?.amActivity===control.rejectActivity;
  const sandbox={console,structuredClone,setTimeout,clearTimeout,Date,Blob,URL,TextEncoder,
    window:{addEventListener(){}},document:{addEventListener(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{inert:false});return nodes.get(selector);}},
    navigator:{},confirm:()=>true,
    localStorage:{getItem:k=>storage.get(k)??null,setItem(k,v){if(k==='komorebi-record-shadow-v1'&&rejected(JSON.parse(v)))throw Error('storage full');storage.set(k,v);}},
    initial:diary(),database,control,copy,
    async put(key,value) {
      if(key==='state'&&rejected(value))throw Error('disk full');
      if(key==='state'&&value?.records?.[date]?.amActivity===control.delayActivity)await new Promise(resolve=>control.release=resolve);
      database.set(key,copy(value));
    }
  };
  const context=vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root,'app.js'),'utf8'),context);
  vm.runInContext(`state=normalizeState(initial);db=${indexedDB?'{}':'null'};
    dbPut=put;dbGet=async key=>database.get(key);dbKeys=async()=>[...database.keys()];dbDelete=async key=>database.delete(key);
    renderView=()=>{};renderSettings=async()=>{};updateStorageUi=()=>{};setSaveIndicator=()=>{};showToast=()=>{};`,context);
  return {run:code=>vm.runInContext(code,context),context,storage,database,control,nodes};
}

test('File and Drive backups share validation, preserving compatibility with existing JSON exports',()=>{
  const app=appFixture();app.context.incoming=diary();
  assert.equal(app.run('parseBackupObject({format:"komorebi-record-backup",data:incoming}).records["2026-11-02"].amActivity'),'朝の散歩');
  for (const bad of [{...diary(),records:[]},{...diary(),records:{'2026-02-30':{}}},{...diary(),weekGoals:[]},{...diary(),records:{[date]:{amActivity:{bad:true}}}},{...diary(),records:{[date]:{amMood:101}}}]) {
    app.context.incoming=bad;assert.throws(()=>app.run('parseBackupObject(incoming)'));
  }
  app.context.incoming={schemaVersion:1,records:{},monthGoals:{'2026-11':{goal1:'旧形式の目標',goal2:''}},settings:{weekStartsOn:1}};
  assert(Object.values(app.run('parseBackupObject(incoming).weekGoals')).some(goal=>goal.goal1==='旧形式の目標'));
});

test('Replace durably restores records, goals and settings and keeps a pre-import recovery point',async()=>{
  const app=appFixture();app.context.incoming=diary('復元した記録');app.context.incoming.settings.weekStartsOn=0;
  await app.run('applyBackupData(parseBackupObject(incoming),"replace")');
  assert.equal(app.run('state.records["2026-11-02"].amActivity'),'復元した記録');assert.equal(app.run('state.settings.weekStartsOn'),0);
  assert.equal(app.database.get('state').records[date].amActivity,'復元した記録');
  assert.equal(JSON.parse(app.storage.get('komorebi-record-shadow-v1')).records[date].amActivity,'復元した記録');
  const snapshots=await app.run('getSnapshots()');assert(snapshots.some(s=>s.reason==='読込前'&&s.state.records[date].amActivity==='朝の散歩'));
  assert.equal(app.nodes.get('#appMain').inert,false);assert.equal(app.nodes.get('.main-nav').inert,false);
});

test('Merge retains other dates and gives the backup precedence on matching dates',async()=>{
  const app=appFixture();app.run('state.records["2026-11-01"]={amActivity:"端末だけの記録"}');app.context.incoming=diary('Google側の記録');
  await app.run('applyBackupData(parseBackupObject(incoming),"merge")');
  assert.equal(app.run('state.records["2026-11-01"].amActivity'),'端末だけの記録');
  assert.equal(app.run('state.records["2026-11-02"].amActivity'),'Google側の記録');
});

test('Failed restore rolls both storage paths back and releases the editing lock',async()=>{
  const app=appFixture();app.control.rejectActivity='保存失敗';app.context.incoming=diary('保存失敗');
  await assert.rejects(app.run('applyBackupData(parseBackupObject(incoming),"replace")'),/読込前の状態に戻/);
  assert.equal(app.run('state.records["2026-11-02"].amActivity'),'朝の散歩');
  assert.equal(app.database.get('state').records[date].amActivity,'朝の散歩');
  assert.equal(JSON.parse(app.storage.get('komorebi-record-shadow-v1')).records[date].amActivity,'朝の散歩');
  assert.equal(app.nodes.get('#appMain').inert,false);
});

test('A localStorage-only browser can recover the state from before import',async()=>{
  const app=appFixture({indexedDB:false});app.context.incoming=diary('読込後');
  await app.run('applyBackupData(parseBackupObject(incoming),"replace")');
  assert((await app.run('getSnapshots()')).some(s=>s.key==='komorebi-record-before-import-v1'));
  await app.run('restoreSnapshot(RECOVERY_KEY)');
  assert.equal(app.run('state.records["2026-11-02"].amActivity'),'朝の散歩');
});

test('An autosave during restore waits instead of overwriting the incoming data',async()=>{
  const app=appFixture();app.context.incoming=diary('書込待ち');app.control.delayActivity='書込待ち';
  app.run('globalThis.pendingImport=applyBackupData(parseBackupObject(incoming),"replace");void 0');
  await new Promise(setImmediate);assert(app.control.release);
  let flushed=false;const flushing=app.run('flushSave()').then(()=>flushed=true);
  await new Promise(setImmediate);assert.equal(flushed,false);
  app.control.release();await app.run('pendingImport');await flushing;
  assert.equal(app.database.get('state').records[date].amActivity,'書込待ち');
});

test('A successful fallback restore stays newer than a stale primary copy',async()=>{
  const app=appFixture();app.context.incoming=diary('予備保存からの復元');
  await app.run('flushSave()');
  app.run('dbPut=async (key,value)=>{if(key==="state"&&value.records["2026-11-02"]?.amActivity==="予備保存からの復元")throw Error("primary unavailable");return put(key,value);};');
  await app.run('applyBackupData(parseBackupObject(incoming),"replace")');
  const primary=app.database.get('state'),shadow=JSON.parse(app.storage.get('komorebi-record-shadow-v1'));
  assert.equal(primary.records[date].amActivity,'朝の散歩');assert.equal(shadow.records[date].amActivity,'予備保存からの復元');
  assert(Date.parse(shadow.meta.updatedAt)>Date.parse(primary.meta.updatedAt),'Reload must select the restored fallback copy');
});

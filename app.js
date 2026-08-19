'use strict';

const APP_VERSION = '1.1.0';
const SCHEMA_VERSION = 1;
const DB_NAME = 'komorebi-record-db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const STATE_KEY = 'state';
const SHADOW_KEY = 'komorebi-record-shadow-v1';
const MAX_SNAPSHOTS = 8;
const AUTO_SNAPSHOT_INTERVAL = 6 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

let state;
let db = null;
let currentView = 'calendar';
let currentWeekDate = startOfWeek(new Date());
let currentCalendarMonth = startOfMonth(new Date());
let selectedCalendarDate = toDateKey(new Date());
let saveTimer = null;
let savePromise = Promise.resolve();
let toastTimer = null;
let primaryStorageOkay = true;
let shadowStorageOkay = true;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function defaultState() {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    records: {},
    monthGoals: {},
    settings: { weekStartsOn: 1 },
    meta: {
      createdAt: now,
      updatedAt: now,
      lastSnapshotAt: null,
      lastBackupAt: null
    }
  };
}

function defaultRecord() {
  return {
    amActivity: '', amMood: '', pmActivity: '', pmMood: '', reflection: '',
    goal1Result: '', goal2Result: '', updatedAt: null
  };
}

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isValidState(value) {
  return !!value && typeof value === 'object' && Number(value.schemaVersion) === SCHEMA_VERSION &&
    value.records && typeof value.records === 'object' && value.monthGoals && typeof value.monthGoals === 'object';
}

function normalizeState(input) {
  const base = defaultState();
  if (!isValidState(input)) return base;
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    records: input.records || {},
    monthGoals: input.monthGoals || {},
    settings: { ...base.settings, ...(input.settings || {}) },
    meta: { ...base.meta, ...(input.meta || {}) }
  };
}

function updatedMs(s) {
  const t = Date.parse(s?.meta?.updatedAt || '');
  return Number.isFinite(t) ? t : 0;
}

function openDatabase() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(undefined);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(key, value) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('IndexedDB unavailable'));
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

function dbDelete(key) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbKeys() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    if (store.getAllKeys) {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      return;
    }
    const keys = [];
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(keys);
      keys.push(cursor.key); cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function readShadow() {
  try {
    const raw = localStorage.getItem(SHADOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidState(parsed) ? normalizeState(parsed) : null;
  } catch {
    shadowStorageOkay = false;
    return null;
  }
}

function writeShadow(value) {
  try {
    localStorage.setItem(SHADOW_KEY, JSON.stringify(value));
    shadowStorageOkay = true;
    return true;
  } catch {
    shadowStorageOkay = false;
    return false;
  }
}

async function loadState() {
  db = await openDatabase();
  primaryStorageOkay = !!db;
  let primary = null;
  if (db) {
    try {
      const candidate = await dbGet(STATE_KEY);
      if (isValidState(candidate)) primary = normalizeState(candidate);
    } catch {
      primaryStorageOkay = false;
    }
  }
  const shadow = readShadow();
  const chosen = primary && shadow ? (updatedMs(shadow) > updatedMs(primary) ? shadow : primary) : (primary || shadow || defaultState());
  state = normalizeState(chosen);

  // Repair whichever local copy is missing/stale.
  if (db && (!primary || updatedMs(state) > updatedMs(primary))) {
    try { await dbPut(STATE_KEY, deepClone(state)); primaryStorageOkay = true; } catch { primaryStorageOkay = false; }
  }
  writeShadow(state);
}

function setSaveIndicator(mode, text) {
  const el = $('#saveIndicator');
  el.classList.toggle('is-saving', mode === 'saving');
  el.classList.toggle('is-error', mode === 'error');
  $('#saveText').textContent = text;
}

function scheduleSave() {
  setSaveIndicator('saving', '保存中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePromise = savePromise.then(persistState).catch(() => {});
  }, 450);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  savePromise = savePromise.then(persistState).catch(() => {});
  return savePromise;
}

async function persistState() {
  const now = new Date();
  const nowIso = now.toISOString();
  state.meta.updatedAt = nowIso;
  state.appVersion = APP_VERSION;

  const lastSnapshot = Date.parse(state.meta.lastSnapshotAt || '');
  const snapshotDue = !Number.isFinite(lastSnapshot) || now.getTime() - lastSnapshot >= AUTO_SNAPSHOT_INTERVAL;
  if (snapshotDue) state.meta.lastSnapshotAt = nowIso;

  let primarySaved = false;
  let shadowSaved = false;
  if (db) {
    try {
      await dbPut(STATE_KEY, deepClone(state));
      primaryStorageOkay = true;
      primarySaved = true;
      if (snapshotDue) {
        await dbPut(`snapshot:${nowIso}`, { createdAt: nowIso, reason: '自動', state: deepClone(state) });
        await pruneSnapshots();
      }
    } catch (err) {
      console.error(err);
      primaryStorageOkay = false;
    }
  }
  shadowSaved = writeShadow(state);

  updateStorageUi();
  if (primarySaved && shadowSaved) setSaveIndicator('saved', '保存済み（2重保存）');
  else if (primarySaved || shadowSaved) setSaveIndicator('saved', '保存済み（予備経路）');
  else setSaveIndicator('error', '保存できません');
}

async function createSnapshotInternal(reason = '手動') {
  if (!db) throw new Error('IndexedDB unavailable');
  const nowIso = new Date().toISOString();
  await dbPut(`snapshot:${nowIso}`, { createdAt: nowIso, reason, state: deepClone(state) });
  state.meta.lastSnapshotAt = nowIso;
  await pruneSnapshots();
  return nowIso;
}

async function pruneSnapshots() {
  if (!db) return;
  const keys = (await dbKeys()).filter(k => String(k).startsWith('snapshot:')).sort().reverse();
  for (const key of keys.slice(MAX_SNAPSHOTS)) await dbDelete(key);
}

async function getSnapshots() {
  if (!db) return [];
  const keys = (await dbKeys()).filter(k => String(k).startsWith('snapshot:')).sort().reverse();
  const values = [];
  for (const key of keys.slice(0, MAX_SNAPSHOTS)) {
    try {
      const item = await dbGet(key);
      if (item?.state) values.push({ key, ...item });
    } catch {}
  }
  return values;
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function toMonthKey(date) { return toDateKey(date).slice(0,7); }
function parseDateKey(key) {
  const [y,m,d] = key.split('-').map(Number);
  return new Date(y, m-1, d, 12, 0, 0, 0);
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate()+days); return d; }
function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const mondayOffset = (d.getDay()+6)%7;
  d.setDate(d.getDate()-mondayOffset);
  return d;
}
function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1, 12); }
function addMonths(date, amount) { return new Date(date.getFullYear(), date.getMonth()+amount, 1, 12); }
function sameDay(a, b) { return toDateKey(a) === toDateKey(b); }
function sameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
function monthLabel(date) { return `${date.getFullYear()}年${date.getMonth()+1}月`; }
function dateFullLabel(date) { return `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`; }
function displayDateShort(date) { return `${date.getMonth()+1}/${date.getDate()}`; }
function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function getRecord(dateKey) {
  return { ...defaultRecord(), ...(state.records[dateKey] || {}) };
}
function getOrCreateRecord(dateKey) {
  if (!state.records[dateKey]) state.records[dateKey] = defaultRecord();
  return state.records[dateKey];
}
function getGoals(monthKey) {
  return { goal1: '', goal2: '', updatedAt: null, ...(state.monthGoals[monthKey] || {}) };
}
function ensureGoals(monthKey) {
  if (!state.monthGoals[monthKey]) state.monthGoals[monthKey] = { goal1:'', goal2:'', updatedAt:null };
  return state.monthGoals[monthKey];
}
function hasRecordContent(record) {
  if (!record) return false;
  return ['amActivity','amMood','pmActivity','pmMood','reflection','goal1Result','goal2Result'].some(k => String(record[k] ?? '').trim() !== '');
}
function averageMood(record) {
  const vals = [record?.amMood, record?.pmMood]
    .filter(v => String(v ?? '').trim() !== '')
    .map(Number)
    .filter(Number.isFinite);
  return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : null;
}


function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-showing');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-showing'), 2800);
}

function navigate(view) {
  currentView = view;
  $$('.view').forEach(el => el.classList.toggle('is-visible', el.id === `view-${view}`));
  $$('.nav-btn').forEach(btn => btn.classList.toggle('is-active', btn.dataset.nav === view));
  renderView(view);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function renderView(view) {
  if (view === 'week') renderWeek();
  if (view === 'calendar') renderCalendar();
  if (view === 'list') renderList();
  if (view === 'settings') renderSettings();
}

function cloneDailyFields(dateKey) {
  const frag = $('#dailyFieldsTemplate').content.cloneNode(true);
  const root = $('.daily-fields', frag);
  hydrateDailyFields(root, dateKey);
  bindDailyFields(root, dateKey);
  return frag;
}

function hydrateDailyFields(root, dateKey) {
  const record = getRecord(dateKey);
  for (const el of $$('[data-field]', root)) {
    const field = el.dataset.field;
    if (field === 'amMoodNumber') el.value = record.amMood;
    else if (field === 'pmMoodNumber') el.value = record.pmMood;
    else if (field === 'amMood' || field === 'pmMood') el.value = record[field] === '' ? 50 : record[field];
    else el.value = record[field] ?? '';
  }
  const goals = getGoals(dateKey.slice(0,7));
  const g1 = $('[data-goal-label="1"]', root);
  const g2 = $('[data-goal-label="2"]', root);
  if (g1) g1.textContent = `① ${goals.goal1 ? goals.goal1 : '目標1の結果'}`;
  if (g2) g2.textContent = `② ${goals.goal2 ? goals.goal2 : '目標2の結果'}`;
}

function bindDailyFields(root, dateKey) {
  const rangePairs = [
    { range: $('[data-field="amMood"]', root), number: $('[data-field="amMoodNumber"]', root), field: 'amMood' },
    { range: $('[data-field="pmMood"]', root), number: $('[data-field="pmMoodNumber"]', root), field: 'pmMood' }
  ];

  for (const {range, number, field} of rangePairs) {
    range.addEventListener('input', () => {
      number.value = range.value;
      updateRecordField(dateKey, field, range.value);
    });
    number.addEventListener('input', () => {
      const raw = number.value;
      if (raw === '') {
        updateRecordField(dateKey, field, '');
        return;
      }
      const clamped = Math.max(0, Math.min(100, Number(raw)));
      range.value = Number.isFinite(clamped) ? clamped : 50;
      updateRecordField(dateKey, field, Number.isFinite(clamped) ? String(clamped) : '');
    });
  }

  for (const el of $$('[data-field]', root)) {
    const field = el.dataset.field;
    if (['amMood','pmMood','amMoodNumber','pmMoodNumber'].includes(field)) continue;
    el.addEventListener('input', () => updateRecordField(dateKey, field, el.value));
  }
}

function updateRecordField(dateKey, field, value) {
  const rec = getOrCreateRecord(dateKey);
  rec[field] = value;
  rec.updatedAt = new Date().toISOString();
  if (!hasRecordContent(rec)) delete state.records[dateKey];
  scheduleSave();
  if (currentView === 'calendar') refreshCalendarCell(dateKey);
}

function renderWeek() {
  const start = startOfWeek(currentWeekDate);
  currentWeekDate = start;
  const end = addDays(start, 6);
  $('#weekLabel').textContent = `${displayDateShort(start)} 〜 ${displayDateShort(end)}`;

  const mid = addDays(start, 3);
  const monthKey = toMonthKey(mid);
  const goals = getGoals(monthKey);
  $('#weekGoalMonth').textContent = `${monthLabel(mid)}の目標`;
  $('#weekGoal1').textContent = goals.goal1 || '未設定';
  $('#weekGoal2').textContent = goals.goal2 || '未設定';
  $('#crossMonthNote').hidden = toMonthKey(start) === toMonthKey(end);

  const grid = $('#weekGrid');
  grid.innerHTML = '';
  const today = new Date();
  for (let i=0; i<7; i++) {
    const date = addDays(start, i);
    const key = toDateKey(date);
    const card = document.createElement('article');
    card.className = `day-card${sameDay(date,today) ? ' is-today' : ''}`;
    card.dataset.date = key;
    card.innerHTML = `<div class="day-card-head"><div><span class="day-date">${date.getMonth()+1}/${date.getDate()}</span> <span class="day-weekday">（${WEEKDAYS[date.getDay()]}）</span></div>${sameDay(date,today) ? '<span class="today-badge">今日</span>' : ''}</div><div class="day-wave" aria-hidden="true"></div>`;
    card.appendChild(cloneDailyFields(key));
    grid.appendChild(card);
  }
}

function renderCalendar() {
  $('#monthLabel').textContent = monthLabel(currentCalendarMonth);
  const monthKey = toMonthKey(currentCalendarMonth);
  const goals = getGoals(monthKey);
  $('#monthGoal1').value = goals.goal1;
  $('#monthGoal2').value = goals.goal2;

  const selectedDate = parseDateKey(selectedCalendarDate);
  if (!sameMonth(selectedDate, currentCalendarMonth)) selectedCalendarDate = toDateKey(currentCalendarMonth);

  const first = startOfMonth(currentCalendarMonth);
  const firstMondayOffset = (first.getDay()+6)%7;
  const gridStart = addDays(first, -firstMondayOffset);
  const grid = $('#calendarGrid');
  grid.innerHTML = '';
  for (let i=0; i<42; i++) {
    const date = addDays(gridStart, i);
    grid.appendChild(buildCalendarCell(date));
  }
  renderCalendarDayPanel();
}

function buildCalendarCell(date) {
  const key = toDateKey(date);
  const rec = state.records[key];
  const has = hasRecordContent(rec);
  const mood = averageMood(rec);
  const summary = rec?.reflection || rec?.pmActivity || rec?.amActivity || rec?.goal1Result || rec?.goal2Result || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'calendar-cell';
  if (!sameMonth(date,currentCalendarMonth)) btn.classList.add('is-other-month');
  if (key === selectedCalendarDate) btn.classList.add('is-selected');
  if (sameDay(date,new Date())) btn.classList.add('is-today');
  btn.dataset.date = key;
  btn.setAttribute('aria-label', `${dateFullLabel(date)}${has ? '、記録あり' : ''}`);
  btn.innerHTML = `<span class="calendar-number">${date.getDate()}</span>${has ? '<span class="record-dot" aria-hidden="true"></span>' : ''}<span class="calendar-summary">${htmlEscape(summary).replace(/\n/g,' ')}</span>${mood !== null ? `<span class="mood-chip"><span class="mood-prefix">気分 </span>${mood}</span>` : ''}`;
  btn.addEventListener('click', () => {
    selectedCalendarDate = key;
    if (!sameMonth(date, currentCalendarMonth)) currentCalendarMonth = startOfMonth(date);
    renderCalendar();
    if (window.matchMedia('(max-width: 720px)').matches) {
      requestAnimationFrame(() => $('#calendarDayPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  });
  return btn;
}

function refreshCalendarCell(dateKey) {
  const old = $(`.calendar-cell[data-date="${dateKey}"]`);
  if (!old) return;
  const date = parseDateKey(dateKey);
  const next = buildCalendarCell(date);
  old.replaceWith(next);
}

function renderCalendarDayPanel() {
  const panel = $('#calendarDayPanel');
  const date = parseDateKey(selectedCalendarDate);
  panel.innerHTML = `<div class="editor-head"><p>SELECTED DAY</p><h2>${dateFullLabel(date)}</h2></div>`;
  panel.appendChild(cloneDailyFields(selectedCalendarDate));
}

function updateSelectedPanelGoalLabels() {
  if (currentView !== 'calendar') return;
  const panel = $('#calendarDayPanel');
  if (!panel) return;
  const goals = getGoals(selectedCalendarDate.slice(0,7));
  const g1 = $('[data-goal-label="1"]', panel);
  const g2 = $('[data-goal-label="2"]', panel);
  if (g1) g1.textContent = `① ${goals.goal1 || '目標1の結果'}`;
  if (g2) g2.textContent = `② ${goals.goal2 || '目標2の結果'}`;
}

function updateMonthGoal(field, value) {
  const monthKey = toMonthKey(currentCalendarMonth);
  const goals = ensureGoals(monthKey);
  goals[field] = value;
  goals.updatedAt = new Date().toISOString();
  if (!goals.goal1 && !goals.goal2) delete state.monthGoals[monthKey];
  scheduleSave();
  updateSelectedPanelGoalLabels();
}

function availableMonths() {
  const keys = new Set(Object.keys(state.records).map(k=>k.slice(0,7)));
  Object.keys(state.monthGoals).forEach(k=>keys.add(k));
  keys.add(toMonthKey(new Date()));
  return [...keys].sort().reverse();
}

function renderList() {
  const select = $('#listMonthFilter');
  const prior = select.value || 'all';
  select.innerHTML = '<option value="all">すべて</option>' + availableMonths().map(k => {
    const [y,m] = k.split('-').map(Number);
    return `<option value="${k}">${y}年${m}月</option>`;
  }).join('');
  if ([...select.options].some(o=>o.value===prior)) select.value = prior;
  renderRecordListItems();
}

function renderRecordListItems() {
  const month = $('#listMonthFilter').value || 'all';
  const query = ($('#listSearch').value || '').trim().toLowerCase();
  let entries = Object.entries(state.records).filter(([,rec])=>hasRecordContent(rec));
  entries.sort((a,b)=>b[0].localeCompare(a[0]));
  if (month !== 'all') entries = entries.filter(([key])=>key.startsWith(month));
  if (query) entries = entries.filter(([key,rec]) => {
    const goals = getGoals(key.slice(0,7));
    return [key,rec.amActivity,rec.pmActivity,rec.reflection,rec.goal1Result,rec.goal2Result,goals.goal1,goals.goal2].join(' ').toLowerCase().includes(query);
  });

  const list = $('#recordList');
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state"><strong>該当する記録はまだありません</strong>週記録またはカレンダーから入力すると、ここに表示されます。</div>';
    return;
  }
  list.innerHTML = entries.map(([key,rec]) => {
    const date = parseDateKey(key);
    const goals = getGoals(key.slice(0,7));
    const am = [rec.amActivity, rec.amMood !== '' ? `気分 ${rec.amMood}` : ''].filter(Boolean).join(' / ');
    const pm = [rec.pmActivity, rec.pmMood !== '' ? `気分 ${rec.pmMood}` : ''].filter(Boolean).join(' / ');
    const results = [goals.goal1 ? `① ${goals.goal1}\n→ ${rec.goal1Result || '—'}` : (rec.goal1Result ? `① ${rec.goal1Result}` : ''), goals.goal2 ? `② ${goals.goal2}\n→ ${rec.goal2Result || '—'}` : (rec.goal2Result ? `② ${rec.goal2Result}` : '')].filter(Boolean).join('\n');
    return `<article class="record-item"><div class="record-date"><strong>${date.getMonth()+1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}）</strong><span>${date.getFullYear()}年</span></div><div class="record-section"><strong>AM / PM</strong><p>${htmlEscape(am || '—')}\n${htmlEscape(pm || '—')}</p></div><div class="record-section"><strong>1日のふりかえり</strong><p>${htmlEscape(rec.reflection || '—')}</p></div><div class="record-section"><strong>目標の結果</strong><p>${htmlEscape(results || '—')}</p></div><button type="button" class="open-day-btn" data-open-date="${key}">この日を開く</button></article>`;
  }).join('');
  $$('[data-open-date]', list).forEach(btn => btn.addEventListener('click', () => openCalendarDate(btn.dataset.openDate)));
}

function openCalendarDate(key) {
  selectedCalendarDate = key;
  currentCalendarMonth = startOfMonth(parseDateKey(key));
  navigate('calendar');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

async function updateStorageUi() {
  const primary = $('#primaryStorageStatus');
  if (!primary) return;
  primary.textContent = primaryStorageOkay ? 'IndexedDB：正常' : 'IndexedDB：利用不可';
  $('#shadowStorageStatus').textContent = shadowStorageOkay ? 'localStorage：正常' : 'localStorage：利用不可';
  $('#lastSavedStatus').textContent = formatDateTime(state?.meta?.updatedAt);
  let summary = '端末内へ2重保存しています。';
  if (!(primaryStorageOkay && shadowStorageOkay)) summary = '保存経路の一部が利用できません。バックアップ出力をおすすめします。';
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      summary += ` 使用量 ${formatBytes(est.usage)} / 上限目安 ${formatBytes(est.quota)}。`;
    } catch {}
  }
  if (navigator.storage?.persisted) {
    try { summary += (await navigator.storage.persisted()) ? ' 永続ストレージ：許可済み。' : ' 永続ストレージ：未許可。'; } catch {}
  }
  $('#storageSummary').textContent = summary;
  $('#lastBackupText').textContent = `バックアップ出力履歴：${state?.meta?.lastBackupAt ? formatDateTime(state.meta.lastBackupAt) : 'まだありません'}`;
}

async function renderSettings() {
  await updateStorageUi();
  const list = $('#snapshotList');
  if (!db) {
    list.innerHTML = '<div class="empty-state">このブラウザでは端末内復元ポイントを利用できません。</div>';
    return;
  }
  let snapshots = [];
  try { snapshots = await getSnapshots(); } catch {}
  if (!snapshots.length) {
    list.innerHTML = '<div class="empty-state">復元ポイントはまだありません。</div>';
    return;
  }
  list.innerHTML = snapshots.map(s => `<div class="snapshot-item"><span>${htmlEscape(s.reason || '保存')}・${formatDateTime(s.createdAt)}</span><button type="button" data-restore-snapshot="${htmlEscape(s.key)}">復元</button></div>`).join('');
  $$('[data-restore-snapshot]', list).forEach(btn => btn.addEventListener('click', () => restoreSnapshot(btn.dataset.restoreSnapshot)));
}

function downloadFile(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

async function exportBackup() {
  state.meta.lastBackupAt = new Date().toISOString();
  await flushSave();
  const payload = {
    format: 'komorebi-record-backup', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(), data: state
  };
  const date = toDateKey(new Date()).replaceAll('-','');
  downloadFile(`komorebi-backup-${date}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  updateStorageUi();
  showToast('バックアップを書き出しました');
}

function csvEscape(value) {
  const s = String(value ?? '').replaceAll('"','""');
  return `"${s}"`;
}
function exportCsv() {
  const header = ['日付','曜日','AMの活動','AM気分','PMの活動','PM気分','1日のふりかえり','目標1','目標1の結果','目標2','目標2の結果'];
  const rows = Object.entries(state.records).filter(([,r])=>hasRecordContent(r)).sort((a,b)=>a[0].localeCompare(b[0])).map(([key,r]) => {
    const d = parseDateKey(key); const g = getGoals(key.slice(0,7));
    return [key,WEEKDAYS[d.getDay()],r.amActivity,r.amMood,r.pmActivity,r.pmMood,r.reflection,g.goal1,r.goal1Result,g.goal2,r.goal2Result];
  });
  const csv = '\ufeff' + [header,...rows].map(row=>row.map(csvEscape).join(',')).join('\r\n');
  downloadFile(`komorebi-records-${toDateKey(new Date()).replaceAll('-','')}.csv`, csv, 'text/csv;charset=utf-8');
  showToast('CSVを書き出しました');
}

function parseBackupObject(obj) {
  const candidate = obj?.format === 'komorebi-record-backup' ? obj.data : obj;
  if (!isValidState(candidate)) throw new Error('このアプリのバックアップ形式として認識できません。');
  return normalizeState(candidate);
}

function mergeStates(current, incoming) {
  const merged = normalizeState(current);
  merged.records = { ...merged.records, ...deepClone(incoming.records) };
  merged.monthGoals = { ...merged.monthGoals, ...deepClone(incoming.monthGoals) };
  merged.settings = { ...merged.settings, ...deepClone(incoming.settings || {}) };
  merged.meta.createdAt = current.meta?.createdAt || incoming.meta?.createdAt || new Date().toISOString();
  merged.meta.updatedAt = new Date().toISOString();
  return merged;
}

async function importBackupFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = parseBackupObject(JSON.parse(text));
    const mode = $('#importMode').value;
    if (mode === 'replace' && !confirm('現在の記録をバックアップ内容で置き換えます。続けますか？')) return;
    if (db) {
      try { await createSnapshotInternal('読込前'); } catch {}
    }
    state = mode === 'replace' ? incoming : mergeStates(state, incoming);
    state.meta.updatedAt = new Date().toISOString();
    await flushSave();
    renderView(currentView);
    showToast(mode === 'replace' ? 'バックアップで置き換えました' : 'バックアップを追加・更新しました');
  } catch (err) {
    console.error(err);
    alert(`読み込みに失敗しました。\n${err.message || err}`);
  } finally {
    $('#importBackup').value = '';
  }
}

async function restoreSnapshot(key) {
  if (!confirm('この復元ポイントの内容に戻します。現在の状態も復元前ポイントとして保存します。続けますか？')) return;
  try {
    // Read the requested snapshot first. Creating the pre-restore point can prune the oldest generation.
    const snap = await dbGet(key);
    if (!snap?.state || !isValidState(snap.state)) throw new Error('復元ポイントが壊れています。');
    const restoreState = normalizeState(snap.state);
    await createSnapshotInternal('復元前');
    state = restoreState;
    state.meta.updatedAt = new Date().toISOString();
    await flushSave();
    renderSettings();
    showToast('復元ポイントから戻しました');
  } catch (err) {
    alert(`復元に失敗しました。\n${err.message || err}`);
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    showToast('このブラウザは永続ストレージ要求に対応していません');
    return;
  }
  try {
    const granted = await navigator.storage.persist();
    await updateStorageUi();
    showToast(granted ? '永続ストレージが許可されました' : '今回は許可されませんでした。外部バックアップも併用してください');
  } catch {
    showToast('永続ストレージを依頼できませんでした');
  }
}

async function resetAllData() {
  if (!confirm('すべての記録と月間目標を削除します。\nこの操作の直前に端末内復元ポイントを作成します。続けますか？')) return;
  if (db) {
    try { await createSnapshotInternal('初期化前'); } catch {}
  }
  state = defaultState();
  await flushSave();
  currentWeekDate = startOfWeek(new Date());
  currentCalendarMonth = startOfMonth(new Date());
  selectedCalendarDate = toDateKey(new Date());
  renderView(currentView);
  showToast('記録を初期化しました');
}

function bindStaticEvents() {
  $$('[data-nav]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.nav)));
  $('#prevWeek').addEventListener('click', () => { currentWeekDate = addDays(currentWeekDate,-7); renderWeek(); });
  $('#nextWeek').addEventListener('click', () => { currentWeekDate = addDays(currentWeekDate,7); renderWeek(); });
  $('#thisWeek').addEventListener('click', () => { currentWeekDate = startOfWeek(new Date()); renderWeek(); });
  $('#weekLabel').addEventListener('click', () => { currentWeekDate = startOfWeek(new Date()); renderWeek(); });
  $('#editGoalsFromWeek').addEventListener('click', () => {
    const mid = addDays(startOfWeek(currentWeekDate),3);
    currentCalendarMonth = startOfMonth(mid); selectedCalendarDate = toDateKey(mid); navigate('calendar');
  });

  $('#prevMonth').addEventListener('click', () => { currentCalendarMonth = addMonths(currentCalendarMonth,-1); selectedCalendarDate = toDateKey(currentCalendarMonth); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { currentCalendarMonth = addMonths(currentCalendarMonth,1); selectedCalendarDate = toDateKey(currentCalendarMonth); renderCalendar(); });
  $('#thisMonth').addEventListener('click', () => { currentCalendarMonth = startOfMonth(new Date()); selectedCalendarDate = toDateKey(new Date()); renderCalendar(); });
  $('#monthLabel').addEventListener('click', () => { currentCalendarMonth = startOfMonth(new Date()); selectedCalendarDate = toDateKey(new Date()); renderCalendar(); });
  $('#monthGoal1').addEventListener('input', e => updateMonthGoal('goal1', e.target.value));
  $('#monthGoal2').addEventListener('input', e => updateMonthGoal('goal2', e.target.value));

  $('#listMonthFilter').addEventListener('change', renderRecordListItems);
  $('#listSearch').addEventListener('input', renderRecordListItems);
  $('#exportBackup').addEventListener('click', exportBackup);
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#importBackup').addEventListener('change', e => importBackupFile(e.target.files?.[0]));
  $('#requestPersistentStorage').addEventListener('click', requestPersistentStorage);
  $('#createSnapshot').addEventListener('click', async () => {
    try { await createSnapshotInternal('手動'); await flushSave(); await renderSettings(); showToast('復元ポイントを作成しました'); }
    catch { showToast('復元ポイントを作成できませんでした'); }
  });
  $('#resetData').addEventListener('click', resetAllData);

  window.addEventListener('beforeunload', () => {
    // Synchronous mirror gives the last keystrokes an additional chance to survive a quick tab close.
    if (state) { state.meta.updatedAt = new Date().toISOString(); writeShadow(state); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state) flushSave(); });
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (err) { console.warn('Service worker registration failed', err); }
  }
}

async function init() {
  await loadState();
  bindStaticEvents();
  renderCalendar();
  updateStorageUi();
  registerServiceWorker();
  if (primaryStorageOkay && shadowStorageOkay) setSaveIndicator('saved', '保存済み（2重保存）');
  else if (primaryStorageOkay || shadowStorageOkay) setSaveIndicator('saved', '保存済み（予備経路）');
  else setSaveIndicator('error', '保存領域を利用できません');
}

document.addEventListener('DOMContentLoaded', init);

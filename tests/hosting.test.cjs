const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const base = 'https://yu-zora.com/tools/life_diary';
const workerPromise = import(pathToFileURL(path.join(root, 'worker/index.mjs')));

test('Canonical app URL adds the trailing slash and preserves query parameters', async () => {
  const {default:worker} = await workerPromise;
  const response = await worker.fetch(new Request(base + '?updated=1'), {});
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), base + '/?updated=1');
});

test('App requests resolve only inside the mounted asset directory', async () => {
  const {default:worker} = await workerPromise;
  const received = [];
  const env = {ASSETS:{fetch(request){received.push(new URL(request.url));return new Response('asset');}}};
  await worker.fetch(new Request(base + '/'), env);
  await worker.fetch(new Request(base + '/sw.js?v=7'), env);
  assert.equal(received[0].pathname, '/tools/life_diary/index.html');
  assert.equal(received[1].pathname, '/tools/life_diary/sw.js');
  assert.equal(received[1].search, '?v=7');
  assert.equal((await worker.fetch(new Request(base + '-other/'), env)).status, 404);
  assert.equal((await worker.fetch(new Request(base + '/', {method:'POST'}), env)).status, 405);
  assert.equal(received.length, 2);
});

test('Deployment includes the complete offline shell without repository or test files', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], {cwd:root});
  const destination = path.join(root, 'dist/tools/life_diary');
  const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const assets = source.match(/const ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g);
  for (const [,asset] of assets) {
    const relative = asset === './' ? 'index.html' : asset.split('?')[0];
    const file = path.join(destination, relative);
    assert(fs.statSync(file).isFile(), asset);
    assert.equal(fs.readFileSync(file).compare(fs.readFileSync(path.join(root, relative))), 0);
  }
  assert(fs.existsSync(path.join(destination, 'update.html')));
  for (const privateFile of ['.git', '.env', 'node_modules', 'tests', 'README.md', 'worker', 'wrangler.jsonc', 'package.json']) {
    assert(!fs.existsSync(path.join(destination, privateFile)), privateFile);
  }
  assert.match(fs.readFileSync(path.join(destination, 'index.html'), 'utf8'), /name="google-drive-client-id" content=""/);
});

test('Hosting owns only the requested URL and retains the canonical shared error policy', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
  assert.deepEqual(config.routes.map(route => route.pattern), ['yu-zora.com/tools/life_diary', 'yu-zora.com/tools/life_diary/*']);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'worker/shared-404/source.json'), 'utf8'));
  const policy = fs.readFileSync(path.join(root, 'worker/shared-404/response.mjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(manifest.sha256, createHash('sha256').update(policy).digest('hex'));
  assert.equal(manifest.originalEntry, 'worker/index.mjs');
});

const CACHE_NAME = 'komorebi-record-v5';
const CACHE_PREFIX = 'komorebi-record-';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.json', './favicon.png',
  './icons/Icon-192.png', './icons/Icon-512.png', './icons/Icon-maskable-192.png', './icons/Icon-maskable-512.png'
];

function assetUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function fetchFreshAssets() {
  return Promise.all(ASSETS.map(async path => {
    const url = assetUrl(path);
    const response = await fetch(url, { cache: 'reload' });
    if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
    return [url, response];
  }));
}

async function replaceAppCache() {
  // Fetch everything first. If the network fails, keep the existing offline cache intact.
  const freshAssets = await fetchFreshAssets();
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX)).map(key => caches.delete(key)));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(freshAssets.map(([url, response]) => cache.put(url, response)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const freshAssets = await fetchFreshAssets();
    await Promise.all(freshAssets.map(([url, response]) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'REFRESH_APP_CACHE') return;
  event.waitUntil((async () => {
    try {
      await replaceAppCache();
      event.ports?.[0]?.postMessage({ ok: true, cacheName: CACHE_NAME });
    } catch (err) {
      event.ports?.[0]?.postMessage({ ok: false, message: err?.message || String(err) });
      throw err;
    }
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response && response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(assetUrl('./index.html')))));
});

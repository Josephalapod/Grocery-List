const CACHE_NAME = 'grocery-list-v18';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,300&family=Instrument+Serif&display=swap'
];

// Install: cache core assets, bypassing the HTTP cache so we always store the freshest files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        ASSETS.map((url) =>
          // {cache: 'reload'} forces a fresh network fetch, ignoring the browser HTTP cache.
          // This prevents caching a stale index.html during an update.
          fetch(new Request(url, { cache: 'reload' }))
            .then((resp) => { if (resp.ok) return cache.put(url, resp); })
            .catch(() => {})
        )
      );
    })
  );
  // Don't auto-skip — wait for the user to tap "Update" so they aren't interrupted mid-task
});

// Listen for the skip-waiting message from the page (user tapped "Update")
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Activate: clean old caches and take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // Network-only for API calls and CORS proxies (recipe fetching)
  if (url.includes('api.anthropic.com') ||
      url.includes('r.jina.ai') ||
      url.includes('allorigins.win') ||
      url.includes('corsproxy.io') ||
      url.includes('codetabs.com') ||
      url.includes('proxy.cors.sh') ||
      url.includes('thingproxy.freeboard.io')) {
    event.respondWith(fetch(req));
    return;
  }

  // Network-FIRST for the HTML document so updates apply immediately when online.
  // Falls back to cache when offline (e.g. shopping in a store with no signal).
  const isDocument = req.mode === 'navigate' ||
                     req.destination === 'document' ||
                     url.endsWith('/') ||
                     url.endsWith('index.html');

  if (isDocument) {
    event.respondWith(
      fetch(new Request(req, { cache: 'reload' }))
        .then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
          }
          return resp;
        })
        .catch(() => caches.match('./index.html').then((c) => c || caches.match('./')))
    );
    return;
  }

  // Cache-first for other static assets (icons, fonts)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => undefined);
    })
  );
});

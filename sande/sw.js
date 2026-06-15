/* Service worker for the S&E 2025 Map PWA.
   Bump CACHE_VERSION whenever the app shell changes to force an update. */
const CACHE_VERSION = 'sande-map-v1';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const TILE_CACHE = CACHE_VERSION + '-tiles';

/* App shell: caching these lets the map open with no network. */
const SHELL_ASSETS = [
  './sande2025map.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isTile = (url) => /\.tile\.openstreetmap\.org\//.test(url);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  /* Map tiles: serve from cache when available, otherwise fetch and stash a
     copy so already-viewed areas keep working offline. */
  if (isTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req).then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  /* App shell + everything else: cache-first, falling back to the network and
     caching successful same-origin/CDN responses for next time. */
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        /* Offline navigation fallback: hand back the cached map page. */
        if (req.mode === 'navigate') return caches.match('./sande2025map.html');
      });
    })
  );
});

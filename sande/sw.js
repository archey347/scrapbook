/* Service worker for the S&E 2025 Map PWA.
   - Precaches the app shell so the map loads offline.
   - Runtime-caches Leaflet (CDN) and OpenStreetMap tiles you've already
     viewed, so previously-seen areas keep working without a connection. */

const VERSION = 'v1';
const SHELL = 'se-map-shell-' + VERSION;
const RUNTIME = 'se-map-runtime-' + VERSION;
const MAX_TILES = 400;

const SHELL_ASSETS = [
  './sande2025map.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

// Resilient precache: one failure (e.g. CDN unreachable) shouldn't abort install.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(
      SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isTile(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
}
function isCdn(url) {
  return url.hostname === 'cdnjs.cloudflare.com';
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App page: network-first so updates land, fall back to cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('./sande2025map.html', fresh.clone());
        return fresh;
      } catch (e) {
        return (await caches.match('./sande2025map.html')) || Response.error();
      }
    })());
    return;
  }

  // Map tiles + CDN libs: cache-first, populate runtime cache on the way.
  if (isTile(url) || isCdn(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const resp = await fetch(req);
        const cache = await caches.open(RUNTIME);
        cache.put(req, resp.clone());
        if (isTile(url)) event.waitUntil(trimCache(RUNTIME, MAX_TILES));
        return resp;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // Same-origin assets: cache-first with background refresh.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then((resp) => {
        caches.open(SHELL).then((c) => c.put(req, resp.clone()));
        return resp;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});

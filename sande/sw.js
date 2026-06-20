/* Service worker for the S&E 2025 Map PWA.
   - Precaches the app shell so the map loads offline.
   - Runtime-caches Leaflet (CDN) and OpenStreetMap tiles you've already
     viewed, so previously-seen areas keep working without a connection.
   - On request from the page ("Download offline map"), bulk-prefetches every
     tile covering the event area into a dedicated cache that survives app
     updates and is never evicted by the incidental-view LRU. */

const VERSION = 'v2';
const SHELL = 'se-map-shell-' + VERSION;
const RUNTIME = 'se-map-runtime-' + VERSION;
// Explicitly downloaded tiles. Unversioned so a saved offline map isn't wiped
// by an app update, and excluded from the LRU trim below.
const OFFLINE = 'se-map-offline';
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
      keys.filter((k) => k !== SHELL && k !== RUNTIME && k !== OFFLINE).map((k) => caches.delete(k))
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

/* ---- Bulk offline prefetch -------------------------------------------------
   The page computes the list of tile URLs covering the event area and asks us
   to download them. We fetch them (gently, a few at a time) into the OFFLINE
   cache and report progress back so the page can show a percentage. Tiles
   already present are counted without re-fetching, so a re-run is cheap. */

function post(client, data) { if (client) client.postMessage(data); }

async function prefetchTiles(urls, client) {
  const cache = await caches.open(OFFLINE);
  const total = urls.length;
  let done = 0, stored = 0, failed = 0, next = 0;
  const CONCURRENCY = 4; // be polite to OSM's tile servers

  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        if (await cache.match(url)) {
          stored++;
        } else {
          // no-cors → opaque response; fine to cache and serve back to <img>.
          const resp = await fetch(url, { mode: 'no-cors', cache: 'no-cache' });
          await cache.put(url, resp);
          stored++;
        }
      } catch (e) {
        failed++;
      }
      done++;
      if (done % 5 === 0 || done === total) {
        post(client, { type: 'prefetch-progress', done, total, stored, failed });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker)
  );
  post(client, { type: 'prefetch-done', total, stored, failed });
}

async function clearOffline(client) {
  await caches.delete(OFFLINE);
  post(client, { type: 'offline-cleared' });
}

async function reportOffline(client) {
  const cache = await caches.open(OFFLINE);
  const keys = await cache.keys();
  post(client, { type: 'offline-count', count: keys.length });
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'prefetch-tiles') {
    event.waitUntil(prefetchTiles(msg.urls || [], event.source));
  } else if (msg.type === 'offline-clear') {
    event.waitUntil(clearOffline(event.source));
  } else if (msg.type === 'offline-count') {
    event.waitUntil(reportOffline(event.source));
  }
});

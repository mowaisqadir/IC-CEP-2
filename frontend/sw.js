// frontend/sw.js
// FieldSync Service Worker — cache strategy + background sync support.
//
// Cache strategies:
//   Navigation requests  → Network-first, fallback to cached index.html
//   Static assets        → Cache-first, background update (SWR)
//   /api/*               → Never cached — always network-only
//   Dexie CDN            → Precached on install, served from cache

'use strict';

// ─── Version ──────────────────────────────────────────────────────────────────
// Bump CACHE_VERSION to force a full cache refresh on next deploy.
const CACHE_VERSION = 'v9';
const CACHE_STATIC = `fieldsync-static-${CACHE_VERSION}`;

// ─── App shell to precache (managed by tools/build_precache.py) ──────────────
// <PRECACHE_START>
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/api.js',
  '/js/app.js',
  '/js/auth.js',
  '/js/db.js',
  '/js/gps.js',
  '/js/hlc.js',
  '/js/media.js',
  '/js/merge.js',
  '/js/repo.js',
  '/js/router.js',
  '/js/schemas.js',
  '/js/sync.js',
  '/js/ui/components.js',
  '/js/ui/conflicts.js',
  '/js/ui/login.js',
  '/js/ui/projects.js',
  '/js/ui/recordForm.js',
  '/js/ui/records.js',
  '/js/ui/settings.js',
  '/js/ui/tracks.js',
  '/js/utils.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  'https://cdn.jsdelivr.net/npm/dexie@4/dist/dexie.min.js',
];
// <PRECACHE_END>

// ─── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_STATIC);

      // Precache everything; fail install loudly if any resource can't be cached.
      const results = await Promise.allSettled(
        APP_SHELL.map(async (url) => {
          const isCdn = url.startsWith('http');
          const req = isCdn
            ? new Request(url, { mode: 'cors', credentials: 'omit' })
            : new Request(url, { cache: 'reload' });

          let res;
          try {
            res = await fetch(req);
          } catch (err) {
            throw new Error(`[SW] Network error caching ${url}: ${err.message}`);
          }

          if (!res.ok) {
            throw new Error(`[SW] HTTP ${res.status} caching ${url}`);
          }

          await cache.put(req, res);
        })
      );

      // Log any failures and abort install if any asset failed
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        failures.forEach((f, idx) => console.error(`[SW] Install failure:`, f.reason));
        throw failures[0].reason;
      }

      console.log(`[SW] Install complete — cache ${CACHE_STATIC} (${APP_SHELL.length} assets)`);
    })()
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete every cache that isn't the current version
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('fieldsync-') && k !== CACHE_STATIC)
          .map((k) => {
            console.log(`[SW] Deleting old cache: ${k}`);
            return caches.delete(k);
          })
      );

      // Immediately take control of all open clients
      await self.clients.claim();
      console.log(`[SW] Activated — now controlling clients`);
    })()
  );
});

// ─── FETCH ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 1. Ignore non-GET requests entirely
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1b. Ignore non-HTTP(S) schemes (e.g. chrome-extension://)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 2. Never intercept API calls — always go straight to the network
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // 3. Navigation requests (HTML pages) → Network-first, SPA fallback
  if (request.mode === 'navigate') {
    event.respondWith(_networkFirstNavigation(request));
    return;
  }

  // 4. All other GET requests (JS, CSS, images, CDN) → Cache-first + SWR
  event.respondWith(_cacheFirstWithRevalidation(request));
});

// ─── Strategy: Network-first navigation ───────────────────────────────────────
async function _networkFirstNavigation(request) {
  try {
    const networkRes = await fetch(request);
    if (networkRes.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, networkRes.clone());
    }
    return networkRes;
  } catch {
    // Offline — return the cached shell
    const cached = await caches.match('/index.html', { cacheName: CACHE_STATIC });
    if (cached) return cached;
    // If even the shell isn't cached, return a bare offline page
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h1>🌿 FieldSync</h1>
        <p>You're offline and the app shell hasn't loaded yet.</p>
        <p>Please connect to the internet once to cache the app.</p>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// ─── Strategy: Cache-first with stale-while-revalidate ────────────────────────
async function _cacheFirstWithRevalidation(request) {
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return fetch(request);
  }

  const cache = await caches.open(CACHE_STATIC);
  const cached = await cache.match(request);

  // Kick off a background refresh regardless of cache hit
  const networkFetch = fetch(request).then((res) => {
    if (res.ok && res.type !== 'opaque') {
      cache.put(request, res.clone());
    }
    return res;
  }).catch(() => null);  // silently ignore network errors during background update

  // Return cached immediately if available; otherwise wait for network
  if (cached) return cached;
  const networkRes = await networkFetch;
  if (networkRes) return networkRes;

  return new Response('Offline — resource not cached.', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ─── MESSAGE ──────────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── BACKGROUND SYNC (progressive enhancement) ───────────────────────────────
// When the browser fires a background sync event (after connectivity is
// restored), post a message to all open clients so sync.js can run a cycle.
// This is an optional PE — if the API is unsupported the app still syncs via
// the online event and 30-second interval.
self.addEventListener('sync', (event) => {
  if (event.tag === 'fieldsync-sync') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: false }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'BACKGROUND_SYNC' });
        }
      })
    );
  }
});

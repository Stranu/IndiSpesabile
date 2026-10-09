/* Spesa service worker (design §16)
 * Network-first for app code, cache-first for static assets + esm.sh.
 * The PRECACHE list is enumerated by name against the §2 file list.
 * Maintenance: adding/renaming/removing any js/** module requires updating
 * both the §2 import graph and this PRECACHE array AND bumping CACHE_NAME.
 */

const CACHE_NAME = 'spesa-cache-v1';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/supabase.js',
  './js/sync.js',
  './js/router.js',
  './js/ui.js',
  './js/units.js',
  './js/views/spesa.js',
  './js/views/dispensa.js',
  './js/views/desideri.js',
  './js/views/prodotti.js',
  './js/views/auth.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
    // NOTE: no self.skipWaiting() here — waits for the page SKIP_WAITING message.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isEsmSh(url) {
  return url.origin === 'https://esm.sh';
}

function isStaticAsset(url) {
  // Same-origin icons + manifest are cache-first static assets.
  if (url.origin === self.location.origin) {
    return (
      url.pathname.endsWith('.png') ||
      url.pathname.endsWith('.webmanifest')
    );
  }
  return false;
}

function isAppCode(request, url) {
  if (request.mode === 'navigate') return true;
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.html')
  );
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Navigation fallback to the cached shell when offline.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  try {
    // Lazy-cache on miss. esm.sh responses are cross-origin; if caching one
    // fails (CORS/opaque constraints), fall through and just return it.
    cache.put(request, response.clone());
  } catch (err) {
    /* opaque/CORS caching failure — acceptable, serve from network */
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Cache-first: same-origin icons/manifest + any esm.sh URL (incl. transitive imports).
  if (isStaticAsset(url) || isEsmSh(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Network-first: navigation requests + same-origin .js/.css/.html.
  if (isAppCode(request, url)) {
    event.respondWith(networkFirst(request));
    return;
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

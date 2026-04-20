// Art Map service worker.
// Turns the site into a fully offline-capable PWA: the app shell and all
// downloaded data are precached at install time; artwork images are cached
// on demand as the user navigates them.
//
// Bump the VERSION string below any time you want to force browsers to
// fetch a fresh copy of everything — useful after a deploy where
// index.html / app.js / styles.css change in ways that shouldn't be
// mixed with a stale cached version.

const VERSION = 'artmap-v1-2026-04-20';

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './favicon.svg',
  './favicon-192.png',
  './favicon-512.png',
  './manifest.webmanifest',
  './data/seed.json',
  './data/images.json',
  './data/secondary-images.json',
  'https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== VERSION).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Cache-first with network fallback; successful same-origin GETs for
  // images and data files are cached opportunistically so subsequent visits
  // (and offline sessions) find them there.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp && resp.ok && (req.url.includes('/img/') || req.url.includes('/data/'))) {
          const clone = resp.clone();
          caches.open(VERSION).then(cache => cache.put(req, clone));
        }
        return resp;
      }).catch(() => {
        // Offline + uncached: fall back to the app shell for navigation
        // requests, otherwise a plain 504.
        if (req.destination === 'document') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline and not cached' });
      });
    })
  );
});

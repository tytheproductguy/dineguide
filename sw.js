/* Cache the shell so the app opens with no signal. Scans obviously need the
   network, but the UI, fonts, and saved menus stay available offline, which is
   the difference between a usable travel app and a blank screen on a plane.

   Strategy matters here. App code is served network-first: a cache-first rule
   pinned the app to whatever shipped in the first deploy, so updates never
   arrived however hard the page was refreshed. Fonts and images are cache-first,
   since they only ever change alongside a code change. */

const VERSION = 'dg-v7';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'assets/logo-icon.png',
  'assets/onboard-hero.jpg',
  'assets/paper-texture.jpg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'fonts/CormorantGaramond-Medium.woff2',
  'fonts/CormorantGaramond-SemiBold.woff2',
  'fonts/Archivo-Regular.woff2',
  'fonts/Archivo-Medium.woff2',
  'fonts/Archivo-SemiBold.woff2',
];

/** Code, which must stay current, vs assets, which can be served from cache. */
const isAppCode = (url) =>
  /\.(?:html|css|js|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // Individually, so one missing file cannot fail the whole install.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Lets the page force a waiting worker to take over immediately.
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch the API: responses are per-request and must not be cached.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate' || isAppCode(url)) {
    // Network first, falling back to cache when offline.
    e.respondWith(
      fetch(request)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return r;
        })
        .catch(() => caches.match(request).then(
          (hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : undefined)
        ))
    );
    return;
  }

  // Fonts and images: cache first, they are stable between deploys.
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((r) => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(request, copy));
      }
      return r;
    }))
  );
});

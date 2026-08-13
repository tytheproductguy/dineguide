/* Cache the shell so the app opens with no signal. Scans obviously need the
   network, but the UI, fonts, and saved menus stay available offline, which is
   the difference between a usable travel app and a blank screen on a plane. */

const VERSION = 'dg-v1';
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

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch the API: responses are per-request and must not be cached.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a deploy is picked up, cache as the fallback.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((r) => {
          caches.open(VERSION).then((c) => c.put('index.html', r.clone()));
          return r;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Everything else: cache first, since the shell is versioned by VERSION.
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((r) => {
      if (r.ok) caches.open(VERSION).then((c) => c.put(request, r.clone()));
      return r;
    }).catch(() => hit))
  );
});

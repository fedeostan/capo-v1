// Capo app-shell service worker. Scope is deliberately modest: precache the
// offline fallback + icons so the installed app opens gracefully without
// network, but NEVER serve cached page/data responses as if they were live —
// the dashboard and chat always need the network.
const CACHE = 'capo-shell-v1';
const PRECACHE = ['/offline', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode === 'navigate') {
    // Pages are network-only; the cached /offline shell is the failure path.
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin && PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
  }
});

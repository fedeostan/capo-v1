// Capo app-shell service worker. Scope is deliberately modest: precache the
// offline fallback + icons so the installed app opens gracefully without
// network, but NEVER serve cached page/data responses as if they were live —
// the dashboard and chat always need the network.
const CACHE = 'capo-shell-v2';
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

// ── Web Push (PRD 7) ───────────────────────────────────────────────────────
// Everything below runs with the app CLOSED. There is no React, no catalog and
// no session here — every string the manager reads arrives inside the payload,
// already rendered in their own language by the dispatcher.

self.addEventListener('push', (event) => {
  // A malformed or bodyless push must still show something. We subscribe with
  // userVisibleOnly, so a push that shows no notification makes the browser
  // display its own "this site was updated in the background" instead — which
  // is worse than a bare app name, and looks like a bug in Capo.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Capo';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    // The notification row id. A redelivery of the same row replaces the
    // alert rather than stacking a second copy of it.
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url: typeof data.url === 'string' ? data.url : '/notificacoes' },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notificacoes';
  event.waitUntil(
    (async () => {
      // Focus a window that is already open rather than opening a second copy
      // of a standalone PWA — two Capos on screen is disorienting and loses
      // whatever the manager was in the middle of.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Browsers rotate this address on their own occasionally. Best effort only:
  // this can fire with nobody logged in, in which case the POST is rejected
  // and nothing here can fix it. The real safety net is the /perfil card
  // re-registering on every app open, which is idempotent.
  event.waitUntil(
    (async () => {
      const applicationServerKey =
        event.oldSubscription && event.oldSubscription.options
          ? event.oldSubscription.options.applicationServerKey
          : null;
      if (!applicationServerKey) return;
      try {
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        await fetch('/api/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch {
        // Nothing useful to do here — the next app open re-registers.
      }
    })(),
  );
});

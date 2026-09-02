/* sw.js — service worker for the Daffodils Buddies Fund.

   Three jobs:
   1. Make the app installable (needed so iPhone can show notifications at all).
   2. Receive Web Push and draw the new-message notification. This is the only path that
      works when the app is closed — the page's own poll is frozen by then, especially on
      iOS, so anything the page draws itself can never reach a locked phone.
   3. Handle notification clicks by focusing the already-open tab.

   Caching is deliberately network-first: every screen reads live CSV data, so a stale
   cache would be worse than a slow load. The cache is purely an offline fallback. */
const CACHE = 'daf-shell-v6';
const SHELL = [
  '/index.html',
  '/css/styles.css',
  '/js/api.js',
  '/js/icons.js',
  '/js/nav.js',
  '/js/dashboard.js',
  '/js/rules.js',
  '/js/community.js',
  '/js/chatlive.js',
  '/js/auth.js',
  '/js/admin.js',
  '/js/app.js',
  '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API or uploaded media — always talk to the server.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ---- push ---------------------------------------------------------------

/** Is the app open and on screen right now? Then a banner is just noise. */
async function appIsVisible() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.some((c) => c.visibilityState === 'visible');
}

// iOS keeps score: a push that draws no notification counts against us, and after a few
// WebKit quietly drops the subscription — which would break notifications all over again.
// So on iPhone/iPad we always show, and only other platforms get the quiet-while-open nicety.
const IS_IOS = /iP(hone|ad|od)/.test(self.navigator.userAgent);

/** A new message, post, or memory arrived while the app was closed (or in the background). */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* malformed — fall back to defaults */ }

  const who = data.member || 'Buddies';
  const mentioned = data.mentioned || (Array.isArray(data.mentions) && data.mentions.length > 0);
  const title = data.title || (mentioned ? `${who} mentioned you 💬` : `${who} · Daffodils Buddies`);
  const tag = data.tag || (data.type === 'post' ? 'daf-post' : data.type === 'photo' ? 'daf-photo' : 'daf-chat');

  e.waitUntil((async () => {
    if (!IS_IOS && await appIsVisible()) return;
    await self.registration.showNotification(title, {
      body: data.body || 'New update',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag,
      renotify: true,
      data: {
        url: data.url || '/index.html',
        type: data.type || 'chat',
      },
    });
  })());
});

/**
 * Push services expire endpoints periodically. When that happens we get one chance to
 * swap in the new subscription — otherwise notifications quietly stop forever.
 * We have no access to the login token here, so the server identifies us by the endpoint
 * being replaced.
 */
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const oldEndpoint = e.oldSubscription && e.oldSubscription.endpoint;
      const { key } = await fetch('/api/push/key').then((r) => r.json());
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub, oldEndpoint }),
      });
    } catch { /* the page will re-subscribe on its next launch */ }
  })());
});

// Tapping a notification focuses the open app and opens the appropriate tab.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  const type = (e.notification.data && e.notification.data.type) || 'chat';
  const msgType = type === 'post' ? 'open-posts' : 'open-chat';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) { client.postMessage({ type: msgType }); return client.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});

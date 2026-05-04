// THRYVE service worker — push notifications.
// Registered from src/lib/push.js once the user grants notification
// permission. Listens for `push` events and shows a notification; on
// `notificationclick`, focuses the app tab (or opens a new one) at
// the URL the server included in the payload.

self.addEventListener('install', () => {
  // Skip the standard waiting state — we want push delivery active
  // immediately on first registration.
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { title: 'THRYVE', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'THRYVE';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-badge.png',
    tag:  payload.tag,
    data: { url: payload.url || '/', ...(payload.data || {}) },
    requireInteraction: !!payload.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If THRYVE is already open, focus that tab and navigate it.
    for (const client of all) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin) {
        client.focus();
        if ('navigate' in client) return client.navigate(target);
        return;
      }
    }
    // Otherwise open a new window.
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

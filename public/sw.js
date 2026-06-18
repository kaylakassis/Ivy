// Ivy OS service worker - offline app shell + push notifications.
//
// Two responsibilities:
//   1. Offline: precache the app shell on install and serve cached
//      assets so an installed PWA opens (and previously-visited routes
//      work) without a network. Navigations are network-first with a
//      cached-shell / offline-page fallback; content-hashed assets are
//      cache-first; /api/* is never cached (always live data).
//   2. Push: show notifications and focus/route the app on click.
//
// Registered on every load from src/lib/pwa.js, and re-used by the push
// subscription flow in src/lib/push.js - same /sw.js, same scope.

const VERSION = 'v2';
const SHELL_CACHE = `ivy-shell-${VERSION}`;
const RUNTIME_CACHE = `ivy-runtime-${VERSION}`;
const OFFLINE_URL = '/offline.html';

// Static files that always exist - precached so the PWA boots offline.
const SHELL_ASSETS = [OFFLINE_URL, '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg'];

self.addEventListener('install', (event) => {
  // Do NOT skipWaiting here: an update stays "waiting" until the open
  // page tells us to take over (SKIP_WAITING below), so we never swap
  // assets under a running tab. A true first install (no existing
  // controller) activates on its own.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS).catch(() => {});
    // Cache the SPA shell separately so one bad response can't void the
    // whole batch; it's the offline fallback for any client route.
    await cache.add('/').catch(() => {});
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('ivy-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

// Page → SW: apply a waiting update immediately (user clicked "Reload").
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Never cache API / dynamic data - always go to the network.
  if (sameOrigin && url.pathname.startsWith('/api/')) return;

  // App navigations: network-first, falling back to the cached shell and
  // then the offline page. Keeps the SPA fresh online while still opening
  // offline (BrowserRouter boots the right route from window.location).
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && url.pathname === '/') {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/', fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/')) || (await cache.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  // Google Fonts (CSS + woff2): stale-while-revalidate so type renders
  // offline after the first visit.
  if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Same-origin static assets (content-hashed JS/CSS, icons, images):
  // serve from cache, refresh in the background.
  if (sameOrigin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // Anything else (third-party) goes straight to the network.
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// ── Push notifications ──
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { title: 'Ivy OS', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'Ivy OS';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.svg',
    badge: payload.badge || '/icon.svg',
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
    // If Ivy OS is already open, focus that tab and navigate it.
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

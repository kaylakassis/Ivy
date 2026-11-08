// Home-screen quick actions (long-press the app icon) and ivy:// links.
//
// iOS hands the app a URL (ios/App/App/SceneDelegate.swift forwards each
// shortcut as ivy://action/<name>; the "Open Ivy" button on the payment
// return page uses ivy://finance). This maps that URL onto the in-app
// route that opens the right screen with its drawer already open, using
// the same query params the dashboard's own quick-action tiles use.
// Pure, no imports: tested in tests/quick-actions.test.mjs.

export const QUICK_ACTIONS = {
  'new-booking': '/calendar?newBooking=new',
  'new-client':  '/clients?add=1',
  'new-invoice': '/finance?newInvoice=new',
  'ask-ivy':     '/ivy',
};

// Plain ivy://<screen> links (no action) may open these screens.
const SCREENS = new Set(['dashboard', 'calendar', 'clients', 'finance', 'messages', 'ivy', 'website', 'documents', 'marketing', 'account', 'more']);

// The UIApplicationShortcutItemType values in Info.plist, in case iOS ever
// hands us the type instead of the URL.
export const SHORTCUT_TYPE_PREFIX = 'ai.joinivy.app.';

export function routeForQuickAction(name) {
  return QUICK_ACTIONS[String(name || '').toLowerCase()] || null;
}

// ivy://action/new-booking → '/calendar?newBooking=new'
// ivy://finance            → '/finance'
// anything else            → null (ignored; never navigates on junk)
export function routeForAppUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'ivy:') return null;
  // Both ivy://action/x and ivy:action/x parse differently across engines;
  // normalise to "host/path" segments.
  const segs = `${u.hostname || ''}${u.pathname || ''}`.split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!segs.length) return null;
  if (segs[0] === 'action') return segs.length === 2 ? routeForQuickAction(segs[1]) : null;
  if (segs.length === 1 && SCREENS.has(segs[0])) return `/${segs[0]}`;
  return null;
}

export function routeForShortcutType(type) {
  if (!type || typeof type !== 'string' || !type.startsWith(SHORTCUT_TYPE_PREFIX)) return null;
  return routeForQuickAction(type.slice(SHORTCUT_TYPE_PREFIX.length));
}

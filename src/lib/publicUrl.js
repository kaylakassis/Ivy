// Canonical public origin for share-able URLs (booking links, public
// site URLs, invoice payment links shown to operators, etc.).
//
// Why not just use `window.location.origin`?
//   The app runs on three URLs in practice:
//     - https://getivyos.com            (production, marketed)
//     - https://ivy-pink.vercel.app  (default Vercel deploy URL - same project)
//     - http://localhost:5173           (local dev)
//   Operators using the second one would otherwise see and copy
//   "ivy-pink.vercel.app/book/handle" from the wizard / share
//   drawer, then paste a stale URL into Instagram. We want every
//   share-able URL to read getivyos.com regardless of which host
//   they're currently loaded on, except in dev where localhost is
//   what actually works.
const CANONICAL = 'https://getivyos.com';

export function publicOrigin() {
  if (typeof window === 'undefined') return CANONICAL;
  const o = window.location.origin || '';
  if (o.startsWith('http://localhost') || o.startsWith('http://127.')) return o;
  return CANONICAL;
}

// Hosts the Ivy OS app itself runs on, as opposed to a business owner's
// own custom domain. Used to decide whether the current page is the
// platform (render the normal app) or a customer's connected domain
// (render only that owner's published site, resolved by host).
export function isPlatformHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return true; // SSR / unknown -> treat as platform (safe default)
  return (
    h === 'getivyos.com' ||
    h === 'www.getivyos.com' ||
    h === 'localhost' ||
    h.startsWith('127.') ||
    h.endsWith('.vercel.app')
  );
}

// The URL a business owner should share for their site:
//   • their VERIFIED custom domain when connected (https://theirdomain.com)
//   • otherwise the platform URL (https://getivyos.com/site/<handle>)
// `site` is the website-builder state object (has customDomain,
// domainStatus, handle).
export function siteShareUrl(site) {
  if (!site) return null;
  const verified = site.customDomain && site.domainStatus === 'verified';
  if (verified) {
    const clean = String(site.customDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${clean}`;
  }
  return site.handle ? `${publicOrigin()}/site/${site.handle}` : null;
}

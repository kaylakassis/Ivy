// Canonical public origin for share-able URLs (booking links, public
// site URLs, invoice payment links shown to operators, etc.).
//
// Why not just use `window.location.origin`?
//   The app runs on three URLs in practice:
//     - https://getivyos.com            (production, marketed)
//     - https://ivy-pink.vercel.app  (default Vercel deploy URL — same project)
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

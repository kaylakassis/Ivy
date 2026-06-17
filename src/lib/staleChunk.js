// Stale-chunk recovery for Vite's content-hashed dynamic-import filenames.
//
// React Router's `lazy(() => import('./X.jsx'))` produces a hashed chunk
// (e.g. X-CG8f-E6-.js). When Vercel redeploys, that hash changes. Tabs
// still holding the OLD index.html try to fetch the OLD URL, get 404,
// and React's error boundary catches "Failed to fetch dynamically
// imported module".
//
// Standard fix: hard-reload once. The fresh index.html has the new
// asset URLs and everything continues. Gated by sessionStorage so a
// genuinely-broken deploy can't reload-loop forever.

const CHUNK_RELOAD_KEY = '__ivy_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 10_000;

export function isStaleChunkError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('error loading dynamically imported module') ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

export function tryStaleChunkRecovery(err) {
  if (!isStaleChunkError(err)) return false;
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
    if (Date.now() - last < RELOAD_COOLDOWN_MS) {
      // Recent reload didn't help — let the error UI render so the
      // user sees actionable buttons instead of an infinite reload
      // loop.
      return false;
    }
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch { /* private mode — fall through and reload anyway */ }
  if (typeof window !== 'undefined') {
    // Hard reload so we bypass HTTP cache and pick up the fresh
    // index.html with the new asset hashes.
    window.location.reload();
  }
  return true;
}

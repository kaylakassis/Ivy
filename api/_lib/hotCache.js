// Hot-path in-memory cache for slow-changing reads (workspace settings,
// branding, calendar settings, etc.) that get hit on every page load.
//
// Why this exists: every /api/me hit reads workspace + subscription +
// branding from Postgres. That's fine at 1K users, ruinous at 1M when
// every browse session fires 5-10 of these reads/second. A real cache
// layer (Upstash Redis, Vercel KV) is the correct answer at scale; this
// is a stopgap that buys most of the relief without standing up a new
// service. When/if we add Redis, the same `getOrSet()` API can swap
// the backing store with no caller changes.
//
// Semantics:
//   • Per function-invocation memory. Vercel keeps a warm function
//     instance alive for several minutes between requests, so a real
//     cache-hit rate develops during any traffic burst.
//   • TTL'd so stale data ages out without manual invalidation. The
//     defaults are aggressive on purpose (seconds, not minutes) since
//     we lose the cache on cold start anyway.
//   • Bounded LRU eviction. A misconfigured cache that never evicts
//     would slowly grow as workspaces churn through a single function
//     instance; the LRU cap keeps memory predictable at ~CACHE_MAX * 1KB.
//   • `bypass()` and `invalidate(key)` for write paths that need to
//     burst-cache-bust after they update the underlying row.

const DEFAULT_TTL_MS = 30_000;   // 30s — short enough that a settings
                                  // change is visible in well under a
                                  // minute, long enough to absorb a
                                  // hot-path burst.
const CACHE_MAX      = 500;      // bounded LRU; ~500 * ~1KB = ~500KB
                                  // budget per function instance.

const _store = new Map();        // insertion-ordered, used as LRU
const _expiry = new Map();       // key → epoch ms when it goes stale

// Integration tests mutate the DB out-of-band between handler calls
// (e.g. promote a user to super_admin via direct SQL, then re-invoke an
// admin handler) — a pattern fundamentally incompatible with a TTL
// cache that has no knowledge of those writes. Production never does
// this: every state change goes through an endpoint that calls the
// matching invalidate*(). So in the test harness we bypass the cache
// entirely (set IVY_DISABLE_HOTCACHE=1 in tests/bootstrap.mjs) and let
// every read hit the DB fresh. The cache primitives themselves are
// still covered by tests/hot-cache.test.mjs, which clears this flag.
// Checked at call-time (not import-time) so a test can toggle it.
function bypassed() {
  return process.env.IVY_DISABLE_HOTCACHE === '1';
}

function evictIfNeeded() {
  while (_store.size > CACHE_MAX) {
    const oldestKey = _store.keys().next().value;
    if (oldestKey === undefined) break;
    _store.delete(oldestKey);
    _expiry.delete(oldestKey);
  }
}

// Pure read. Returns undefined on miss; you can't tell "cached null"
// apart from "missing" — by design, since the value-returning callers
// almost always wrap a row-or-null lookup and an absent row should
// re-check the DB rather than cache the absence indefinitely.
export function get(key) {
  if (bypassed()) return undefined;
  const exp = _expiry.get(key);
  if (exp === undefined) return undefined;
  if (Date.now() > exp) {
    _store.delete(key);
    _expiry.delete(key);
    return undefined;
  }
  // LRU touch: re-insert so this key moves to the end of insertion
  // order, making evictIfNeeded drop *colder* keys first.
  const v = _store.get(key);
  _store.delete(key);
  _store.set(key, v);
  return v;
}

export function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  _store.delete(key);   // re-insert at the end for LRU positioning
  _store.set(key, value);
  _expiry.set(key, Date.now() + ttlMs);
  evictIfNeeded();
  return value;
}

export function invalidate(key) {
  _store.delete(key);
  _expiry.delete(key);
}

// Cache-aside helper. Call site shape:
//
//   const branding = await getOrSet(`branding:${workspaceId}`, 60_000,
//     () => fetchBrandingFromDb(workspaceId));
//
// The loader fires at most once per (key, TTL window) per function
// instance. Concurrent in-flight requests for the same key share the
// same Promise so we don't herd N parallel DB hits during a cold burst.
const _inflight = new Map();
export async function getOrSet(key, ttlMs, loader) {
  // Bypass: run the loader fresh every time, no store, no in-flight
  // sharing. Keeps integration tests reading real DB state.
  if (bypassed()) return loader();
  const cached = get(key);
  if (cached !== undefined) return cached;
  const existing = _inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const v = await loader();
      // Don't cache undefined — caller should re-fetch. Cache `null`
      // explicitly so "row genuinely doesn't exist" can short-circuit.
      if (v !== undefined) set(key, v, ttlMs);
      return v;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// Test-only escape hatch. Production should never call this; it's here
// so the test harness can give each case a fresh cache without resetting
// the whole process.
export function _resetForTests() {
  _store.clear();
  _expiry.clear();
  _inflight.clear();
}

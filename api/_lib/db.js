// Database client - Neon serverless driver.
// Vercel's Postgres → Neon migration: same connection string, similar API.
// We pass `fullResults: true` so `sql\`...\`` returns `{ rows, rowCount, ... }`.
//
// Scaling notes (Phase S2 §2.4):
//   • DATABASE_URL should point at Neon's POOLER endpoint (the URL
//     with `-pooler` in the host) - transaction-mode pgBouncer in
//     front of the DB. Each fetch from the serverless driver still
//     opens a fresh HTTP request, but Neon's edge multiplexes them
//     across a small pool of actual DB connections. Without pooling,
//     a busy hour with 1K concurrent invocations exhausts the DB
//     connection limit (Neon defaults around 100); with pooling,
//     they share.
//   • `fetchConnectionCache = true` reuses the HTTPS connection
//     across calls inside the same function invocation - saves the
//     TLS handshake per query.
//   • `poolQueryViaFetch = true` routes every query through the
//     HTTPS endpoint (the alternative is a WebSocket pool, which
//     doesn't help on Vercel since functions don't keep state).
import { neon, neonConfig } from '@neondatabase/serverless';

// Set once at module load. Cheap; safe to set unconditionally even if
// the driver version doesn't recognize the flag (it's just ignored).
neonConfig.fetchConnectionCache = true;
neonConfig.poolQueryViaFetch    = true;

function connectionString() {
  // Vercel injects POSTGRES_URL when the legacy Vercel Postgres integration is in place.
  // The native Neon integration uses DATABASE_URL.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL (or POSTGRES_URL) is not set');
  return url;
}

let _sql;
function getSql() {
  if (_sql) return _sql;
  _sql = neon(connectionString(), { fullResults: true });
  return _sql;
}

// Tagged template proxy so callers can keep `await sql\`SELECT ...\``
// without forcing eager construction of the connection (helpful in cold imports).
export const sql = new Proxy(function () {}, {
  get(_t, prop) {
    const real = getSql();
    const v = real[prop];
    return typeof v === 'function' ? v.bind(real) : v;
  },
  apply(_t, _thisArg, args) {
    return getSql()(...args);
  },
});

// Is this error a CONNECTION-level failure (DB asleep/unreachable/over
// limits) rather than a query/constraint error? A suspended or
// scaled-to-zero Neon instance, a dropped socket, or a rotated/invalid
// connection string all surface here. We use this to tell "the database
// is down" apart from "this query is wrong" so the former can be retried
// (and answered with a friendly 503) instead of hard-500'd.
export function isConnectionError(err) {
  if (err?.dbUnavailable) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('error connecting to database') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('connection terminated') ||
    msg.includes('connection refused') ||
    msg.includes('could not connect') ||
    msg.includes('terminating connection') ||
    msg.includes('the endpoint has been disabled') || // Neon suspended
    msg.includes('compute time quota') ||             // Neon over-limit
    msg.includes('too many connections') ||
    msg.includes('timeout')
  );
}

// Warm the DB connection with a few QUICK retries. Resolves once a
// `SELECT 1` succeeds; throws a `dbUnavailable`-tagged error if the
// instance is still unreachable after the retries.
//
// Tuned SHORT for the request hot path (default ~1s total) so a
// cold/scaled-to-zero Neon instance gets a chance to wake without hanging
// the user. On an already-warm connection this is a single ~10ms round
// trip. A non-connection error (a genuine query failure) is re-thrown
// immediately - we only retry connectivity blips, never logic errors.
export async function warmupDb({ retries = 3, baseDelayMs = 150 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sql`SELECT 1`;
      return;
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err)) throw err;
      if (attempt < retries) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      }
    }
  }
  const e = new Error(`database unavailable: ${lastErr?.message || 'unknown error'}`);
  e.dbUnavailable = true;
  throw e;
}

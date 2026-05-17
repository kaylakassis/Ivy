// Database client — Neon serverless driver.
// Vercel's Postgres → Neon migration: same connection string, similar API.
// We pass `fullResults: true` so `sql\`...\`` returns `{ rows, rowCount, ... }`.
//
// Scaling notes (Phase S2 §2.4):
//   • DATABASE_URL should point at Neon's POOLER endpoint (the URL
//     with `-pooler` in the host) — transaction-mode pgBouncer in
//     front of the DB. Each fetch from the serverless driver still
//     opens a fresh HTTP request, but Neon's edge multiplexes them
//     across a small pool of actual DB connections. Without pooling,
//     a busy hour with 1K concurrent invocations exhausts the DB
//     connection limit (Neon defaults around 100); with pooling,
//     they share.
//   • `fetchConnectionCache = true` reuses the HTTPS connection
//     across calls inside the same function invocation — saves the
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

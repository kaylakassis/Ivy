// Database client — Neon serverless driver.
// Vercel's Postgres → Neon migration: same connection string, similar API.
// We pass `fullResults: true` so `sql\`...\`` returns `{ rows, rowCount, ... }`.
import { neon } from '@neondatabase/serverless';

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

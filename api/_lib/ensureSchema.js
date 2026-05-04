// Lazy schema bootstrap — applies SCHEMA_SQL once per process so a fresh
// deploy doesn't require anyone to manually hit /api/admin/migrate.
//
// Runs on the first authenticated request after a cold start. Every
// statement in schema.js is idempotent (CREATE TABLE IF NOT EXISTS,
// ADD COLUMN IF NOT EXISTS, UPDATE … WHERE column IS NULL), so re-runs
// are cheap and safe.
//
// Failures don't poison the process: we retry on the next request. Auth
// itself is decoupled — if migration fails, the user still sees an
// authenticated session, just with whatever stale schema the DB has.
//
// Manual /api/admin/migrate still works for one-off ops or when the
// auto-bootstrap is bypassed (cron jobs, webhooks).
import { sql } from './db.js';
import { SCHEMA_SQL } from './schema.js';

let applied = false;
let inFlight = null;

function splitStatements(sqlText) {
  return sqlText
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

export async function ensureSchemaApplied() {
  if (applied) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const statements = splitStatements(SCHEMA_SQL);
    for (const stmt of statements) {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(stmt);
    }
    applied = true;
  })();

  try {
    await inFlight;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bootstrap] schema bootstrap failed; will retry on next request:', err.message);
    // Leave applied=false so the next request retries. Don't rethrow —
    // the auth middleware will swallow this and the request continues
    // with whatever schema the DB currently has.
  } finally {
    inFlight = null;
  }
}

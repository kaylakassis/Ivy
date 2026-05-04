// Lazy schema bootstrap. Two-stage so cold-started functions don't pay the
// full ~80-statement migration cost every time:
//
//   1. PROBE — one cheap SELECT against a column we know got added in the
//      most-recent migration. If it succeeds, schema is current and we
//      mark the process as up-to-date. ~50ms.
//   2. FULL — only when the probe fails (i.e. the deploy added new
//      columns/tables). Runs every statement; idempotent (IF NOT EXISTS
//      everywhere) so it's safe to retry.
//
// Bump PROBE_QUERY whenever you ship a column that should be a "trigger
// migration on next request" boundary — it doubles as the marker that
// the latest schema landed.
//
// Errors are swallowed and logged: requireUser still returns the user
// even if migration fails, so the request can proceed against whatever
// schema the DB currently has.
import { sql } from './db.js';
import { SCHEMA_SQL } from './schema.js';

// One cheap SELECT to detect whether the latest schema is applied. Update
// this when a new schema delta ships so the next cold start triggers the
// full migration once.
const PROBE_QUERY = 'SELECT 1 FROM waitlist_entries LIMIT 1';

let applied = false;
let inFlight = null;

function splitStatements(sqlText) {
  return sqlText
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

async function runProbe() {
  await sql.query(PROBE_QUERY);
}

async function runFull() {
  const statements = splitStatements(SCHEMA_SQL);
  for (const stmt of statements) {
    // eslint-disable-next-line no-await-in-loop
    await sql.query(stmt);
  }
}

export async function ensureSchemaApplied() {
  if (applied) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      await runProbe();
      applied = true;
      return;
    } catch (probeErr) {
      // eslint-disable-next-line no-console
      console.warn('[bootstrap] probe failed, running full migration:', probeErr.message);
    }
    await runFull();
    applied = true;
  })();

  try {
    await inFlight;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bootstrap] schema bootstrap failed; will retry on next request:', err.message);
    // Leave applied=false so the next request retries.
  } finally {
    inFlight = null;
  }
}

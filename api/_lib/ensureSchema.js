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
// full migration once. We point at the most recently-added column rather
// than a long-lived table so adding new columns reliably triggers a
// re-migration without needing a manual /admin click.
const PROBE_QUERY = "SELECT domain_status FROM websites LIMIT 1";

let applied = false;
let inFlight = null;
// When runFull fails, we throw so the caller treats schema as not-yet-
// applied. But repeating the full migration on EVERY request (which
// touches ~80 statements + the network) is expensive when a statement
// is permanently broken. So we cool down — at most one runFull every
// COOLDOWN_MS. The probe still runs in between; if it starts passing
// we're back to fast-path.
const COOLDOWN_MS = 30_000;
let lastFullRunAt = 0;

// Splits a multi-statement SQL string on `;` boundaries. Strips line
// comments (--) BEFORE splitting so a `;` inside a comment can't shred
// a fragment off (and so the same `;` inside a comment can't make us
// ship a quote-orphaned chunk to the database). String-literal-aware:
// `;` inside a single-quoted string is preserved. Also dollar-quote
// aware: `;` inside a $tag$ ... $tag$ block (DO blocks etc.) is
// preserved verbatim regardless of nesting.
//
// Exported so api/admin/migrate.js uses the same splitter as the
// cold-start bootstrap — keeps the two paths from drifting apart.
export function splitStatements(sqlText) {
  // Step 1: strip line comments. We can do this naively at the line
  // level because schema.js doesn't use `--` inside literals.
  const noComments = sqlText
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  // Step 2: walk the text, tracking single-quoted strings AND
  // dollar-quoted blocks so an embedded `;` doesn't cut off the
  // statement (e.g. a CHECK constraint's allowed values, or the body
  // of a DO $tag$ ... END $tag$; block).
  const stmts = [];
  let buf = '';
  let inString = false;
  let dollarTag = null; // when inside $tag$...$tag$, this holds 'tag'
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];

    // Dollar-quote handling: once inside a $tag$ block, we look only
    // for the matching closing $tag$. Nothing else (quotes, comments,
    // semicolons) terminates a statement until we see the end tag.
    if (dollarTag !== null) {
      const closer = `$${dollarTag}$`;
      if (noComments.slice(i, i + closer.length) === closer) {
        buf += closer;
        i += closer.length - 1;
        dollarTag = null;
        continue;
      }
      buf += ch;
      continue;
    }

    // Detect the start of a dollar-quoted block when not in a string.
    // Tag is the [A-Za-z0-9_]* between two `$`s.
    if (!inString && ch === '$') {
      const rest = noComments.slice(i + 1);
      const m = rest.match(/^([A-Za-z0-9_]*)\$/);
      if (m) {
        dollarTag = m[1];
        buf += '$' + m[1] + '$';
        i += m[0].length;
        continue;
      }
    }

    if (ch === "'") {
      // Postgres '' is an escaped single quote inside a string.
      if (inString && noComments[i + 1] === "'") {
        buf += ch + noComments[++i];
        continue;
      }
      inString = !inString;
      buf += ch;
      continue;
    }
    if (ch === ';' && !inString) {
      const trimmed = buf.trim();
      if (trimmed) stmts.push(trimmed);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) stmts.push(tail);
  return stmts;
}

async function runProbe() {
  await sql.query(PROBE_QUERY);
}

// Multi-pass migration. The schema has forward references — e.g. an
// `ALTER TABLE bookings ADD COLUMN review_request_token_hash` lives ABOVE
// the CREATE TABLE bookings, because the historical authoring order
// mixed columns + tables. Rather than rewrite 1500 lines of SQL, we
// just run multiple passes: failed statements re-run after the rest
// have created their dependencies. Convergence usually takes 2 passes;
// MAX_PASSES caps to avoid infinite loops on a permanently-broken stmt.
const MAX_PASSES = 4;
async function runFull() {
  const allStatements = splitStatements(SCHEMA_SQL);
  let pending = allStatements.map((stmt, i) => ({ stmt, origIndex: i }));
  let pass = 0;
  let lastFailures = [];

  while (pending.length > 0 && pass < MAX_PASSES) {
    pass++;
    const failures = [];
    for (const { stmt, origIndex } of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sql.query(stmt);
      } catch (err) {
        failures.push({
          stmt, origIndex,
          message: err.message,
          preview: stmt.slice(0, 120),
        });
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[bootstrap] pass ${pass}: ${pending.length - failures.length}/${pending.length} succeeded, ${failures.length} pending`);
    if (failures.length === pending.length) {
      // Zero progress on this pass — the remaining statements are
      // permanently broken, not just out of order. Stop and report.
      break;
    }
    pending = failures.map((f) => ({ stmt: f.stmt, origIndex: f.origIndex }));
    lastFailures = failures;
  }

  if (pending.length > 0) {
    // Log the permanently-broken statements so we see them in Vercel logs.
    for (const f of lastFailures) {
      // eslint-disable-next-line no-console
      console.error(`[bootstrap] stmt #${f.origIndex + 1} failed permanently: ${f.message} | ${f.preview}`);
    }
    const err = new Error(`schema bootstrap left ${pending.length} permanently-failed statement(s) after ${pass} passes`);
    err.failures = lastFailures;
    throw err;
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
    // Cooldown: if we just ran a full migration in the last 30s and it
    // failed, don't immediately re-run. The probe will keep being
    // checked on each request, so when the broken statement is fixed
    // we'll catch up on the next probe success — but in the meantime
    // we avoid pegging the DB.
    const sinceLast = Date.now() - lastFullRunAt;
    if (sinceLast < COOLDOWN_MS && lastFullRunAt > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[bootstrap] skipping full migration (cooldown ${COOLDOWN_MS - sinceLast}ms remaining)`);
      return;
    }
    lastFullRunAt = Date.now();
    await runFull();
    applied = true;
  })();

  try {
    await inFlight;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bootstrap] schema bootstrap failed; will retry after cooldown:', err.message);
    // Leave applied=false so subsequent requests retry once the cooldown
    // elapses. Endpoints with critical columns (e.g. onboarding_state)
    // also self-heal at the statement level — see api/onboarding/state.js.
  } finally {
    inFlight = null;
  }
}

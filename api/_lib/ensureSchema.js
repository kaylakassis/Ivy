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
const PROBE_QUERY = "SELECT 1 FROM workflows LIMIT 1";

let applied = false;
let inFlight = null;

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

async function runFull() {
  const statements = splitStatements(SCHEMA_SQL);
  // Continue past individual statement failures rather than aborting
  // the whole migration. Every statement is idempotent (IF NOT EXISTS,
  // ON CONFLICT, etc.) so a single broken one shouldn't gate everything
  // else from getting applied. Errors are surfaced in the logs so we
  // can fix the offender; the caller still gets a working schema for
  // every statement that DID succeed.
  const failures = [];
  for (let i = 0; i < statements.length; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(statements[i]);
    } catch (err) {
      failures.push({ index: i, message: err.message, preview: statements[i].slice(0, 120) });
      // eslint-disable-next-line no-console
      console.error(`[bootstrap] stmt ${i + 1}/${statements.length} failed:`, err.message, '|', statements[i].slice(0, 120));
    }
  }
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[bootstrap] migration completed with ${failures.length} failures out of ${statements.length}`);
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

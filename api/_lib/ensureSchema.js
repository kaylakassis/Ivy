// Schema bootstrap.
//
// PRIMARY path is the deploy step: `scripts/migrate.mjs` (wired into
// vercel.json's buildCommand) runs the full migration ONCE per deploy,
// before the new functions go live. So in steady state the schema is
// already current by the time any request lands.
//
// This module is now the SAFETY NET for the request path — two-stage so
// cold-started functions don't pay the full ~80-statement migration cost:
//
//   1. PROBE — compares the set of statement hashes in the CURRENT
//      SCHEMA_SQL against the hashes recorded applied in the
//      `schema_migrations` table. If every current statement is already
//      recorded applied, the schema is current and we mark the process
//      up-to-date. After a successful deploy migration this ALWAYS
//      passes, so the expensive full path below never runs on a request.
//   2. FULL — only when the probe fails (a new/changed statement isn't
//      recorded yet, e.g. the deploy migration was skipped or a hotfix
//      added a column without redeploying). Runs every statement;
//      idempotent (IF NOT EXISTS everywhere) so it's safe to retry, then
//      records the applied hashes so the next probe fast-paths.
//
// This is self-maintaining: there is NO hand-edited sentinel to bump.
// Any change to SCHEMA_SQL (new table/column/constraint, or an edit to an
// existing statement) changes that statement's hash, which isn't in
// schema_migrations yet, so the next probe fails and the migration runs
// exactly once. (Previously a single hard-coded PROBE_QUERY had to be
// bumped by hand; forgetting to do so silently shipped un-migrated tables.)
//
// Errors are swallowed and logged: requireUser still returns the user
// even if migration fails, so the request can proceed against whatever
// schema the DB currently has.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { SCHEMA_SQL } from './schema.js';

// Stable per-statement fingerprint. MUST match api/admin/migrate.js so the
// deploy/request bootstrap and the admin endpoint share one ledger.
export function hashStmt(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

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
  // Schema is current iff every statement hash in the CURRENT SCHEMA_SQL
  // is recorded applied in schema_migrations. A missing table (brand-new
  // DB) throws on the SELECT → caught upstream as "not current" → full
  // migration runs and creates the table + records the hashes.
  const expected = splitStatements(SCHEMA_SQL).map(hashStmt);
  const { rows } = await sql`SELECT statement_hash FROM schema_migrations WHERE applied = TRUE`;
  const have = new Set(rows.map((r) => r.statement_hash));
  const missing = expected.filter((h) => !have.has(h));
  if (missing.length > 0) {
    throw new Error(`schema not current: ${missing.length}/${expected.length} statement(s) not yet applied`);
  }
}

// Best-effort: record the statements we just applied so the next probe
// fast-paths. Only called after a fully-successful pass (every statement
// ran), so we mark them all applied=TRUE in one batch upsert. Mirrors the
// ledger written by api/admin/migrate.js.
async function recordApplied(statements) {
  if (statements.length === 0) return;
  try {
    const valuesSql = statements
      .map((_, i) => `($${i * 2 + 1}, TRUE, $${i * 2 + 2})`)
      .join(', ');
    const params = [];
    for (const stmt of statements) {
      params.push(hashStmt(stmt), stmt.slice(0, 200));
    }
    await sql.query(
      `INSERT INTO schema_migrations (statement_hash, applied, statement_preview)
       VALUES ${valuesSql}
       ON CONFLICT (statement_hash) DO UPDATE SET
         applied         = TRUE,
         error_message   = NULL,
         last_attempt_at = NOW(),
         apply_count     = schema_migrations.apply_count + 1`,
      params,
    );
  } catch (err) {
    // Non-fatal: the migration itself succeeded. Worst case the next probe
    // can't fast-path and re-runs the (idempotent) full migration once.
    // eslint-disable-next-line no-console
    console.warn('[bootstrap] could not record schema_migrations ledger:', err.message);
  }
}

// Multi-pass migration. The schema has forward references — e.g. an
// `ALTER TABLE bookings ADD COLUMN review_request_token_hash` lives ABOVE
// the CREATE TABLE bookings, because the historical authoring order
// mixed columns + tables. Rather than rewrite 1500 lines of SQL, we
// just run multiple passes: failed statements re-run after the rest
// have created their dependencies. Convergence usually takes 2 passes;
// MAX_PASSES caps to avoid infinite loops on a permanently-broken stmt.
const MAX_PASSES = 4;

// Cross-instance migration mutex.
//
// Goal: across MANY concurrently cold-starting function instances (e.g.
// right after a deploy that adds a column), only ONE runs the full
// migration at a time. Without it, a thundering herd each fire ~80 DDL
// statements that take ACCESS EXCLUSIVE / SHARE UPDATE EXCLUSIVE locks
// and serialize/deadlock against each other and live traffic.
//
// We CANNOT use pg_advisory_lock here: the Neon HTTP driver opens a new
// connection per query, so a session-level advisory lock is released the
// instant its acquiring query returns — it wouldn't span the migration's
// subsequent statements. Instead we use a single-row claim with a TTL,
// which is atomic per-statement and therefore correct over independent
// HTTP connections. The TTL means a crashed migrator can't wedge the
// lock forever — after it lapses another instance reclaims.
const LOCK_TTL_SECONDS = 120;

async function tryAcquireMigrationLock() {
  // Create the lock table itself idempotently. It must not depend on the
  // migration it gates, so we create it inline. Concurrent CREATE TABLE
  // IF NOT EXISTS may race; treat any error as "couldn't lock" and fall
  // through to migrating unguarded (still correct, just unprotected).
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migration_lock (
      id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      locked_until TIMESTAMPTZ
    )
  `;
  await sql`INSERT INTO schema_migration_lock (id, locked_until) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING`;
  // Atomic claim: only succeeds if the lock is free or its TTL lapsed.
  const { rows } = await sql.query(
    `UPDATE schema_migration_lock
        SET locked_until = NOW() + INTERVAL '${LOCK_TTL_SECONDS} seconds'
      WHERE id = 1 AND (locked_until IS NULL OR locked_until < NOW())
      RETURNING id`,
  );
  return rows.length > 0;
}

async function releaseMigrationLock() {
  await sql`UPDATE schema_migration_lock SET locked_until = NULL WHERE id = 1`.catch(() => {});
}

async function runFull() {
  let haveLock = false;
  try {
    haveLock = await tryAcquireMigrationLock();
  } catch {
    // Lock machinery itself failed — migrate anyway. Correctness is
    // preserved (every statement is idempotent IF NOT EXISTS); we just
    // lose stampede protection for this one run.
    haveLock = true;
    try { await runFullLocked(); return true; } finally { /* no lock held */ }
  }
  if (!haveLock) {
    // Another instance holds the lock. Return false (not applied) so the
    // caller leaves applied=false and the next request re-probes, picking
    // up the winner's finished migration.
    // eslint-disable-next-line no-console
    console.warn('[bootstrap] migration already in progress on another instance; skipping');
    return false;
  }
  try {
    await runFullLocked();
    return true;
  } finally {
    await releaseMigrationLock();
  }
}

async function runFullLocked() {
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
    // Record this pass's failures BEFORE the zero-progress break so the
    // thrown error always carries them — otherwise a total failure (every
    // statement throwing, e.g. the DB is unreachable) would surface with
    // an EMPTY err.failures, hiding the cause.
    lastFailures = failures;
    if (failures.length === pending.length) {
      // Zero progress on this pass — the remaining statements either are
      // permanently broken (a real schema bug) OR the database is
      // unreachable (every statement throws a connection error). The
      // caller distinguishes the two via err.appliedCount.
      break;
    }
    pending = failures.map((f) => ({ stmt: f.stmt, origIndex: f.origIndex }));
  }

  if (pending.length > 0) {
    // Log the permanently-broken statements so we see them in Vercel logs.
    for (const f of lastFailures) {
      // eslint-disable-next-line no-console
      console.error(`[bootstrap] stmt #${f.origIndex + 1} failed permanently: ${f.message} | ${f.preview}`);
    }
    const err = new Error(`schema bootstrap left ${pending.length} permanently-failed statement(s) after ${pass} passes`);
    err.failures = lastFailures;
    err.totalCount = allStatements.length;
    // How many statements EVER applied across all passes. Zero means the
    // database was never usable (connectivity/auth) — NOT a broken schema.
    err.appliedCount = allStatements.length - pending.length;
    throw err;
  }

  // Full success: every statement ran. Record the ledger so the next
  // probe fast-paths instead of re-running the whole migration.
  await recordApplied(allStatements);
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
    // Only mark applied if we actually held the lock and migrated; if a
    // peer instance was migrating, leave applied=false so we re-probe.
    if (await runFull()) applied = true;
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

// One-shot migration for the DEPLOY step (scripts/migrate.mjs). Unlike
// ensureSchemaApplied this is meant to run alone in the build, so it
// bypasses the per-process `applied` cache and the request-path cooldown:
// it always probes, and runs the full migration if the probe fails. It
// THROWS on a permanently-failed statement so the build fails loudly
// rather than shipping a deploy against a half-migrated DB.
//
// runFull() takes the cross-instance lock; if a peer holds it (a rare
// overlap with a cold-start migrator on the still-live old deployment),
// we poll the probe until that peer finishes instead of skipping.
export async function runSchemaMigration() {
  try {
    await runProbe();
    // eslint-disable-next-line no-console
    console.log('[migrate] schema already current — nothing to do');
    return;
  } catch {
    // eslint-disable-next-line no-console
    console.log('[migrate] probe failed; applying full schema migration');
  }

  // runFull throws on a permanent statement failure (propagates → build
  // fails). Returns false only if another instance currently holds the
  // migration lock.
  if (await runFull()) {
    // eslint-disable-next-line no-console
    console.log('[migrate] schema migration complete');
    return;
  }

  // A peer is migrating — wait for it to finish by re-probing.
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2000));
    try {
      // eslint-disable-next-line no-await-in-loop
      await runProbe();
      // eslint-disable-next-line no-console
      console.log('[migrate] schema migration completed by a peer instance');
      return;
    } catch { /* still in progress */ }
  }
  throw new Error('migration lock held by a peer and schema never converged after 60s');
}

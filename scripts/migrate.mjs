// Deploy-step schema migration.
//
// Wired into vercel.json's buildCommand so the full migration runs ONCE
// per deploy, before the new functions go live — instead of lazily on the
// first request that cold-starts. Keeps the ~80-statement DDL pass off the
// hot path.
//
// This build-time pass is a PERFORMANCE OPTIMIZATION, not the source of
// truth: every serverless function also calls ensureSchemaApplied() on
// cold start, which runs the same idempotent migration against the
// RUNTIME database. So a build that can't reach a DB still ships a
// correct app — the schema just gets applied on the first request.
//
// Behavior:
//   • No DATABASE_URL/POSTGRES_URL     → skip + exit 0. Lets a frontend-only
//     build (local `npm run build`, CI without a DB) succeed.
//   • Migration succeeds               → exit 0.
//   • DB unreachable at BUILD time      → warn + exit 0. A preview/branch
//     deploy whose build environment can't reach the database (e.g. the
//     Preview env has no DATABASE_URL wired, or the connection is blocked
//     during the build) must NOT block the deploy — the runtime bootstrap
//     applies the schema on first request. We detect this as "zero
//     statements applied" (a connectivity failure makes EVERY statement
//     fail; the runner stops after one zero-progress pass).
//   • A data-backfill (INSERT/UPDATE/DELETE) statement fails → warn +
//     exit 0. These one-time data migrations are guarded + idempotent
//     (e.g. `... WHERE onboarded_at IS NULL`) but can choke on a single
//     malformed row in a populated database while passing on an empty one.
//     They do NOT change the schema STRUCTURE (every table/column still
//     exists), the app runs fine without the backfill, and the RUNTIME
//     ensureSchemaApplied() already swallows the same failure (it catches
//     and continues). So a data-statement failure must not block the
//     deploy — matching the runtime's own tolerance.
//   • A STRUCTURAL DDL statement fails (CREATE/ALTER/DROP/DO/INDEX) →
//     exit 1, which FAILS the build so a broken schema never ships. This
//     is a genuine bug: a table/column the app needs won't exist.
//
// Idempotent: safe to run on every deploy (every statement is IF NOT
// EXISTS / idempotent UPSERT).
//
// Manual run: `npm run migrate` (uses the same DATABASE_URL from env).

import { runSchemaMigration } from '../api/_lib/ensureSchema.js';

// A statement is "data" (vs "structural DDL") iff it's an INSERT/UPDATE/
// DELETE. Only structural DDL failures are allowed to fail the build —
// data backfills are non-fatal (see header).
const isDataStatement = (s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s || '');

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.warn('[migrate] DATABASE_URL not set — skipping deploy-step migration (frontend-only build).');
  process.exit(0);
}

// Secondary signal for error shapes that don't carry appliedCount (e.g.
// the runner throws before attributing failures, or a peer-lock timeout):
// does the message look like "couldn't reach the DB" vs "a statement is
// wrong"?
const CONN_ERROR = /\b(ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|connect(?:ion)?|fetch failed|terminat\w*|getaddrinfo|socket|SSL|TLS|authentication|password|too many connections|server closed|timeout|lock)\b/i;

try {
  await runSchemaMigration();
  process.exit(0);
} catch (err) {
  // PRIMARY signal: how many statements ever applied. The runner attaches
  // appliedCount — 0 means the database was never usable at build time
  // (connectivity/auth), which is INFRASTRUCTURE, not a broken schema. A
  // genuine DDL bug leaves SOME statements applied (appliedCount > 0).
  const appliedCount = typeof err.appliedCount === 'number' ? err.appliedCount : null;
  const dbUnreachable = appliedCount === 0
    || (appliedCount === null && CONN_ERROR.test(err.message || ''));

  if (dbUnreachable) {
    // Don't fail the deploy. The runtime ensureSchemaApplied() applies the
    // schema on the first request against the (correctly-wired) runtime
    // DATABASE_URL. This is expected for preview deploys whose BUILD env
    // has no database access.
    console.warn(
      '[migrate] database unreachable at build time — skipping the build-step '
      + 'migration; the schema will be applied at runtime on the first request '
      + '(ensureSchemaApplied). Detail: ' + err.message,
    );
    process.exit(0);
  }

  // Some statements applied, others permanently failed. Split them: a
  // STRUCTURAL DDL failure (a table/column the app needs won't exist) must
  // fail the build; a DATA-backfill (INSERT/UPDATE/DELETE) failure must NOT
  // — it can choke on one malformed row in a populated DB, doesn't change
  // the schema structure, and the runtime ensureSchemaApplied() tolerates
  // the same failure (catches + continues).
  const failures = Array.isArray(err.failures) ? err.failures : [];
  const structural = failures.filter((f) => !isDataStatement(f.stmt || f.preview));
  const dataOnly = failures.filter((f) => isDataStatement(f.stmt || f.preview));

  if (structural.length === 0 && failures.length > 0) {
    // Only data-backfill statements failed → schema structure is intact.
    console.warn(
      `[migrate] ${dataOnly.length} data-backfill statement(s) failed against the `
      + 'live database, but the schema STRUCTURE is fully applied — not failing the '
      + 'deploy (these one-time backfills are idempotent + retried at runtime). '
      + 'Failed backfills:',
    );
    for (const f of dataOnly) {
      console.warn(`  - stmt #${f.origIndex + 1}: ${f.message} | ${f.preview}`);
    }
    process.exit(0);
  }

  // A structural DDL statement permanently failed = a real broken-schema
  // bug. Fail the build so a broken schema never ships.
  console.error(`[migrate] FAILED — broken schema, failing the build (${appliedCount} statement(s) applied before the failure):`, err.message);
  for (const f of structural) {
    console.error(`  - stmt #${f.origIndex + 1}: ${f.message} | ${f.preview}`);
  }
  process.exit(1);
}

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
//   • A genuine broken-schema failure   → exit 1, which FAILS the build so
//     a broken schema never ships. This is the case where SOME statements
//     applied but one or more permanently fail (syntax/type/constraint
//     error) — a real bug, distinguishable from a connectivity blip
//     because partial progress was made.
//
// Idempotent: safe to run on every deploy (every statement is IF NOT
// EXISTS / idempotent UPSERT).
//
// Manual run: `npm run migrate` (uses the same DATABASE_URL from env).

import { runSchemaMigration } from '../api/_lib/ensureSchema.js';

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

  // Partial progress + a permanently-failed statement = a real broken-schema
  // bug. Fail the build so a broken schema never ships.
  console.error(`[migrate] FAILED — broken schema, failing the build (${appliedCount} statement(s) applied before the failure):`, err.message);
  const failures = Array.isArray(err.failures) ? err.failures : [];
  for (const f of failures) {
    console.error(`  - stmt #${f.origIndex + 1}: ${f.message} | ${f.preview}`);
  }
  process.exit(1);
}

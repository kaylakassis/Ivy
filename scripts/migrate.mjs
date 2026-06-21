// Deploy-step schema migration.
//
// Wired into vercel.json's buildCommand so the full migration runs ONCE
// per deploy, before the new functions go live - instead of lazily on the
// first request that cold-starts. Keeps the ~80-statement DDL pass off the
// hot path.
//
// Behavior:
//   • No DATABASE_URL/POSTGRES_URL  → skip + exit 0. Lets a frontend-only
//     build (local `npm run build`, CI without a DB) succeed. On Vercel
//     the DB env vars are present in the build environment, so the
//     migration runs for real.
//   • DB unreachable                → exit 1 with a CLEAR "database
//     unreachable" message (after a warmup retry to wake a suspended
//     Neon instance), NOT the misleading "N statements failed" report.
//   • Migration succeeds            → exit 0.
//   • A statement permanently fails → exit 1, which FAILS the build so a
//     broken schema never ships.
//
// Idempotent: safe to run on every deploy (every statement is IF NOT
// EXISTS / idempotent UPSERT). Runs for preview deploys too, against
// whatever DATABASE_URL that environment points at.
//
// Manual run: `npm run migrate` (uses the same DATABASE_URL from env).

import { runSchemaMigration } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.warn('[migrate] DATABASE_URL not set - skipping deploy-step migration (frontend-only build).');
  process.exit(0);
}

// Warm up the connection before attempting the migration. A serverless
// Postgres (Neon) can be SUSPENDED/scaled-to-zero or briefly unreachable
// at the instant the build runs; the first query then fails. Without this
// guard, EVERY migration statement fails on its own connection attempt and
// the build reports "489 permanently-failed statement(s)" - which looks
// like a schema bug but is really "the database is asleep/unreachable."
//
// A `SELECT 1` retried with exponential backoff wakes a suspended instance
// and distinguishes the two cases: if it never succeeds, the DB is
// genuinely unreachable and we fail with that exact diagnosis instead of a
// 489-statement red herring.
async function warmupConnection() {
  const delays = [2000, 4000, 8000, 16000]; // 4 retries, ~30s total
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await sql`SELECT 1`;
      if (attempt > 0) {
        console.log(`[migrate] database reachable after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}.`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) {
        const ms = delays[attempt];
        console.warn(`[migrate] database not reachable yet (${err.message}); retrying in ${ms / 1000}s ...`);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  }
  const e = new Error(
    `database unreachable after ${delays.length} retries: ${lastErr?.message || 'unknown error'}. ` +
    'Check that DATABASE_URL/POSTGRES_URL is set correctly in this environment and that the ' +
    'Postgres (Neon) instance is active and not over its limits.',
  );
  e.unreachable = true;
  throw e;
}

try {
  await warmupConnection();
  await runSchemaMigration();
  process.exit(0);
} catch (err) {
  if (err.unreachable) {
    console.error('[migrate] FAILED: database unreachable -', err.message);
    process.exit(1);
  }
  console.error('[migrate] FAILED:', err.message);
  if (Array.isArray(err.failures)) {
    for (const f of err.failures) {
      console.error(`  - stmt #${f.origIndex + 1}: ${f.message} | ${f.preview}`);
    }
  }
  process.exit(1);
}

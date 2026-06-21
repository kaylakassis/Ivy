// Deploy-step schema migration.
//
// Wired into vercel.json's buildCommand so the full migration runs ONCE
// per deploy, before the new functions go live - instead of lazily on the
// first request that cold-starts. Keeps the ~80-statement DDL pass off the
// hot path.
//
// THIS STEP NEVER FAILS THE BUILD. It is a deploy-time OPTIMIZATION
// (apply the schema once, off the request hot path), NOT the only line of
// defense: the request path runs the same migration lazily via
// ensureSchemaApplied() (api/_lib/ensureSchema.js) on the first cold
// request, and that path is idempotent + self-healing. So if the build
// can't migrate - most commonly because Vercel-managed Neon has
// auto-SUSPENDED and the first connection at build time hits a sleeping
// DB - we must NOT hard-fail the deploy. Doing so freezes production on
// the last successful build (stale site, missing new routes) for a
// transient condition that the runtime resolves on its own the moment
// the DB wakes. A frozen production is strictly worse than a deployed
// app that migrates on first request.
//
// Behavior:
//   • No DATABASE_URL/POSTGRES_URL  → skip + exit 0 (frontend-only build).
//   • DB asleep/unreachable at build → warmup retries to wake it; if it
//     stays down, log loudly and exit 0 anyway (runtime migration is the
//     backstop). Deploy proceeds.
//   • Migration runs → great, schema is current before traffic lands.
//   • Migration errors → log loudly and exit 0 (runtime backstop). A
//     genuinely broken DDL statement is caught earlier by `npm test`
//     (the full schema runs against Postgres in CI), so it shouldn't
//     reach here; if it does, the loud log + per-request runtime errors
//     surface it without bricking the entire site.
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
  // NON-FATAL by design (see header). We log loudly so the build log
  // shows what happened, but ALWAYS exit 0 so a sleeping/unreachable
  // Neon - or any migration hiccup - can't freeze production on a stale
  // deploy. The runtime ensureSchemaApplied() backstop applies the
  // schema on the first request once the DB is awake.
  if (err.unreachable) {
    console.warn('[migrate] DB unreachable at build time -', err.message);
    console.warn('[migrate] Proceeding with deploy; the runtime migration will apply the schema on first request once Neon wakes.');
  } else {
    console.warn('[migrate] migration did not complete at build time:', err.message);
    if (Array.isArray(err.failures)) {
      for (const f of err.failures) {
        console.warn(`  - stmt #${f.origIndex + 1}: ${f.message} | ${f.preview}`);
      }
    }
    console.warn('[migrate] Proceeding with deploy; the runtime migration backstop will retry on first request.');
  }
  process.exit(0);
}

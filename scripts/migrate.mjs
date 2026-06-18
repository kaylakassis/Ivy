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

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.warn('[migrate] DATABASE_URL not set - skipping deploy-step migration (frontend-only build).');
  process.exit(0);
}

try {
  await runSchemaMigration();
  process.exit(0);
} catch (err) {
  console.error('[migrate] FAILED:', err.message);
  if (Array.isArray(err.failures)) {
    for (const f of err.failures) {
      console.error(`  - stmt #${f.origIndex + 1}: ${f.message} | ${f.preview}`);
    }
  }
  process.exit(1);
}

// Runs the ENTIRE test suite — every tests/*.test.mjs plus the smoke
// runner — each in its own process (the suites call process.exit, so they
// can't share one). Exits non-zero if any suite fails.
//
// Wired into `npm test`. Previously `npm test` ran only 5 of the suites,
// leaving the most safety-critical ones (auth, booking-concurrency,
// billing-webhook-dedup, multi-tenant isolation, dunning) to rot unrun.
//
//   npm test            # everything
//   node tests/run-all.mjs
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const bootstrap = path.join(dir, 'bootstrap.mjs');

const suites = [
  ...readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort(),
  'smoke-runner.mjs',
];

// Apply the schema ONCE up front, the same way the deploy does (migrate,
// then run). A brand-new database (e.g. CI's fresh Postgres service) has no
// tables, and not every suite self-migrates via ensureSchemaApplied — the
// alphabetically-first ones would otherwise hit "relation does not exist".
// Run through the bootstrap shim so the Neon driver talks to local Postgres.
console.log('======== schema migration ========');
const migrate = spawnSync(
  process.execPath,
  ['--import', bootstrap, path.join(dir, '..', 'scripts', 'migrate.mjs')],
  { stdio: 'inherit' },
);
if (migrate.status !== 0) {
  console.error('schema migration failed — aborting test run');
  process.exit(1);
}

const failed = [];
for (const f of suites) {
  console.log(`\n======== ${f} ========`);
  const r = spawnSync(process.execPath, ['--import', bootstrap, path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log(`\n──────── ${suites.length - failed.length}/${suites.length} suites passed ────────`);
if (failed.length) {
  console.log('FAILED:', failed.join(', '));
  process.exit(1);
}
process.exit(0);

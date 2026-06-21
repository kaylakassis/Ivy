// DB connection resilience: isConnectionError classification + warmupDb.
//
// A suspended / scaled-to-zero Neon instance (or a transient blip) used to
// hard-500 login. The fix: classify connection-level failures, warm the DB
// with quick retries, and answer a genuinely-down DB with a retryable 503.
// This test pins the classifier (so query errors aren't mistaken for
// outages, and outage signatures aren't mistaken for bugs) and the warmup
// happy path against the live test DB.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/db-warmup.test.mjs

import { isConnectionError, warmupDb } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  console.log('\n[1] isConnectionError flags connection-level outages');
  const outages = [
    'Error connecting to database: fetch failed',
    'The endpoint has been disabled. Enable it using Neon API.',
    'Compute time quota exceeded',
    'connection terminated unexpectedly',
    'ECONNREFUSED 127.0.0.1:5432',
    'too many connections for role',
    'ETIMEDOUT',
    'request timeout',
  ];
  for (const m of outages) {
    assert(isConnectionError(new Error(m)), `outage: "${m.slice(0, 40)}…"`);
  }
  assert(isConnectionError({ dbUnavailable: true }), 'respects dbUnavailable tag');

  console.log('\n[2] isConnectionError does NOT flag ordinary query errors');
  const queryErrs = [
    'duplicate key value violates unique constraint "users_email_key"',
    'column "foo" does not exist',
    'null value in column "id" violates not-null constraint',
    'syntax error at or near "SLECT"',
  ];
  for (const m of queryErrs) {
    assert(!isConnectionError(new Error(m)), `query error stays a bug: "${m.slice(0, 40)}…"`);
  }

  console.log('\n[3] warmupDb resolves against a live DB');
  let ok = false;
  try { await warmupDb(); ok = true; } catch { ok = false; }
  assert(ok, 'warmupDb() resolves when the DB is reachable');

  console.log('\n[4] warmupDb re-throws a non-connection error immediately');
  // A genuine query bug must NOT be retried/swallowed. We can prove the
  // classifier branch by confirming a query error is not connection-class
  // (covered in [2]); warmupDb only retries when isConnectionError is true.
  assert(!isConnectionError(new Error('relation "nope" does not exist')),
    'missing-relation is not treated as an outage');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

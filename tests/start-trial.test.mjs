// Tests the one-trial-per-workspace guard on /api/billing/start-trial.
// Before the fix, a lapsed/cancelled workspace could re-POST start-trial
// to grant itself a fresh 28-day trial indefinitely and use Ivy OS free.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/start-trial.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import startTrial from '../api/billing/start-trial.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}

function makeReq(token) {
  return {
    method: 'POST', url: '/billing/start-trial', query: {}, body: {},
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      cookie: `ivy_session=${token}`,
    },
  };
}

async function getWs(id) {
  return (await sql`SELECT subscription_status, trial_ends_at FROM workspaces WHERE id = ${id}`).rows[0];
}

async function run() {
  await ensureSchemaApplied();

  const owner = (await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`st-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wsId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${owner}) RETURNING id`).rows[0].id;
  const token = signSession(owner);

  console.log('\n[1] lapsed trial → refused, trial NOT extended');
  await sql`UPDATE workspaces SET subscription_status = 'trialing', trial_ends_at = NOW() - INTERVAL '2 days', subscription_period_end = NULL WHERE id = ${wsId}`;
  const before = await getWs(wsId);
  const res1 = makeRes();
  await startTrial(makeReq(token), res1);
  assert(res1.body?.alreadyTrialed === true, 'lapsed trial returns alreadyTrialed:true');
  const after1 = await getWs(wsId);
  assert(new Date(after1.trial_ends_at).getTime() === new Date(before.trial_ends_at).getTime(),
    'trial_ends_at unchanged (no fresh trial granted)');
  assert(new Date(after1.trial_ends_at).getTime() < Date.now(), 'trial_ends_at still in the past');

  console.log('\n[2] never-trialed workspace (trial_ends_at NULL) → trial granted');
  await sql`UPDATE workspaces SET subscription_status = 'inactive', trial_ends_at = NULL, subscription_period_end = NULL WHERE id = ${wsId}`;
  const res2 = makeRes();
  await startTrial(makeReq(token), res2);
  assert(res2.body?.alreadyActive === false, 'grant path: alreadyActive false');
  assert(res2.body?.status === 'trialing', 'status flipped to trialing');
  const after2 = await getWs(wsId);
  assert(after2.trial_ends_at && new Date(after2.trial_ends_at).getTime() > Date.now(),
    'trial_ends_at set into the future');

  console.log('\n[3] active trial → alreadyActive (idempotent no-op)');
  await sql`UPDATE workspaces SET subscription_status = 'trialing', trial_ends_at = NOW() + INTERVAL '10 days' WHERE id = ${wsId}`;
  const res3 = makeRes();
  await startTrial(makeReq(token), res3);
  assert(res3.body?.alreadyActive === true, 'active trial returns alreadyActive:true');

  // Cleanup.
  await sql`DELETE FROM workspaces WHERE id = ${wsId}`;
  await sql`DELETE FROM users WHERE id = ${owner}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

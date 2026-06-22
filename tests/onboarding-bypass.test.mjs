// Two regressions found in the field:
//   • The funnel rework gated /api/calendar (and other settings endpoints)
//     behind isWorkspaceActive(), which 402s NEW signups mid-onboarding
//     because their workspace is `incomplete` until they finish the trial.
//     Fix: ensureActiveWorkspace bypasses while workspaces.onboarded_at IS NULL.
//   • The Paywall's trial CTA hits /api/billing/checkout which requires
//     Stripe to be configured. If the operator hasn't set STRIPE_SECRET_KEY
//     + IVY_STRIPE_PRICE_ID yet, every new signup is locked out with no
//     recovery. Fix: checkout.js falls back to a no-card trial when Stripe
//     is missing AND the user is eligible.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/onboarding-bypass.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { ensureActiveWorkspace, evictWorkspaceGateCache } from '../api/_lib/workspaceGate.js';
import checkoutHandler from '../api/billing/checkout.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
  };
}

let ipN = 0;
function req({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}`, ...headers } };
}

let ownerId, workspaceId;
async function setup() {
  await ensureSchemaApplied();
  await sql.query(`DELETE FROM users WHERE email LIKE 'onb-bypass-%@example.com'`);
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`onb-bypass-${Date.now()}@example.com`}, 'x', 'New Owner', NOW()) RETURNING id`;
  ownerId = u.rows[0].id;
  // Mirror the funnel-rework signup: incomplete, no trial, onboarded_at NULL.
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
    VALUES (${ownerId}, 'incomplete', NULL, NULL) RETURNING id`;
  workspaceId = w.rows[0].id;
}

async function run() {
  try {
    await setup();
    const user = { id: ownerId, email: `onb-bypass@example.com`, user_type: 'regular' };

    console.log('\n[1] gated endpoint passes for an incomplete, un-onboarded workspace (Fix 1)');
    let r = mockRes();
    let gotId = await ensureActiveWorkspace(user, req({ method: 'PATCH', body: { bizName: 'X' } }), r);
    assert(gotId === workspaceId, 'returns the workspace id (no 402)');
    assert(r.statusCode === 200, 'no error response written');

    console.log('\n[2] once onboarding is complete, the same workspace is blocked (paywall fires)');
    await sql`UPDATE workspaces SET onboarded_at = NOW() WHERE id = ${workspaceId}`;
    evictWorkspaceGateCache(workspaceId);
    r = mockRes();
    gotId = await ensureActiveWorkspace(user, req({ method: 'PATCH' }), r);
    assert(gotId === null, 'gate returns null (blocked)');
    assert(r.statusCode === 402, '402 subscription-required after onboarding');
    assert(r.body?.error === 'subscription-required', 'correct error body');

    console.log('\n[3] checkout.js falls back to a no-card trial when Stripe is not configured (Fix 2)');
    // Roll the workspace back to a fresh incomplete + clear trial stamps.
    await sql`UPDATE workspaces SET subscription_status='incomplete', trial_started_at=NULL, trial_ends_at=NULL, converted_at=NULL WHERE id = ${workspaceId}`;
    evictWorkspaceGateCache(workspaceId);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.IVY_STRIPE_SECRET;
    delete process.env.IVY_STRIPE_PRICE_ID;
    const cookie = `ivy_session=${signSession(ownerId)}`;
    r = mockRes();
    await checkoutHandler(req({ method: 'POST', body: { plan: 'monthly' }, headers: { cookie } }), r);
    assert(r.statusCode === 200, 'returns 200 (no 400 about missing Stripe)');
    assert(r.body?.trialStarted === true, 'flagged trialStarted');
    assert(r.body?.fallback === 'no-card', 'flagged no-card fallback');
    const after = (await sql`SELECT subscription_status, trial_ends_at, trial_started_at FROM workspaces WHERE id = ${workspaceId}`).rows[0];
    assert(after.subscription_status === 'trialing', 'workspace is now trialing');
    assert(!!after.trial_ends_at, 'trial_ends_at stamped');
    assert(!!after.trial_started_at, 'trial_started_at stamped');

    console.log('\n[4] fallback does not re-grant a trial to an already-trialed workspace');
    // Mark trial as already used (simulating a returning lapsed user).
    await sql`UPDATE workspaces SET subscription_status='incomplete', trial_started_at=NOW() - INTERVAL '30 days', trial_ends_at=NOW() - INTERVAL '16 days' WHERE id = ${workspaceId}`;
    r = mockRes();
    await checkoutHandler(req({ method: 'POST', body: { plan: 'monthly' }, headers: { cookie } }), r);
    assert(r.statusCode === 400, 'returning lapsed user gets a clear 400 (not a second free trial)');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (workspaceId) {
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

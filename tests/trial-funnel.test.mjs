// Card-backed trial funnel — Stripe (web) path.
//   • A trial checkout / subscription lands as 'trialing' → stamps
//     trial_started_at + trial_ends_at (so isWorkspaceActive unlocks the app),
//     but NOT converted_at (they haven't paid yet).
//   • When the trial flips to 'active' (first real charge), converted_at is
//     stamped once.
// Mirrors the funnel steps the video calls for: paywall → trial_started →
// converted.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/trial-funnel.test.mjs

import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { isWorkspaceActive } from '../api/_lib/clientPortal.js';

const WEBHOOK_SECRET = 'whsec_trial_funnel';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
const RC_SECRET = 'rc_trial_funnel_secret_long_enough';
process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;

const { default: billingHandler } = await import('../api/webhooks/billing.js');
const { default: rcHandler } = await import('../api/billing/revenuecat-webhook.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function signedReq(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { method: 'POST', url: '/api/webhooks/billing', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}
function mkRes() {
  return { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader() {}, json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; } };
}
const evt = (type, object) => ({ id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object } });
const days = (n) => Math.floor(Date.now() / 1000) + n * 86400;

async function row(wid) {
  return (await sql`SELECT subscription_status, trial_started_at, trial_ends_at, converted_at,
    subscription_period_end FROM workspaces WHERE id = ${wid}`).rows[0];
}

const createdUsers = [];
async function run() {
  try {
    await ensureSchemaApplied();
    const u = await sql`INSERT INTO users (email, password_hash, name) VALUES (${`tf-${Date.now()}@t.local`}, 'x', 'TF') RETURNING id`;
    createdUsers.push(u.rows[0].id);
    // New owner starts INACTIVE (the new card-backed model).
    const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
      VALUES (${u.rows[0].id}, 'incomplete', NULL) RETURNING id`;
    const wid = w.rows[0].id;
    const subId = `sub_${wid.slice(0, 8)}`;

    console.log('\n[1] new workspace is inactive (no auto trial)');
    assert(isWorkspaceActive(await row(wid)) === false, 'incomplete workspace is not active');

    console.log('\n[2] card-backed trial starts → trialing, trial stamps, NOT converted');
    let r = mkRes();
    await billingHandler(signedReq(evt('customer.subscription.created', {
      id: subId, status: 'trialing', customer: 'cus_tf',
      metadata: { workspace_id: wid },
      trial_end: days(14), current_period_end: days(14),
    })), r);
    assert(r.statusCode === 200, 'trial sub event → 200');
    let s = await row(wid);
    assert(s.subscription_status === 'trialing', 'status = trialing');
    assert(s.trial_started_at != null, 'trial_started_at stamped');
    assert(s.trial_ends_at != null, 'trial_ends_at set from Stripe trial_end');
    assert(s.converted_at == null, 'converted_at NOT set during trial');
    assert(isWorkspaceActive(s) === true, 'app is unlocked during the card trial');

    console.log('\n[3] trial flips to active → converted_at stamped once');
    const startedAt = s.trial_started_at;
    r = mkRes();
    await billingHandler(signedReq(evt('customer.subscription.updated', {
      id: subId, status: 'active', customer: 'cus_tf',
      metadata: { workspace_id: wid },
      current_period_end: days(44),
    })), r);
    s = await row(wid);
    assert(s.subscription_status === 'active', 'status = active');
    assert(s.converted_at != null, 'converted_at stamped on trial→active');
    assert(+new Date(s.trial_started_at) === +new Date(startedAt), 'trial_started_at unchanged');
    assert(isWorkspaceActive(s) === true, 'active workspace stays unlocked');

    console.log('\n[4] iOS Apple intro trial → trial_started, NOT converted; renewal converts');
    const u2 = await sql`INSERT INTO users (email, password_hash, name) VALUES (${`tfi-${Date.now()}@t.local`}, 'x', 'TFi') RETURNING id`;
    createdUsers.push(u2.rows[0].id);
    const wid2 = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
      VALUES (${u2.rows[0].id}, 'incomplete', NULL) RETURNING id`).rows[0].id;
    const rcReq = (event) => ({ method: 'POST', url: '/api/billing/revenuecat-webhook',
      body: JSON.stringify({ event }), headers: { authorization: `Bearer ${RC_SECRET}`, 'content-type': 'application/json' } });
    const rcEvent = (type, periodType) => ({ id: `rc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type, app_user_id: wid2, product_id: 'ivyos_monthly', period_type: periodType,
      expiration_at_ms: Date.now() + 14 * 86400 * 1000 });

    await rcHandler(rcReq(rcEvent('INITIAL_PURCHASE', 'TRIAL')), mkRes());
    s = await row(wid2);
    assert(s.trial_started_at != null, 'iOS: trial_started_at stamped on intro-trial INITIAL_PURCHASE');
    assert(s.converted_at == null, 'iOS: converted_at NOT set during the intro trial');
    assert(isWorkspaceActive(s) === true, 'iOS: app unlocked during the Apple trial');

    await rcHandler(rcReq(rcEvent('RENEWAL', 'NORMAL')), mkRes());
    s = await row(wid2);
    assert(s.converted_at != null, 'iOS: converted_at stamped on first real (NORMAL) renewal');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

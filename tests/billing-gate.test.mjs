// End-to-end billing gate: a user who pays must never see the paywall.
//
// Two production bugs motivated this suite (both shipped as hotfixes):
//   • /billing/sync wrote status='trialing' but left trial_ends_at NULL,
//     so isWorkspaceActive's trialing branch failed and a user who had
//     JUST checked out with a card stayed walled (fixed in 3b0b852).
//   • The "/" routers dropped ?subscribed=1&session_id=... on redirect so
//     sync never ran (frontend fix, 2b879a8 - not coverable here).
//
// This test drives the REAL handlers with a mocked Stripe API (fetch
// intercept) and a genuinely signed webhook payload, then asserts the
// actual gate - isWorkspaceActive + ensureActiveWorkspace - opens and
// closes at every lifecycle stage: incomplete → trialing (checkout
// redirect race) → active (webhook conversion) → cancelled, plus trial
// expiry and past_due grace.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/billing-gate.test.mjs
import crypto from 'node:crypto';

// Stripe env must exist BEFORE handlers resolve their config at call time.
process.env.STRIPE_SECRET_KEY = 'sk_test_billing_gate_suite';
process.env.IVY_BILLING_WEBHOOK_SECRET = 'whsec_billing_gate_suite';

const { ensureSchemaApplied } = await import('../api/_lib/ensureSchema.js');
const { sql } = await import('../api/_lib/db.js');
const { signSession } = await import('../api/_lib/auth.js');
const { isWorkspaceActive } = await import('../api/_lib/clientPortal.js');
const { ensureActiveWorkspace, evictWorkspaceGateCache } = await import('../api/_lib/workspaceGate.js');
const syncHandler = (await import('../api/billing/sync.js')).default;
const webhookHandler = (await import('../api/webhooks/billing.js')).default;

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ---------------------------------------------------------------- fetch mock
// stripeFetch() goes through fetchWithTimeout → global fetch. Intercept
// api.stripe.com and serve canned objects; swallow everything else (the
// muted Resend notifier) with a generic 200 so no test traffic leaves
// the process.
const realFetch = globalThis.fetch;
const stripeRoutes = new Map(); // path-prefix → object to return
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/v1')) {
    const path = u.slice('https://api.stripe.com/v1'.length);
    for (const [prefix, obj] of stripeRoutes) {
      if (path.startsWith(prefix)) {
        return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
      }
    }
    return {
      ok: false, status: 404,
      json: async () => ({ error: { message: `no mock for ${path}` } }),
      text: async () => '',
    };
  }
  // Non-Stripe (email etc.): pretend success, never leave the process.
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

// ---------------------------------------------------------------- helpers
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 0;
function req({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  ipN++;
  return {
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}`,
      ...headers,
    },
  };
}
// Signs a payload exactly like Stripe does (t=...,v1=HMAC(t + '.' + body))
// so the webhook handler's REAL verification path runs - no bypass.
let evtN = 0;
function signedWebhookReq(type, object) {
  const event = { id: `evt_gate_${Date.now()}_${++evtN}`, type, data: { object } };
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.IVY_BILLING_WEBHOOK_SECRET)
    .update(`${t}.${payload}`).digest('hex');
  return { r: req({ body: payload, headers: { 'stripe-signature': `t=${t},v1=${sig}` } }), event };
}

const nowSec = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

let ownerId, workspaceId, cookie, gateUser;
async function setup() {
  await ensureSchemaApplied();
  await sql.query(`DELETE FROM users WHERE email LIKE 'billing-gate-%@example.com'`);
  const email = `billing-gate-${Date.now()}@example.com`;
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${email}, 'x', 'Gate Owner', NOW()) RETURNING id`;
  ownerId = u.rows[0].id;
  // Mirror a real signup that FINISHED onboarding but hasn't paid:
  // incomplete + trial_ends_at NULL + onboarded_at set, so the gate's
  // onboarding bypass does NOT apply and the paywall is genuinely up.
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
    VALUES (${ownerId}, 'incomplete', NULL, NOW()) RETURNING id`;
  workspaceId = w.rows[0].id;
  cookie = `ivy_session=${signSession(ownerId)}`;
  gateUser = { id: ownerId, email, user_type: 'regular' };
}

const row = async () =>
  (await sql`SELECT subscription_status, trial_ends_at, subscription_period_end,
      stripe_customer_id, stripe_subscription_id, converted_at
    FROM workspaces WHERE id = ${workspaceId}`).rows[0];

// The full gate as a gated API request sees it. The webhook can't evict
// another lambda's in-memory gate cache in prod (TTL handles that); in
// this single process we evict manually so we assert on fresh state.
async function gateOpen() {
  evictWorkspaceGateCache(workspaceId);
  const r = mockRes();
  const got = await ensureActiveWorkspace(gateUser, req({ method: 'PATCH' }), r);
  return got === workspaceId && r.statusCode === 200;
}

async function run() {
  try {
    await setup();

    console.log('\n[1] before checkout: incomplete workspace is walled');
    assert(isWorkspaceActive(await row()) === false, 'isWorkspaceActive = false');
    assert((await gateOpen()) === false, 'gated endpoint 402s');

    console.log('\n[2] checkout redirect race: /billing/sync with the session id drops the wall');
    const subTrialing = {
      id: 'sub_gate_1', object: 'subscription', status: 'trialing',
      customer: 'cus_gate_1',
      trial_end: nowSec + 14 * DAY, current_period_end: nowSec + 14 * DAY,
      metadata: { workspace_id: workspaceId },
      items: { data: [{ price: { unit_amount: 899, currency: 'usd', recurring: { interval: 'week' } } }] },
    };
    stripeRoutes.set('/checkout/sessions/cs_gate_1', {
      id: 'cs_gate_1', object: 'checkout.session', mode: 'subscription',
      customer: 'cus_gate_1', metadata: { workspace_id: workspaceId },
      subscription: subTrialing,
    });
    let r = mockRes();
    await syncHandler(req({ body: { sessionId: 'cs_gate_1' }, headers: { cookie } }), r);
    assert(r.statusCode === 200 && r.body?.synced === true, `sync 200 synced (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
    assert(r.body?.status === 'trialing', 'sync reports trialing');
    let w = await row();
    assert(w.subscription_status === 'trialing', 'row is trialing');
    assert(!!w.trial_ends_at && new Date(w.trial_ends_at).getTime() > Date.now(), 'trial_ends_at stamped in the future (the 3b0b852 regression)');
    assert(w.stripe_subscription_id === 'sub_gate_1' && w.stripe_customer_id === 'cus_gate_1', 'stripe ids linked');
    assert(isWorkspaceActive(w) === true, 'isWorkspaceActive = true → paywall drops');
    assert((await gateOpen()) === true, 'gated endpoint passes');

    console.log('\n[3] sync refuses a checkout session owned by another workspace');
    stripeRoutes.set('/checkout/sessions/cs_foreign', {
      id: 'cs_foreign', object: 'checkout.session', mode: 'subscription',
      customer: 'cus_other', metadata: { workspace_id: '00000000-0000-0000-0000-000000000000' },
      subscription: { ...subTrialing, id: 'sub_foreign' },
    });
    r = mockRes();
    await syncHandler(req({ body: { sessionId: 'cs_foreign' }, headers: { cookie } }), r);
    assert(r.statusCode === 400, `foreign session 400s (got ${r.statusCode})`);
    assert((await row()).stripe_subscription_id === 'sub_gate_1', 'row untouched');

    console.log('\n[4] webhook (source of truth): trial converts to active');
    const { r: whActive } = signedWebhookReq('customer.subscription.updated', {
      ...subTrialing, status: 'active',
      current_period_end: nowSec + 30 * DAY, trial_end: nowSec - 1,
    });
    r = mockRes();
    await webhookHandler(whActive, r);
    assert(r.statusCode === 200 && r.body?.received === true, `webhook 200 (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
    w = await row();
    assert(w.subscription_status === 'active', 'row is active');
    assert(!!w.subscription_period_end && new Date(w.subscription_period_end).getTime() > Date.now(), 'period end in the future');
    assert(!!w.converted_at, 'converted_at stamped on first payment');
    assert(isWorkspaceActive(w) === true && (await gateOpen()) === true, 'app stays open');

    console.log('\n[5] webhook: a tampered signature is rejected');
    const { r: whBad } = signedWebhookReq('customer.subscription.updated', subTrialing);
    whBad.headers['stripe-signature'] = whBad.headers['stripe-signature'].replace(/v1=\w{6}/, 'v1=000000');
    r = mockRes();
    await webhookHandler(whBad, r);
    assert(r.statusCode === 400, `bad signature 400s (got ${r.statusCode})`);
    assert((await row()).subscription_status === 'active', 'state unchanged');

    console.log('\n[6] webhook: cancellation walls the workspace');
    const { r: whDel, event: delEvent } = signedWebhookReq('customer.subscription.deleted', {
      ...subTrialing, status: 'canceled', current_period_end: nowSec - 1,
    });
    r = mockRes();
    await webhookHandler(whDel, r);
    assert(r.statusCode === 200, 'webhook 200');
    w = await row();
    assert(w.subscription_status === 'cancelled', `row is cancelled (got ${w.subscription_status})`);
    assert(isWorkspaceActive(w) === false && (await gateOpen()) === false, 'paywall back up');

    console.log('\n[7] webhook: an exact redelivery of the same event is deduped');
    const t = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify(delEvent);
    const sig = crypto.createHmac('sha256', process.env.IVY_BILLING_WEBHOOK_SECRET)
      .update(`${t}.${payload}`).digest('hex');
    r = mockRes();
    await webhookHandler(req({ body: payload, headers: { 'stripe-signature': `t=${t},v1=${sig}` } }), r);
    assert(r.statusCode === 200 && r.body?.deduped === true, `redelivery acked as deduped (got ${JSON.stringify(r.body)})`);

    console.log('\n[8] trial expiry walls; past_due grace stays open');
    await sql`UPDATE workspaces SET subscription_status='trialing', trial_ends_at=NOW() - INTERVAL '1 hour' WHERE id = ${workspaceId}`;
    assert(isWorkspaceActive(await row()) === false, 'expired trial → walled');
    await sql`UPDATE workspaces SET subscription_status='past_due' WHERE id = ${workspaceId}`;
    assert(isWorkspaceActive(await row()) === true, 'past_due (Stripe smart-retry) → still open');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    await sql`DELETE FROM workspaces WHERE owner_id = ${ownerId}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

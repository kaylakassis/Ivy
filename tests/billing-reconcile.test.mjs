// Billing reconciler (api/cron/billing-reconcile): daily ground-truth
// sync of Ivy's own subscribers against Stripe, healing webhook-outage
// drift. Stripe is mocked via globalThis.fetch; DB is real.
//
//   1. Stale 'active' + Stripe says canceled → flips to 'cancelled'.
//   2. Stale 'past_due' + Stripe says active → 'active' AND dunning
//      bookkeeping cleared (no ghost suspension).
//   3. Apple-billed workspace is NEVER touched.
//   4. In-sync workspace: no write (updated row count via outcome).
//   5. Cron auth: rejects without CRON_SECRET bearer.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/billing-reconcile.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

process.env.CRON_SECRET = 'test-cron-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_reconcile';

// Stripe mock: GET /v1/subscriptions/<id> answered from this map.
const SUBS = new Map();
globalThis.fetch = async (url) => {
  const m = String(url).match(/\/v1\/subscriptions\/([^/?]+)/);
  if (m && SUBS.has(m[1])) {
    return { ok: true, status: 200, json: async () => SUBS.get(m[1]), text: async () => JSON.stringify(SUBS.get(m[1])) };
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'No such subscription' } }),
    text: async () => '{"error":{"message":"No such subscription"}}' };
};

const { default: handler } = await import('../api/cron/billing-reconcile.js');

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
const cronReq = (auth = true) => ({
  method: 'GET', url: '/test', query: {},
  headers: auth ? { authorization: 'Bearer test-cron-secret' } : {},
});

const STAMP = Date.now();
const userIds = [];

async function mkWorkspace(label, { status, subId, source = null, pastDueSince = null }) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`br-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW()) RETURNING id`;
  userIds.push(u.rows[0].id);
  const w = await sql`
    INSERT INTO workspaces (owner_id, name, subscription_status, stripe_subscription_id,
                            subscription_source, subscription_past_due_since,
                            subscription_failed_attempts, subscription_period_end)
    VALUES (${u.rows[0].id}, ${label}, ${status}, ${subId}, ${source || 'stripe'},
            ${pastDueSince}, ${pastDueSince ? 3 : 0}, NOW() - INTERVAL '10 days')
    RETURNING id`;
  return w.rows[0].id;
}

const stripeSub = (id, status, periodEndSec) => ({
  id, status, current_period_end: periodEndSec, trial_end: null, customer: 'cus_x',
  items: { data: [{ price: { id: 'price_x', unit_amount: 899, currency: 'usd' } }] },
});

async function run() {
  await ensureSchemaApplied();
  const future = Math.floor(Date.now() / 1000) + 20 * 86400;

  const subA = `sub_gone_${STAMP}`;    // cancelled in Stripe, active locally
  const subB = `sub_alive_${STAMP}`;   // active in Stripe, past_due locally
  const subC = `sub_apple_${STAMP}`;   // apple-billed - must be untouched
  const subD = `sub_synced_${STAMP}`;  // already in sync
  SUBS.set(subA, stripeSub(subA, 'canceled', future));
  SUBS.set(subB, stripeSub(subB, 'active', future));
  SUBS.set(subC, stripeSub(subC, 'canceled', future));
  SUBS.set(subD, stripeSub(subD, 'active', future));

  const wsA = await mkWorkspace('drifted-cancel', { status: 'active', subId: subA });
  const wsB = await mkWorkspace('recovered', { status: 'past_due', subId: subB, pastDueSince: new Date() });
  const wsC = await mkWorkspace('apple', { status: 'active', subId: subC, source: 'apple' });
  const wsD = await mkWorkspace('synced', { status: 'active', subId: subD });
  // Pre-sync D's period end so nothing is DISTINCT for it.
  await sql`UPDATE workspaces SET subscription_period_end = ${new Date(future * 1000)} WHERE id = ${wsD}`;

  console.log('\n[1] auth');
  let r = mockRes();
  await handler(cronReq(false), r);
  assert(r.statusCode === 401, `no bearer → 401 (got ${r.statusCode})`);

  console.log('\n[2] full sweep');
  r = mockRes();
  await handler(cronReq(), r);
  assert(r.statusCode === 200, `sweep ok (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
  assert(r.body.applied >= 2, `applied at least our 2 drifted rows (got ${r.body.applied})`);

  const row = async (id) => (await sql`
    SELECT subscription_status, subscription_past_due_since, subscription_failed_attempts,
           subscription_suspended_at
    FROM workspaces WHERE id = ${id}`).rows[0];

  const a = await row(wsA);
  assert(a.subscription_status === 'cancelled', `Stripe-cancelled sub flips local active → cancelled (got ${a.subscription_status})`);

  const b = await row(wsB);
  assert(b.subscription_status === 'active', `recovered sub flips past_due → active (got ${b.subscription_status})`);
  assert(b.subscription_past_due_since === null && b.subscription_failed_attempts === 0,
    'dunning bookkeeping cleared on recovery (no ghost suspension)');

  const c = await row(wsC);
  assert(c.subscription_status === 'active', `apple-billed workspace untouched (got ${c.subscription_status})`);

  console.log('\n[3] idempotent second run');
  r = mockRes();
  await handler(cronReq(), r);
  const appliedToOurs = (await sql`
    SELECT subscription_status FROM workspaces WHERE id = ${wsA}`).rows[0];
  assert(appliedToOurs.subscription_status === 'cancelled', 'second run stable');
}

async function cleanup() {
  for (const uid of userIds) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
}

run()
  .catch((e) => { fail++; console.log('  ✗ threw:', e.message, '\n', e.stack); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n────────────────────────────\nPass: ${pass}  Fail: ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });

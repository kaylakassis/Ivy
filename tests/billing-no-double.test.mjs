// An owner can never pay for Ivy twice, and gets one free trial per person.
//
//   [1] checkout refused when the workspace already has a plan (Stripe,
//       confirmed with Stripe; Apple; admin-granted), allowed when the row
//       is stale and Stripe says the old plan is gone
//   [2] idempotent checkout: double click / two tabs give one session and
//       one Stripe customer; another plan expires the old session
//   [3] second Stripe subscription caught by the webhook: unpaid one is
//       cancelled at once, paid one has renewal turned off and is flagged
//       (ops alert); redelivery acts once; late events for other
//       subscriptions never overwrite the live plan
//   [4] Apple / Stripe cross guard: iap-identify refuses web payers; an
//       Apple purchase on a web payer stops the web plan; a web checkout
//       that completes while Apple renews is stopped
//   [5] one free trial per person, surviving account deletion
//
// Stripe is a stateful in-process fake behind globalThis.fetch (idempotency
// keys honoured like Stripe does); the database is real. Every row is
// tagged and removed at the end.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/billing-no-double.test.mjs
import crypto from 'node:crypto';

process.env.STRIPE_SECRET_KEY = 'sk_test_no_double';
process.env.IVY_STRIPE_PRICE_ID = 'price_monthly_test';
process.env.IVY_STRIPE_PRICE_ID_ANNUAL = 'price_annual_test';
process.env.IVY_BILLING_WEBHOOK_SECRET = 'whsec_no_double';
process.env.REVENUECAT_WEBHOOK_SECRET = 'rc_no_double_secret';

const { ensureSchemaApplied } = await import('../api/_lib/ensureSchema.js');
const { sql } = await import('../api/_lib/db.js');
const { signSession } = await import('../api/_lib/auth.js');
const { trialEmailKey, hasUsedTrial, flagOtherLiveSubscriptions } = await import('../api/_lib/billingGuard.js');
const { checkBillingIntegrity } = await import('../api/cron/ops-alerts.js');
const checkoutHandler = (await import('../api/billing/checkout.js')).default;
const syncHandler = (await import('../api/billing/sync.js')).default;
const webhookHandler = (await import('../api/webhooks/billing.js')).default;
const identifyHandler = (await import('../api/billing/iap-identify.js')).default;
const rcHandler = (await import('../api/billing/revenuecat-webhook.js')).default;

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ───────────────────────────────────────────────────────── fake Stripe
const TAG = `nodbl${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const stripe = {
  customers: new Map(), sessions: new Map(), subs: new Map(), invoices: new Map(),
  idem: new Map(), calls: [], n: 0,
};
const nowSec = () => Math.floor(Date.now() / 1000);
const id = (p) => `${p}_${TAG}_${++stripe.n}`;
function addSub({ subId = id('sub'), status = 'active', workspaceId, customer = 'cus_x', paidCents = 1500, cancelAtEnd = false }) {
  const invId = id('in');
  stripe.invoices.set(invId, { id: invId, amount_paid: paidCents });
  const sub = {
    id: subId, object: 'subscription', status, customer, cancel_at_period_end: cancelAtEnd,
    metadata: workspaceId ? { workspace_id: workspaceId } : {},
    current_period_end: nowSec() + 30 * 86400,
    trial_end: status === 'trialing' ? nowSec() + 14 * 86400 : null,
    latest_invoice: invId,
    items: { data: [{ price: { unit_amount: 1500, currency: 'usd' } }] },
  };
  stripe.subs.set(subId, sub);
  return sub;
}
const json = (status, obj) => ({ ok: status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
function route(method, path, form) {
  const [p] = path.split('?');
  const expandInvoice = path.includes('expand[0]=latest_invoice');
  let m;
  if (method === 'POST' && p === '/customers') {
    const c = { id: id('cus'), email: form.get('email'), metadata: { workspace_id: form.get('metadata[workspace_id]') } };
    stripe.customers.set(c.id, c);
    return json(200, c);
  }
  if (method === 'POST' && p === '/checkout/sessions') {
    const s = {
      id: id('cs'), object: 'checkout.session', status: 'open', mode: 'subscription',
      url: `https://checkout.stripe.test/${stripe.n}`, customer: form.get('customer'),
      metadata: { workspace_id: form.get('metadata[workspace_id]') },
      price: form.get('line_items[0][price]'),
      trial_days: form.get('subscription_data[trial_period_days]'),
      subscription: null,
    };
    stripe.sessions.set(s.id, s);
    return json(200, s);
  }
  if ((m = p.match(/^\/checkout\/sessions\/([^/]+)\/expire$/)) && method === 'POST') {
    const s = stripe.sessions.get(decodeURIComponent(m[1]));
    if (!s || s.status !== 'open') return json(400, { error: { message: 'session not open' } });
    s.status = 'expired';
    return json(200, s);
  }
  if ((m = p.match(/^\/checkout\/sessions\/([^/]+)$/)) && method === 'GET') {
    const s = stripe.sessions.get(decodeURIComponent(m[1]));
    if (!s) return json(404, { error: { message: 'No such session', code: 'resource_missing' } });
    const sub = s.subscription ? stripe.subs.get(s.subscription) : null;
    return json(200, { ...s, subscription: sub || s.subscription });
  }
  if (p === '/subscriptions' && method === 'GET') {
    const cus = new URLSearchParams(path.split('?')[1] || '').get('customer');
    return json(200, { data: [...stripe.subs.values()].filter((x) => x.customer === cus) });
  }
  if ((m = p.match(/^\/subscriptions\/([^/]+)$/))) {
    const sub = stripe.subs.get(decodeURIComponent(m[1]));
    if (!sub) return json(404, { error: { message: 'No such subscription', code: 'resource_missing' } });
    if (method === 'DELETE') { sub.status = 'canceled'; return json(200, sub); }
    if (method === 'POST') {
      if (form.get('cancel_at_period_end') === 'true') sub.cancel_at_period_end = true;
      return json(200, sub);
    }
    return json(200, expandInvoice ? { ...sub, latest_invoice: stripe.invoices.get(sub.latest_invoice) } : sub);
  }
  if ((m = p.match(/^\/invoices\/([^/]+)$/))) {
    const inv = stripe.invoices.get(decodeURIComponent(m[1]));
    return inv ? json(200, inv) : json(404, { error: { message: 'No such invoice' } });
  }
  return json(404, { error: { message: `no fake for ${method} ${p}` } });
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.stripe.com/v1')) return json(200, {});
  const method = opts.method || 'GET';
  const path = u.slice('https://api.stripe.com/v1'.length);
  const form = new URLSearchParams(typeof opts.body === 'string' ? opts.body : '');
  const key = opts.headers?.['Idempotency-Key'];
  stripe.calls.push({ method, path, key });
  if (key && stripe.idem.has(key)) return stripe.idem.get(key);
  const res = route(method, path, form);
  if (key && res.ok) stripe.idem.set(key, res);
  return res;
};
const callsTo = (method, re) => stripe.calls.filter((c) => c.method === method && re.test(c.path)).length;

// ───────────────────────────────────────────────────────── helpers
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 0;
function req({ body = {}, headers = {} } = {}) {
  ipN++;
  return {
    method: 'POST', url: '/test', query: {}, body,
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.18.${ipN % 250}.${(ipN * 7) % 250}`, ...headers,
    },
  };
}
let evtN = 0;
function stripeEvent(type, object) {
  const payload = JSON.stringify({ id: `evt_${TAG}_${++evtN}`, type, data: { object } });
  const t = nowSec();
  const sig = crypto.createHmac('sha256', process.env.IVY_BILLING_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return req({ body: payload, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
}
const rcReq = (event) => ({
  method: 'POST', url: '/api/billing/revenuecat-webhook', body: JSON.stringify({ event }),
  headers: { authorization: `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`, 'content-type': 'application/json' },
});
const rcEvent = (type, wid, extra = {}) => ({
  id: `${TAG}-rc-${++evtN}`, type, app_user_id: wid, product_id: 'ivy_weekly', environment: 'PRODUCTION',
  period_type: 'NORMAL', expiration_at_ms: Date.now() + 7 * 86400000, original_transaction_id: `${TAG}-txn-${evtN}`, ...extra,
});
const run = async (handler, r) => { const res = mkRes(); await handler(r, res); return res; };

let ownerN = 0;
async function mkOwner(ws = {}) {
  const email = `owner${++ownerN}.${TAG}@example.com`;
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${email}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
    VALUES (${u.rows[0].id}, 'incomplete', NULL, NOW()) RETURNING id`;
  const wid = w.rows[0].id;
  const cols = Object.keys(ws);
  if (cols.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await sql.query(`UPDATE workspaces SET ${sets} WHERE id = $1`, [wid, ...cols.map((c) => ws[c])]);
  }
  return { userId: u.rows[0].id, wid, email, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
const wsRow = async (wid) => (await sql`
  SELECT subscription_status, subscription_source, stripe_customer_id, stripe_subscription_id,
         revenuecat_user_id, billing_checkout_session_id
    FROM workspaces WHERE id = ${wid}`).rows[0];
const conflict = async (extraRef) => (await sql`SELECT * FROM billing_conflicts WHERE extra_ref = ${extraRef}`).rows;
const checkout = (o, plan = 'monthly') => run(checkoutHandler, req({ body: { plan }, headers: { cookie: o.cookie } }));
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();

async function cleanup() {
  const { rows } = await sql.query(`SELECT id, email FROM users WHERE email LIKE $1`, [`%${TAG}%`]);
  for (const r of rows) {
    await sql`DELETE FROM billing_trial_claims WHERE email_hash = ${trialEmailKey(r.email)}`.catch(() => {});
    await sql`DELETE FROM workspaces WHERE owner_id = ${r.id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${r.id}`.catch(() => {});
  }
  await sql.query(`DELETE FROM billing_conflicts WHERE extra_ref LIKE $1`, [`%${TAG}%`]).catch(() => {});
}

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] checkout is refused while a plan exists');
  const liveSub = addSub({ status: 'active' });
  const paying = await mkOwner({ subscription_status: 'active', subscription_source: 'stripe', stripe_customer_id: 'cus_paying', stripe_subscription_id: liveSub.id, subscription_period_end: future(20) });
  let r = await checkout(paying);
  assert(r.statusCode === 409 && r.body?.code === 'already_subscribed' && r.body?.manageUrl === '/account#billing',
    `active Stripe plan → 409 already_subscribed with a manage link (${r.statusCode} ${JSON.stringify(r.body)})`);
  assert(/Manage billing/.test(r.body?.error || ''), 'message tells the owner where to manage it');
  assert(callsTo('POST', /^\/checkout\/sessions$/) === 0, 'no checkout session was created');

  const trialSub = addSub({ status: 'trialing', paidCents: 0 });
  const trialing = await mkOwner({ subscription_status: 'trialing', subscription_source: 'stripe', stripe_customer_id: 'cus_t', stripe_subscription_id: trialSub.id, trial_ends_at: future(10), trial_started_at: new Date().toISOString() });
  r = await checkout(trialing);
  assert(r.statusCode === 409 && r.body?.code === 'already_subscribed', 'card trial in progress → 409 (the old check let trialing through)');

  const pastDueSub = addSub({ status: 'past_due' });
  const pastDue = await mkOwner({ subscription_status: 'past_due', subscription_source: 'stripe', stripe_customer_id: 'cus_pd', stripe_subscription_id: pastDueSub.id, subscription_period_end: future(-2) });
  r = await checkout(pastDue);
  assert(r.statusCode === 409 && /update your card/i.test(r.body?.error || ''), 'past due → 409, told to update the card instead');

  const apple = await mkOwner({ subscription_status: 'active', subscription_source: 'apple', subscription_period_end: future(5), revenuecat_user_id: null });
  r = await checkout(apple);
  assert(r.statusCode === 409 && r.body?.code === 'billed_by_apple' && r.body?.provider === 'apple',
    `Apple-billed → 409 billed_by_apple (${JSON.stringify(r.body)})`);

  const deadSub = addSub({ status: 'canceled' });
  const stale = await mkOwner({ subscription_status: 'active', subscription_source: 'stripe', stripe_customer_id: 'cus_stale', stripe_subscription_id: deadSub.id, subscription_period_end: future(3) });
  r = await checkout(stale);
  assert(r.statusCode === 200 && r.body?.url, 'row says active but Stripe says cancelled → checkout allowed (no lock-out)');

  console.log('\n[2] idempotent checkout: one session, one customer');
  const fresh = await mkOwner();
  const custBefore = callsTo('POST', /^\/customers$/);
  const sessBefore = stripe.sessions.size;
  const [a, b] = await Promise.all([checkout(fresh), checkout(fresh)]);
  assert(a.statusCode === 200 && b.statusCode === 200 && a.body.url && a.body.url === b.body.url,
    `double click → same checkout URL (${a.body?.url} / ${b.body?.url})`);
  const freshSessions = [...stripe.sessions.values()].filter((s) => s.metadata.workspace_id === fresh.wid);
  assert(freshSessions.length === 1, `exactly one Stripe session for the workspace (${freshSessions.length})`);
  assert(stripe.sessions.size === sessBefore + 1, 'and only one created overall in this step');
  const freshCustomers = [...stripe.customers.values()].filter((c) => c.metadata.workspace_id === fresh.wid);
  assert(freshCustomers.length === 1, `exactly one Stripe customer for the workspace (${freshCustomers.length}, ${callsTo('POST', /^\/customers$/) - custBefore} create calls)`);
  let row = await wsRow(fresh.wid);
  assert(row.stripe_customer_id === freshCustomers[0]?.id, 'customer stored on the workspace before payment');
  assert(freshSessions[0]?.customer === row.stripe_customer_id, 'session is tied to that customer (no customer_email minting a new one)');
  assert(freshSessions[0]?.trial_days === '14', 'first-timer gets the card trial');

  r = await checkout(fresh);
  assert(r.statusCode === 200 && r.body?.reused === true && r.body?.url === a.body.url, 'later click, same plan → the open session is reused');

  r = await checkout(fresh, 'annual');
  const annual = [...stripe.sessions.values()].filter((s) => s.metadata.workspace_id === fresh.wid && s.price === 'price_annual_test');
  assert(r.statusCode === 200 && annual.length === 1 && r.body.url === annual[0].url, 'switching to annual → a new session');
  assert(stripe.sessions.get(freshSessions[0].id).status === 'expired', 'the monthly session was expired: only one can be paid');
  r = await checkout(fresh, 'monthly');
  const monthlyNow = [...stripe.sessions.values()].filter((s) => s.metadata.workspace_id === fresh.wid && s.status === 'open');
  assert(r.statusCode === 200 && monthlyNow.length === 1 && monthlyNow[0].price === 'price_monthly_test' && r.body.url === monthlyNow[0].url,
    'back to monthly → a fresh open session (never a replay of the expired one), annual expired');
  assert([...stripe.customers.values()].filter((c) => c.metadata.workspace_id === fresh.wid).length === 1, 'still one customer after four checkouts');

  console.log('\n[3] a second Stripe subscription is caught by the webhook');
  const subA = addSub({ status: 'active' });
  const dup = await mkOwner({ subscription_status: 'active', subscription_source: 'stripe', stripe_customer_id: 'cus_dup', stripe_subscription_id: subA.id, subscription_period_end: future(25), converted_at: new Date().toISOString() });
  // (a) unpaid second plan (card trial) → cancelled at once
  const subB = addSub({ status: 'trialing', workspaceId: dup.wid, paidCents: 0 });
  r = await run(webhookHandler, stripeEvent('customer.subscription.created', subB));
  row = await wsRow(dup.wid);
  assert(r.statusCode === 200 && row.stripe_subscription_id === subA.id && row.subscription_status === 'active', 'workspace keeps its first plan');
  assert(stripe.subs.get(subB.id).status === 'canceled', 'unpaid second plan cancelled immediately');
  let c = await conflict(subB.id);
  assert(c.length === 1 && c[0].action === 'cancelled_unpaid' && c[0].resolved_at, `recorded as cancelled_unpaid, resolved (${c[0]?.action})`);
  // its own "deleted" event must not flip the paying workspace to cancelled
  r = await run(webhookHandler, stripeEvent('customer.subscription.deleted', stripe.subs.get(subB.id)));
  row = await wsRow(dup.wid);
  assert(row.subscription_status === 'active' && row.stripe_subscription_id === subA.id, 'its deletion event leaves the live plan alone');

  // (b) paid second plan via a completed checkout → renewal off, flagged
  const subC = addSub({ status: 'active', workspaceId: dup.wid, paidCents: 1500 });
  const sessC = { id: id('cs'), object: 'checkout.session', mode: 'subscription', status: 'complete', customer: 'cus_dup', subscription: subC.id, metadata: { workspace_id: dup.wid } };
  stripe.sessions.set(sessC.id, sessC);
  r = await run(webhookHandler, stripeEvent('checkout.session.completed', sessC));
  row = await wsRow(dup.wid);
  assert(r.statusCode === 200 && row.stripe_subscription_id === subA.id, 'checkout for a second plan does not replace the first');
  assert(stripe.subs.get(subC.id).cancel_at_period_end === true && stripe.subs.get(subC.id).status === 'active',
    'paid second plan: renewal turned off, never refunded automatically');
  c = await conflict(subC.id);
  assert(c.length === 1 && c[0].action === 'cancel_at_period_end' && !c[0].resolved_at && /refund/.test(c[0].detail), 'flagged open, refund decision noted');
  const alerts = await checkBillingIntegrity();
  const billingAlert = alerts.find((x) => x.key === 'billing_conflicts');
  assert(billingAlert && billingAlert.severity === 'critical' && billingAlert.detail.includes(subC.id), 'hourly ops alert names the extra subscription');

  // (c) redeliveries act once
  const stopsBefore = callsTo('POST', new RegExp(`^/subscriptions/${subC.id}$`));
  await run(webhookHandler, stripeEvent('customer.subscription.updated', stripe.subs.get(subC.id)));
  await run(syncHandler, req({ body: { sessionId: sessC.id }, headers: { cookie: dup.cookie } }));
  assert(callsTo('POST', new RegExp(`^/subscriptions/${subC.id}$`)) === stopsBefore, 'later events and the post-checkout sync do not act again');
  assert((await conflict(subC.id)).length === 1, 'still one conflict row');
  row = await wsRow(dup.wid);
  assert(row.stripe_subscription_id === subA.id, 'sync did not swap the plan either');

  // (d) the extra plan ends → the case closes, workspace untouched
  stripe.subs.get(subC.id).status = 'canceled';
  await run(webhookHandler, stripeEvent('customer.subscription.deleted', stripe.subs.get(subC.id)));
  c = await conflict(subC.id);
  row = await wsRow(dup.wid);
  assert(c[0].resolved_at && row.subscription_status === 'active', 'extra plan ended: case resolved, owner still active');

  // (e) normal re-subscribe after a real cancellation still links
  stripe.subs.get(subA.id).status = 'canceled';
  const subD = addSub({ status: 'active', workspaceId: dup.wid });
  await run(webhookHandler, stripeEvent('customer.subscription.created', subD));
  row = await wsRow(dup.wid);
  assert(row.stripe_subscription_id === subD.id && (await conflict(subD.id)).length === 0, 'old plan gone → the new one is tracked, no conflict');

  console.log('\n[4] Apple and Stripe never both');
  const webPayerSub = addSub({ status: 'active' });
  const webPayer = await mkOwner({ subscription_status: 'active', subscription_source: 'stripe', stripe_customer_id: 'cus_web', stripe_subscription_id: webPayerSub.id, subscription_period_end: future(20) });
  r = await run(identifyHandler, req({ headers: { cookie: webPayer.cookie } }));
  row = await wsRow(webPayer.wid);
  assert(r.statusCode === 409 && r.body?.code === 'billed_on_web' && /paid on the web/.test(r.body?.error || ''), 'iap-identify refuses a web payer (the app then sells nothing)');
  assert(row.revenuecat_user_id === null, 'and does not bind the workspace');
  const nobody = await mkOwner();
  r = await run(identifyHandler, req({ headers: { cookie: nobody.cookie } }));
  assert(r.statusCode === 200 && r.body?.appUserId === nobody.wid, 'an owner with no plan can still buy in the app');

  // Apple purchase reaches a web payer anyway (old app build): web plan stopped.
  await sql`UPDATE workspaces SET revenuecat_user_id = id WHERE id = ${webPayer.wid}`;
  r = await run(rcHandler, rcReq(rcEvent('INITIAL_PURCHASE', webPayer.wid)));
  row = await wsRow(webPayer.wid);
  c = await conflict(webPayerSub.id);
  assert(r.statusCode === 200 && row.subscription_source === 'apple' && row.subscription_status === 'active', 'Apple purchase still unlocks (Apple has charged)');
  assert(stripe.subs.get(webPayerSub.id).cancel_at_period_end === true, 'paid web plan: renewal turned off');
  assert(c.length === 1 && c[0].kind === 'apple_and_stripe' && c[0].action === 'cancel_at_period_end' && !c[0].resolved_at, 'flagged apple_and_stripe for a refund decision');

  // Same, but the web plan is still a free card trial → cancelled at once.
  const webTrialSub = addSub({ status: 'trialing', paidCents: 0 });
  const webTrial = await mkOwner({ subscription_status: 'trialing', subscription_source: 'stripe', stripe_customer_id: 'cus_wt', stripe_subscription_id: webTrialSub.id, trial_ends_at: future(7) });
  await sql`UPDATE workspaces SET revenuecat_user_id = id WHERE id = ${webTrial.wid}`;
  await run(rcHandler, rcReq(rcEvent('INITIAL_PURCHASE', webTrial.wid, { period_type: 'TRIAL' })));
  assert(stripe.subs.get(webTrialSub.id).status === 'canceled', 'web card trial cancelled immediately (no money taken)');

  // Sandbox purchases never touch real billing.
  const sbSub = addSub({ status: 'active' });
  const sb = await mkOwner({ subscription_status: 'active', subscription_source: 'stripe', stripe_customer_id: 'cus_sb', stripe_subscription_id: sbSub.id, subscription_period_end: future(20) });
  await sql`UPDATE workspaces SET revenuecat_user_id = id WHERE id = ${sb.wid}`;
  await run(rcHandler, rcReq(rcEvent('INITIAL_PURCHASE', sb.wid, { environment: 'SANDBOX' })));
  assert(stripe.subs.get(sbSub.id).cancel_at_period_end === false && (await conflict(sbSub.id)).length === 0, 'sandbox Apple purchase: web plan untouched');

  // Web checkout completes while Apple is still renewing → web plan stopped,
  // workspace stays on Apple.
  const appleOwner = await mkOwner({ subscription_status: 'active', subscription_source: 'apple', subscription_period_end: future(6), cancel_at_period_end: false, stripe_customer_id: 'cus_ap' });
  const lateSub = addSub({ status: 'trialing', workspaceId: appleOwner.wid, paidCents: 0 });
  const lateSess = { id: id('cs'), object: 'checkout.session', mode: 'subscription', status: 'complete', customer: 'cus_ap', subscription: lateSub.id, metadata: { workspace_id: appleOwner.wid } };
  stripe.sessions.set(lateSess.id, lateSess);
  await run(webhookHandler, stripeEvent('checkout.session.completed', lateSess));
  row = await wsRow(appleOwner.wid);
  assert(row.subscription_source === 'apple' && row.stripe_subscription_id === null, 'workspace stays on Apple');
  assert(stripe.subs.get(lateSub.id).status === 'canceled' && (await conflict(lateSub.id))[0]?.kind === 'apple_and_stripe', 'web trial bought next to Apple cancelled and recorded');

  // Apple plan that will not renew: moving to the web is allowed.
  const leaving = await mkOwner({ subscription_status: 'active', subscription_source: 'apple', subscription_period_end: future(2), cancel_at_period_end: true });
  const moveSub = addSub({ status: 'active', workspaceId: leaving.wid });
  const moveSess = { id: id('cs'), object: 'checkout.session', mode: 'subscription', status: 'complete', customer: 'cus_mv', subscription: moveSub.id, metadata: { workspace_id: leaving.wid } };
  await run(webhookHandler, stripeEvent('checkout.session.completed', moveSess));
  row = await wsRow(leaving.wid);
  assert(row.subscription_source === 'stripe' && row.stripe_subscription_id === moveSub.id, 'Apple set to end → web checkout takes over as before');

  console.log('\n[4b] daily sweep raises duplicates the webhook never saw (no auto-cancel)');
  const sweepCus = `cus_sweep_${TAG}`;
  const kept = addSub({ status: 'active', customer: sweepCus });
  const manual = addSub({ status: 'active', customer: sweepCus }); // e.g. made by hand, no workspace metadata
  addSub({ status: 'canceled', customer: sweepCus });
  const sweepOwner = await mkOwner({ subscription_status: 'active', subscription_source: 'stripe', stripe_customer_id: sweepCus, stripe_subscription_id: kept.id, subscription_period_end: future(20) });
  let raised = await flagOtherLiveSubscriptions({ workspaceId: sweepOwner.wid, trackedSub: kept, secretKey: process.env.STRIPE_SECRET_KEY });
  c = await conflict(manual.id);
  assert(raised === 1 && c.length === 1 && c[0].action === 'flagged' && !c[0].resolved_at, 'the other live plan is flagged (cancelled one ignored)');
  assert(stripe.subs.get(manual.id).status === 'active' && !stripe.subs.get(manual.id).cancel_at_period_end, 'and left untouched for a person to decide');
  raised = await flagOtherLiveSubscriptions({ workspaceId: sweepOwner.wid, trackedSub: kept, secretKey: process.env.STRIPE_SECRET_KEY });
  assert(raised === 0 && (await conflict(manual.id)).length === 1, 'the next day does not raise it twice');

  console.log('\n[5] one free trial per person');
  const first = await mkOwner();
  assert(!(await hasUsedTrial(first.email)), 'new email: trial available');
  const trialStart = addSub({ status: 'trialing', workspaceId: first.wid, paidCents: 0 });
  await run(webhookHandler, stripeEvent('customer.subscription.created', trialStart));
  assert(await hasUsedTrial(first.email), 'trial start recorded against the email');
  assert(await hasUsedTrial(first.email.toUpperCase()), 'any capitals match');
  assert(trialEmailKey(first.email.replace('@', `+deleted-${first.userId}@`)) === trialEmailKey(first.email), 'deleted-account mangle maps to the same person');
  const backfilled = await sql`
    SELECT 1 FROM billing_trial_claims
     WHERE email_hash = encode(sha256(convert_to(regexp_replace(LOWER(TRIM(${first.email.replace('@', `+deleted-${first.userId}@`).toUpperCase()}::text)), '[+]deleted-[0-9a-f-]+@', '@'), 'UTF8')), 'hex')`;
  assert(backfilled.rows.length === 1, 'the SQL backfill formula computes the same key as the code');
  // Delete the account completely and sign up again with the same email.
  const email = first.email;
  await sql`DELETE FROM workspaces WHERE owner_id = ${first.userId}`;
  await sql`DELETE FROM users WHERE id = ${first.userId}`;
  const u2 = await sql`INSERT INTO users (email, password_hash, name) VALUES (${email}, 'x', 'Again') RETURNING id`;
  const w2 = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at) VALUES (${u2.rows[0].id}, 'incomplete', NULL, NOW()) RETURNING id`;
  r = await checkout({ cookie: `ivy_session=${signSession(u2.rows[0].id)}` });
  const again = [...stripe.sessions.values()].find((s) => s.metadata.workspace_id === w2.rows[0].id);
  assert(r.statusCode === 200 && again && !again.trial_days, 'same email, new account: checkout offers no second trial');

  // A client-portal account that touches an owner endpoint no longer gets a
  // free no-card trial from the column defaults.
  const clientOnly = await sql`INSERT INTO users (email, password_hash, name) VALUES (${`client.${TAG}@example.com`}, 'x', 'Client') RETURNING id`;
  const { ensureWorkspace } = await import('../api/_lib/auth.js');
  const lazyWs = await ensureWorkspace(clientOnly.rows[0].id);
  const lazy = (await sql`SELECT subscription_status, trial_ends_at FROM workspaces WHERE id = ${lazyWs}`).rows[0];
  assert(lazy.subscription_status === 'incomplete' && lazy.trial_ends_at === null, 'lazily created business starts with no plan and no trial');
}

try {
  await main();
} catch (err) {
  console.error('Fatal:', err.message, err.stack);
  fail++;
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e.message));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

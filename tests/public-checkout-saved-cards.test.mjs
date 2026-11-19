// The three public checkouts (membership, package, program) take no
// sign-in: the visitor only types an email. A Stripe Checkout session that
// carries an existing customer shows that customer's saved card (brand,
// last four, expiry), name and billing address to whoever opened the link
// and lets them pay with it. Cards saved through Checkout in setup mode
// (the autopay consent and card-on-file flows) are saved as redisplayable,
// so that is exactly what an anonymous visitor typing a client's email
// would have seen.
//
// These tests pin the fix: a public checkout NEVER attaches a Stripe
// customer, never looks one up, and never touches the customer autopay
// charges (clients.stripe_customer_id). The webhooks still deliver the
// purchase to the right client through metadata.client_id.
//
//   [1] a stranger types a client's email (client has a saved card):
//       membership / package / one-time program / subscription program
//   [2] a brand-new email: no Stripe customer is created or linked
//   [3] webhooks still deliver, the autopay customer is untouched, and a
//       membership is created exactly once (connected + own-keys businesses)
//   [4] source guard: the public endpoints cannot attach a customer
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/public-checkout-saved-cards.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STRIPE_SECRET_KEY = 'sk_test_pubco';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pubco';
process.env.SECRETS_KEY = process.env.SECRETS_KEY || 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { createMembershipCheckoutSession } from '../api/_lib/stripe.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';
import membershipsIndex from '../api/memberships/index.js';
import membershipCheckout from '../api/memberships/checkout.js';
import packagesIndex from '../api/packages/index.js';
import packageCheckout from '../api/packages/checkout.js';
import programsIndex from '../api/programs/index.js';
import programById from '../api/programs/[id].js';
import programCheckout from '../api/programs/checkout.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Stripe + mail mock ───────────────────────────────────────────────
// The customer list answers as the real account would for a client who
// consented to autopay: a customer with that email DOES exist. A public
// checkout must not even ask.
const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) return json({ id: `em_${++seq}` });
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  calls.push({ url: u, method, body, headers: init.headers || {} });
  if (/\/v1\/products$/.test(u) && method === 'POST') return json({ id: `prod_${++seq}` });
  if (/\/v1\/prices$/.test(u) && method === 'POST') return json({ id: `price_${++seq}`, unit_amount: Number(body.unit_amount) });
  if (/\/v1\/customers\?/.test(u) && method === 'GET') return json({ data: [{ id: 'cus_found_by_email', email: 'someone@example.com' }] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: `cus_minted_${++seq}`, email: body.email });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/${seq}`, customer: body.customer || null });
  return json({});
};
const stripeCalls = (re) => calls.filter((c) => re.test(`${c.method} ${c.url}`));
const lastSession = () => stripeCalls(/POST .*\/v1\/checkout\/sessions$/).at(-1);

// ── request helpers ──────────────────────────────────────────────────
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, req: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
const HOST = 'www.joinivy.ai';
// Public checkouts are rate limited per IP per hour; a fresh address per
// request keeps this suite (and repeated local runs) clear of it.
const IPB = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
let ipN = 0;
function req({ method = 'GET', cookie, query = {}, body } = {}) {
  return {
    method, url: '/t', query, body,
    headers: { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': `${IPB}.${1 + (ipN++ % 250)}`, 'user-agent': 'test', ...(cookie ? { cookie } : {}) },
  };
}
async function call(handler, r) { const res = mkRes(); res.req = r; await handler(r, res); return res; }

let evtN = 0;
function sign(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_pubco_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': sign(payload, process.env.STRIPE_WEBHOOK_SECRET), 'content-type': 'application/json' } }, res);
  return res;
}
async function fireLegacy(type, object, workspaceId, secret) {
  const payload = JSON.stringify({ id: `evt_pubco_legacy_${Date.now()}_${++evtN}`, type, data: { object } });
  const res = mkRes();
  await legacyWebhook({ method: 'POST', url: `/api/webhooks/stripe/${workspaceId}`, query: { workspaceId }, body: payload, headers: { 'stripe-signature': sign(payload, secret), 'content-type': 'application/json' } }, res);
  return res;
}
const subObj = (id, priceId, over = {}) => ({
  id, object: 'subscription', status: 'active', cancel_at_period_end: false,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ id: 'si_1', price: { id: priceId } }] },
  ...over,
});

// ── fixtures ─────────────────────────────────────────────────────────
const STAMP = Date.now();
async function mkOwner(label, { legacy = false } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pubco-${label}-${STAMP}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `pubco-${label}-${STAMP}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}, slug = ${slug}`;
  const acct = `acct_pubco_${label}_${STAMP}`;
  const whSecret = `whsec_pubco_${label}`;
  if (legacy) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted, currency)
      VALUES (${wid}, ${encrypt('sk_live_pubco_owner_key')}, ${encrypt(whSecret)}, 'USD')`;
  } else {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  }
  return { uid: u, wid, slug, acct, whSecret, legacy, cookie: `ivy_session=${signSession(u)}` };
}
// A client who already consented to autopay: a Stripe customer with a saved
// card on file, exactly what the consent flow leaves on the row.
async function mkClientWithSavedCard(biz, email) {
  const customerId = `cus_saved_${biz.legacy ? 'l' : 'a'}_${STAMP}`;
  const id = (await sql`
    INSERT INTO clients (workspace_id, name, email, stage, stripe_customer_id,
                         payment_method_id, payment_method_brand, payment_method_last4,
                         payment_method_exp_month, payment_method_exp_year)
    VALUES (${biz.wid}, 'Vic Tim', ${email}, 'active', ${customerId}, 'pm_saved_card', 'visa', '4242', 12, 2031)
    RETURNING id`).rows[0].id;
  return { id, email, customerId };
}
const cardRow = (id) => sql`SELECT stripe_customer_id, payment_method_id, payment_method_last4 FROM clients WHERE id = ${id}`.then((r) => r.rows[0]);
const cardUntouched = async (c) => {
  const row = await cardRow(c.id);
  return row.stripe_customer_id === c.customerId && row.payment_method_id === 'pm_saved_card' && row.payment_method_last4 === '4242';
};

// What every public session must look like, whoever the typed email is.
function assertNoCustomer(cs, email, label) {
  assert(!!cs, `${label}: a checkout session was requested`);
  assert(!('customer' in (cs?.body || {})), `${label}: session carries NO customer (nothing saved can be shown or charged)`);
  assert(cs?.body.customer_email === email.toLowerCase(), `${label}: session carries only the typed email`);
  const keys = Object.keys(cs?.body || {});
  assert(!keys.some((k) => /^saved_payment_method_options|^customer_update|setup_future_usage/.test(k)), `${label}: session neither redisplays nor saves a card`);
  assert(stripeCalls(/\/v1\/customers/).length === 0, `${label}: no Stripe customer was looked up or created`);
}

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const L = await mkOwner('legacy', { legacy: true });

  // Things to sell, made the way an owner makes them.
  let r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'Monthly', priceCents: 4900, interval: 'month' } }));
  const tier = r.body.membership;
  const tierPrice = (await sql`SELECT stripe_price_id FROM memberships WHERE id = ${tier.id}`).rows[0].stripe_price_id;
  r = await call(membershipsIndex, req({ method: 'POST', cookie: L.cookie, body: { name: 'Monthly', priceCents: 3900, interval: 'month' } }));
  const tierL = r.body.membership;
  const tierLPrice = (await sql`SELECT stripe_price_id FROM memberships WHERE id = ${tierL.id}`).rows[0].stripe_price_id;
  r = await call(packagesIndex, req({ method: 'POST', cookie: A.cookie, body: { name: '5 Sessions', sessionCount: 5, price: 180 } }));
  const pkg = r.body.package;
  const mkProgram = async (body) => {
    const p = (await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body }))).body.program;
    await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: p.id }, body: { status: 'published' } }));
    return p;
  };
  const oneTime = await mkProgram({ title: '8-Week Strength', priceCents: 4900, billing: 'one_time' });
  const monthly = await mkProgram({ title: 'Monthly Coaching', priceCents: 2900, billing: 'month' });
  assert(!!tier?.id && !!tierPrice && !!tierL?.id && !!pkg?.id && !!oneTime?.id && !!monthly?.id, 'fixtures: membership tiers, package, programs');

  const vic = await mkClientWithSavedCard(A, `pubco-vic-${STAMP}@example.com`);
  const vicL = await mkClientWithSavedCard(L, `pubco-vic-legacy-${STAMP}@example.com`);
  const stranger = { name: 'Not Vic' };

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] a stranger types the email of a client with a saved card');
  calls.length = 0;
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: tier.id, ...stranger, email: vic.email.toUpperCase() } }));
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url), `membership checkout still opens (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  let cs = lastSession();
  assertNoCustomer(cs, vic.email, 'membership');
  assert(cs.body.mode === 'subscription' && cs.body['metadata[client_id]'] === vic.id && cs.body['subscription_data[metadata][client_id]'] === vic.id && cs.body['subscription_data[metadata][purpose]'] === 'membership', 'membership: the webhook can still link the client (metadata.client_id)');
  assert(await cardUntouched(vic), "membership: the client's autopay customer and card are unchanged");

  calls.length = 0;
  r = await call(packageCheckout, req({ method: 'POST', body: { slug: A.slug, packageId: pkg.id, ...stranger, email: vic.email } }));
  assert(r.statusCode === 200 && !!r.body.url, `package checkout still opens (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  cs = lastSession();
  assertNoCustomer(cs, vic.email, 'package');
  assert(cs.body.mode === 'payment' && cs.body['metadata[client_id]'] === vic.id && cs.body['payment_intent_data[metadata][client_id]'] === vic.id && cs.body['metadata[purpose]'] === 'package', 'package: the webhook can still link the client (metadata.client_id)');
  assert(await cardUntouched(vic), "package: the client's autopay customer and card are unchanged");

  calls.length = 0;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: oneTime.id, ...stranger, email: vic.email.toUpperCase() } }));
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url), `one-time program checkout still opens (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  cs = lastSession();
  assertNoCustomer(cs, vic.email, 'program (one-time)');
  assert(cs.body.mode === 'payment' && cs.body['metadata[client_id]'] === vic.id && cs.body['payment_intent_data[metadata][client_id]'] === vic.id, 'program (one-time): the webhook can still link the client');

  calls.length = 0;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: monthly.id, ...stranger, email: vic.email } }));
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url), `subscription program checkout still opens (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  cs = lastSession();
  assertNoCustomer(cs, vic.email, 'program (subscription)');
  assert(cs.body.mode === 'subscription' && cs.body['subscription_data[metadata][client_id]'] === vic.id && cs.body['subscription_data[metadata][purpose]'] === 'program', 'program (subscription): the webhook can still link the client');
  assert(await cardUntouched(vic), "program: the client's autopay customer and card are unchanged");
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${vic.email}`).rows[0].n === 1, 'no duplicate client row for the typed email');

  // A business on its own keys behaves the same.
  calls.length = 0;
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: L.slug, membershipId: tierL.id, ...stranger, email: vicL.email } }));
  assert(r.statusCode === 200, `own-keys business: membership checkout opens (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  assertNoCustomer(lastSession(), vicL.email, 'membership (own keys)');
  assert(await cardUntouched(vicL), "own-keys business: the client's autopay customer and card are unchanged");

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] a brand-new email');
  const newbie = `pubco-new-${STAMP}@example.com`;
  for (const [label, go] of [
    ['membership', () => call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: tier.id, name: 'New Person', email: newbie } }))],
    ['package', () => call(packageCheckout, req({ method: 'POST', body: { slug: A.slug, packageId: pkg.id, name: 'New Person', email: newbie } }))],
    ['program', () => call(programCheckout, req({ method: 'POST', body: { programId: monthly.id, name: 'New Person', email: newbie } }))],
  ]) {
    calls.length = 0;
    r = await go();
    assert(r.statusCode === 200, `${label}: new buyer checkout opens (got ${r.statusCode} ${JSON.stringify(r.body)})`);
    assertNoCustomer(lastSession(), newbie, `${label} (new buyer)`);
  }
  const lead = (await sql`SELECT id, stage, stripe_customer_id FROM clients WHERE workspace_id = ${A.wid} AND email = ${newbie}`).rows;
  assert(lead.length === 1 && lead[0].stage === 'lead' && lead[0].stripe_customer_id === null, 'one lead row, and no Stripe customer linked to it before anyone has paid');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] webhooks still deliver; the autopay customer is untouched');
  // Stripe made a fresh customer for the subscription (never the saved one).
  const subId = `sub_pubco_${STAMP}`;
  const md = { workspace_id: A.wid, membership_id: tier.id, client_id: vic.id, purpose: 'membership' };
  r = await fire('customer.subscription.created', subObj(subId, tierPrice, { metadata: md, customer: `cus_fresh_${STAMP}` }), A.acct);
  assert(r.statusCode === 200 && r.body.result === 'created', `membership row created from the subscription event (got ${JSON.stringify(r.body)})`);
  r = await fire('customer.subscription.created', subObj(subId, tierPrice, { metadata: md, customer: `cus_fresh_${STAMP}` }), A.acct);
  r = await fire('checkout.session.completed', { id: `cs_pubco_sub_${STAMP}`, mode: 'subscription', payment_status: 'paid', subscription: subId, customer: `cus_fresh_${STAMP}`, customer_details: { email: vic.email }, metadata: md }, A.acct);
  const cms = (await sql`SELECT client_id, membership_id, status FROM client_memberships WHERE workspace_id = ${A.wid} AND client_id = ${vic.id}`).rows;
  assert(cms.length === 1 && cms[0].status === 'active' && cms[0].membership_id === tier.id, 'exactly one active membership for the client (no duplicate from repeated events)');
  assert(await cardUntouched(vic), "membership paid on a fresh customer: the client's autopay customer is NOT replaced");

  // Package: a one-time payment has no customer at all.
  r = await fire('checkout.session.completed', {
    id: `cs_pubco_pkg_${STAMP}`, mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: `pi_pubco_pkg_${STAMP}`, amount_total: 18000,
    customer: null, customer_details: { email: vic.email },
    metadata: { purpose: 'package', workspace_id: A.wid, package_id: pkg.id, client_id: vic.id },
  }, A.acct);
  const cps = (await sql`SELECT client_id, credits_remaining FROM client_packages WHERE workspace_id = ${A.wid}`).rows;
  assert(r.statusCode === 200 && cps.length === 1 && cps[0].client_id === vic.id && Number(cps[0].credits_remaining) === 5, `package delivered to the client with no customer on the session (got ${JSON.stringify(r.body)})`);

  // One-time program, also with no customer.
  r = await fire('checkout.session.completed', {
    id: `cs_pubco_prog_${STAMP}`, mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: `pi_pubco_prog_${STAMP}`, amount_total: 4900,
    customer: null, customer_details: { email: vic.email }, payment_method_types: ['card'],
    metadata: { purpose: 'program', workspace_id: A.wid, program_id: oneTime.id, client_id: vic.id },
  }, A.acct);
  let enr = (await sql`SELECT status FROM program_enrollments WHERE program_id = ${oneTime.id} AND client_id = ${vic.id}`).rows;
  assert(r.statusCode === 200 && enr.length === 1 && enr[0].status === 'active', `one-time program access granted with no customer on the session (got ${JSON.stringify(r.body)})`);

  // Subscription program on a fresh customer.
  const pMd = { workspace_id: A.wid, program_id: monthly.id, client_id: vic.id, purpose: 'program' };
  r = await fire('customer.subscription.created', subObj(`sub_pubco_prog_${STAMP}`, 'price_inline', { metadata: pMd, customer: `cus_fresh_prog_${STAMP}` }), A.acct);
  enr = (await sql`SELECT status FROM program_enrollments WHERE program_id = ${monthly.id} AND client_id = ${vic.id}`).rows;
  assert(r.statusCode === 200 && enr.length === 1 && enr[0].status === 'active', `subscription program access granted on a fresh customer (got ${JSON.stringify(r.body)})`);
  assert(await cardUntouched(vic), "after every purchase: the client's autopay customer and card are unchanged");

  // Own-keys business: the per-workspace webhook handles the completed session.
  const subL = `sub_pubco_legacy_${STAMP}`;
  const mdL = { workspace_id: L.wid, membership_id: tierL.id, client_id: vicL.id, purpose: 'membership' };
  const sessL = { id: `cs_pubco_legacy_${STAMP}`, mode: 'subscription', payment_status: 'paid', subscription: subL, customer: `cus_fresh_legacy_${STAMP}`, customer_details: { email: vicL.email }, metadata: mdL };
  r = await fireLegacy('checkout.session.completed', sessL, L.wid, L.whSecret);
  assert(r.statusCode === 200 && r.body.marked === 'membership-active', `own-keys business: membership created from the completed session (got ${JSON.stringify(r.body)})`);
  r = await fireLegacy('customer.subscription.created', subObj(subL, tierLPrice, { metadata: mdL, customer: `cus_fresh_legacy_${STAMP}` }), L.wid, L.whSecret);
  r = await fireLegacy('checkout.session.completed', sessL, L.wid, L.whSecret);
  assert((await sql`SELECT COUNT(*)::int n FROM client_memberships WHERE workspace_id = ${L.wid} AND client_id = ${vicL.id}`).rows[0].n === 1, 'own-keys business: exactly one membership after repeated events');
  assert(await cardUntouched(vicL), "own-keys business: a client who has an autopay customer keeps it");
  // A client with no customer yet takes the one Stripe made for the subscription.
  const plain = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${L.wid}, 'Pat Plain', ${`pubco-plain-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  r = await fireLegacy('checkout.session.completed', { ...sessL, id: `cs_pubco_legacy2_${STAMP}`, subscription: `sub_pubco_legacy2_${STAMP}`, customer: `cus_first_${STAMP}`, metadata: { ...mdL, client_id: plain } }, L.wid, L.whSecret);
  assert((await cardRow(plain)).stripe_customer_id === `cus_first_${STAMP}`, 'own-keys business: a client with no customer is linked to the one made at checkout');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] source guard');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Comments explain the rule in words; only code is checked.
  const code = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['api/memberships/checkout.js', 'api/packages/checkout.js', 'api/programs/checkout.js']) {
    const src = code(f);
    assert(!/findOrCreateCustomer|ensureStripeCustomer|stripe_customer_id|customerId|\bcustomer\s*:|['"]customer['"]/.test(src), `${f}: cannot attach, look up or link a Stripe customer`);
    assert(/customer_email|customerEmail/.test(src), `${f}: passes the typed email instead`);
  }
  // The shared membership session helper has no way to take a customer.
  calls.length = 0;
  await createMembershipCheckoutSession({
    secretKey: 'sk_test_pubco', stripeAccount: A.acct, priceId: tierPrice, customerId: vic.customerId, customerEmail: vic.email,
    workspaceId: A.wid, membershipId: tier.id, clientId: vic.id, successUrl: 'https://www.joinivy.ai/ok', cancelUrl: 'https://www.joinivy.ai/no',
  });
  cs = lastSession();
  assert(!('customer' in cs.body) && cs.body.customer_email === vic.email, 'membership session helper ignores a customer id even if one is passed');

  await sql.query('DELETE FROM workspaces WHERE id = ANY($1)', [[A.wid, L.wid]]);
  await sql.query('DELETE FROM users WHERE id = ANY($1)', [[A.uid, L.uid]]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

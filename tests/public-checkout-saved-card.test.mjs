// A purchase from a visitor still lands on the right client, exactly once.
//
// A public checkout (memberships, packages, programs) attaches a client's
// existing Stripe customer only when the request proves who is asking
// (api/_lib/checkoutIdentity.js, covered in checkout-identity.test.mjs).
// Everyone else pays as a guest: the session carries the typed email, and a
// subscription lands on a customer Stripe makes for it. This suite follows
// that purchase through to the client's record.
//
//   [1] a visitor types an existing client's email on each checkout: no
//       Stripe customer is looked up, created or attached; a client stored
//       with capital letters is matched by every checkout, packages included
//   [2] a first-time buyer: same, even when Stripe already has a customer
//       with that email
//   [3] the webhooks deliver the purchase to the right client when the
//       Stripe customer is one Checkout made (or none at all), exactly once
//   [4] one Stripe customer per client: a first-time buyer keeps the one
//       their subscription created; a client who already has one (saved
//       card, automatic payments) keeps theirs, on both webhooks
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/public-checkout-saved-card.test.mjs
import crypto from 'node:crypto';

process.env.STRIPE_SECRET_KEY = 'sk_test_public_checkout';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_public_checkout';
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { encrypt } from '../api/_lib/secrets.js';
import { rememberStripeCustomerIfNone } from '../api/_lib/clientResolve.js';
import membershipCheckout from '../api/memberships/checkout.js';
import packageCheckout from '../api/packages/checkout.js';
import programCheckout from '../api/programs/checkout.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const STAMP = Date.now();

// ── Stripe + mail mock ───────────────────────────────────────────────
// A customer lookup by email ANSWERS with the client's real customer (the
// one holding the saved card), the way Stripe would. The checkouts must
// never ask.
const VICTIM_CUS = `cus_victim_${STAMP}`;
const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) return json({ id: `em_${++seq}` });
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  calls.push({ url: u, method, body, headers: init.headers || {} });
  if (/\/v1\/customers\?/.test(u) && method === 'GET') return json({ data: [{ id: VICTIM_CUS, email: 'whoever@example.com' }] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: `cus_made_${++seq}`, email: body.email });
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
// Public checkouts are rate limited per IP per hour; a fresh base per run
// keeps repeated local runs from tripping it.
const IPB = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
let ipN = 0;
const post = (body) => ({
  method: 'POST', url: '/t', query: {}, body,
  headers: { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': `${IPB}.${1 + (ipN++ % 200)}`, 'user-agent': 'test' },
});
async function call(handler, r) { const res = mkRes(); res.req = r; await handler(r, res); return res; }

let evtN = 0;
function sign(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
}
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_pc_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': sign(payload, process.env.STRIPE_WEBHOOK_SECRET), 'content-type': 'application/json' } }, res);
  return res;
}
async function fireLegacy(type, object, workspaceId, secret) {
  const payload = JSON.stringify({ id: `evt_pcl_${STAMP}_${++evtN}`, type, data: { object } });
  const res = mkRes();
  await legacyWebhook({ method: 'POST', url: `/api/webhooks/stripe/${workspaceId}`, query: { workspaceId }, body: payload, headers: { 'stripe-signature': sign(payload, secret), 'content-type': 'application/json' } }, res);
  return res;
}
const subObj = (id, over = {}) => ({
  id, object: 'subscription', status: 'active', cancel_at_period_end: false,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ id: 'si_1', price: { id: 'price_x' } }] },
  ...over,
});

// ── fixtures ─────────────────────────────────────────────────────────
async function mkBiz(label, { legacySecret = null } = {}) {
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pc-${label}-${STAMP}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `pc-${label}-${STAMP}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}, slug = ${slug}`;
  const acct = `acct_pc_${label}_${STAMP}`;
  if (legacySecret) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted, currency)
      VALUES (${wid}, ${encrypt('sk_test_pc_legacy')}, ${encrypt(legacySecret)}, 'USD')`;
  } else {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  }
  const tier = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, stripe_price_id)
    VALUES (${wid}, 'Monthly Member', 4900, 'month', ${`price_pc_${label}_${STAMP}`}) RETURNING id, stripe_price_id`).rows[0];
  const pkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, active, visibility)
    VALUES (${wid}, 'Ten Pack', 10, 450, TRUE, 'public') RETURNING id`).rows[0];
  const once = (await sql`INSERT INTO programs (workspace_id, title, price_cents, billing, status)
    VALUES (${wid}, 'Eight Week Plan', 29900, 'one_time', 'published') RETURNING id`).rows[0];
  const monthly = (await sql`INSERT INTO programs (workspace_id, title, price_cents, billing, status)
    VALUES (${wid}, 'Coaching Club', 9900, 'month', 'published') RETURNING id`).rows[0];
  return { uid, wid, slug, acct, tier, pkg, once, monthly };
}
// An existing client with a card on file: their own Stripe customer, the
// saved payment method, the way the automatic payments flow leaves them.
async function mkClientWithCard(wid, email, customerId) {
  return (await sql`
    INSERT INTO clients (workspace_id, name, email, stage, stripe_customer_id,
                         payment_method_id, payment_method_brand, payment_method_last4, payment_method_exp_month, payment_method_exp_year)
    VALUES (${wid}, 'Avery Client', ${email}, 'active', ${customerId}, ${`pm_victim_${STAMP}`}, 'visa', '4242', 12, 2034)
    RETURNING id`).rows[0].id;
}
const clientRow = (id) => sql`SELECT * FROM clients WHERE id = ${id}`.then((r) => r.rows[0]);
const cardIntact = (c, customerId) => c.stripe_customer_id === customerId && c.payment_method_id === `pm_victim_${STAMP}` && c.payment_method_last4 === '4242';

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('alpha');
  const cleanupUsers = [A.uid];

  // The owner typed the client in with capitals; the visitor types lowercase.
  const victimEmail = `pc-avery-${STAMP}@example.com`;
  const victim = await mkClientWithCard(A.wid, victimEmail, VICTIM_CUS);
  const typed = { name: 'Not Avery', email: victimEmail };

  // What every public checkout session must look like.
  const checkSession = (label, cs, { email, clientId, acct }) => {
    assert(!!cs && cs.headers['Stripe-Account'] === acct, `${label}: session made on the business's connected account`);
    assert(!('customer' in cs.body), `${label}: NO existing Stripe customer attached to the session`);
    assert(cs.body.customer_email === email, `${label}: the session carries the typed email instead`);
    assert(!Object.keys(cs.body).some((k) => /^saved_payment_method_options|^customer_update|^customer_account/.test(k)), `${label}: nothing asks Checkout to show or reuse saved payment details`);
    assert(cs.body['metadata[client_id]'] === clientId && cs.body['metadata[workspace_id]'] === A.wid, `${label}: the client id still rides in the metadata for the webhook`);
  };

  // ════════════════════════════════════════════════════════════════════
  console.log("\n[1] a stranger types an existing client's email");
  const flows = [
    ['membership', membershipCheckout, { slug: A.slug, membershipId: A.tier.id }, 'subscription'],
    ['package', packageCheckout, { slug: A.slug, packageId: A.pkg.id }, 'payment'],
    ['program (one time)', programCheckout, { programId: A.once.id }, 'payment'],
    ['program (monthly)', programCheckout, { programId: A.monthly.id }, 'subscription'],
  ];
  for (const [label, handler, ids, mode] of flows) {
    calls.length = 0;
    const r = await call(handler, post({ ...ids, ...typed }));
    assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url), `${label}: checkout opens (got ${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
    assert(stripeCalls(/\/v1\/customers/).length === 0, `${label}: no Stripe customer looked up or created`);
    const cs = lastSession();
    checkSession(label, cs, { email: victimEmail, clientId: victim, acct: A.acct });
    assert(cs?.body.mode === mode, `${label}: ${mode} mode`);
    if (mode === 'subscription') assert(cs.body['subscription_data[metadata][client_id]'] === victim, `${label}: subscription metadata names the client`);
    else assert(cs.body['payment_intent_data[metadata][client_id]'] === victim, `${label}: payment metadata names the client`);
    assert(cardIntact(await clientRow(victim), VICTIM_CUS), `${label}: the client's own customer and saved card are untouched`);
  }
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${victimEmail}`).rows[0].n === 1, 'no second client row for that email');

  // A client the owner typed in with capitals buys from every checkout with
  // lowercase: always the same record, never a second one. (Packages used
  // to match the exact spelling only.)
  const mixed = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.wid}, 'Jamie Caps', ${`PC-Jamie-${STAMP}@Example.com`}, 'active') RETURNING id`).rows[0].id;
  const jamie = `pc-jamie-${STAMP}@example.com`;
  for (const [label, handler, ids] of flows) {
    calls.length = 0;
    const r = await call(handler, post({ ...ids, name: 'Jamie Caps', email: jamie }));
    assert(r.statusCode === 200 && lastSession()?.body['metadata[client_id]'] === mixed, `${label}: a client stored with capitals is matched`);
  }
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${jamie}`).rows[0].n === 1, 'still one client row for them');
  // Two records already exist for one address: the exact spelling is the
  // one a package went to before, so it still does.
  const exact = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.wid}, 'Jamie Lower', ${jamie}, 'active') RETURNING id`).rows[0].id;
  calls.length = 0;
  let rr = await call(packageCheckout, post({ slug: A.slug, packageId: A.pkg.id, name: 'Jamie', email: jamie }));
  assert(rr.statusCode === 200 && lastSession()?.body['metadata[client_id]'] === exact, 'package, two records for one address: the exact spelling wins');
  await sql`DELETE FROM clients WHERE id = ${exact}`;

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] a first-time buyer');
  const newEmail = `pc-newbie-${STAMP}@example.com`;
  for (const [label, handler, ids] of flows) {
    calls.length = 0;
    const r = await call(handler, post({ ...ids, name: 'New Buyer', email: newEmail }));
    const row = (await sql`SELECT * FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${newEmail}`).rows;
    assert(r.statusCode === 200 && row.length === 1 && row[0].stage === 'lead', `${label}: one lead client row for the new buyer`);
    assert(stripeCalls(/\/v1\/customers/).length === 0 && row[0].stripe_customer_id == null,
      `${label}: no customer lookup by email (Stripe would have answered with someone else's), none stored`);
    checkSession(label, lastSession(), { email: newEmail, clientId: row[0].id, acct: A.acct });
  }
  const newbie = (await sql`SELECT id FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${newEmail}`).rows[0].id;

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] the webhooks still deliver to the right client');
  // Package: a one-time payment by a guest has no Stripe customer at all.
  const pkgSession = { id: `cs_pc_pkg_${STAMP}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 45000,
    payment_intent: `pi_pc_pkg_${STAMP}`, customer: null, customer_details: { email: victimEmail },
    metadata: { purpose: 'package', workspace_id: A.wid, package_id: A.pkg.id, client_id: victim } };
  let r = await fire('checkout.session.completed', pkgSession, A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'package-provisioned', `package: provisioned with no Stripe customer on the session (${JSON.stringify(r.body)})`);
  r = await fire('checkout.session.completed', pkgSession, A.acct);
  const cps = (await sql`SELECT client_id, credits_remaining FROM client_packages WHERE workspace_id = ${A.wid} AND stripe_session_id = ${pkgSession.id}`).rows;
  assert(cps.length === 1 && cps[0].client_id === victim && Number(cps[0].credits_remaining) === 10, 'package: exactly one bundle, on the right client, after a repeat delivery');

  // Program, one time.
  const progSession = { id: `cs_pc_prog_${STAMP}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 29900,
    payment_intent: `pi_pc_prog_${STAMP}`, customer: null, payment_method_types: ['card'],
    metadata: { purpose: 'program', workspace_id: A.wid, program_id: A.once.id, client_id: victim } };
  r = await fire('checkout.session.completed', progSession, A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'program-purchase', `program: access granted with no Stripe customer on the session (${JSON.stringify(r.body)})`);
  r = await fire('checkout.session.completed', progSession, A.acct);
  assert((await sql`SELECT COUNT(*)::int n FROM program_enrollments WHERE program_id = ${A.once.id} AND client_id = ${victim}`).rows[0].n === 1, 'program: one enrollment after a repeat delivery');

  // Membership: the subscription sits on a customer Checkout made for it.
  const memMd = { workspace_id: A.wid, membership_id: A.tier.id, client_id: victim, purpose: 'membership' };
  const memSub = `sub_pc_mem_${STAMP}`;
  r = await fire('customer.subscription.created', subObj(memSub, { metadata: memMd, customer: `cus_guest_a_${STAMP}`, items: { data: [{ id: 'si_1', price: { id: A.tier.stripe_price_id } }] } }), A.acct);
  assert(r.statusCode === 200 && r.body.result === 'created', `membership: created from the subscription event (${JSON.stringify(r.body)})`);
  r = await fire('customer.subscription.created', subObj(memSub, { metadata: memMd, customer: `cus_guest_a_${STAMP}`, items: { data: [{ id: 'si_1', price: { id: A.tier.stripe_price_id } }] } }), A.acct);
  r = await fire('checkout.session.completed', { id: `cs_pc_mem_${STAMP}`, mode: 'subscription', payment_status: 'paid', subscription: memSub, customer: `cus_guest_a_${STAMP}`, metadata: memMd }, A.acct);
  const cms = (await sql`SELECT client_id, status FROM client_memberships WHERE workspace_id = ${A.wid} AND client_id = ${victim}`).rows;
  assert(cms.length === 1 && cms[0].status === 'active', 'membership: one active membership on the right client (repeat event and late checkout event add nothing)');

  // Program, monthly.
  const progMd = { workspace_id: A.wid, program_id: A.monthly.id, client_id: victim, purpose: 'program' };
  r = await fire('customer.subscription.created', subObj(`sub_pc_prog_${STAMP}`, { metadata: progMd, customer: `cus_guest_b_${STAMP}` }), A.acct);
  await settle();
  const en = (await sql`SELECT status, stripe_subscription_id FROM program_enrollments WHERE program_id = ${A.monthly.id} AND client_id = ${victim}`).rows;
  assert(r.statusCode === 200 && en.length === 1 && en[0].status === 'active' && en[0].stripe_subscription_id === `sub_pc_prog_${STAMP}`, `monthly program: enrolled from the subscription event (${JSON.stringify(r.body)})`);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] one Stripe customer per client');
  assert(cardIntact(await clientRow(victim), VICTIM_CUS), "a client with a card on file keeps their own customer: a public purchase's customer never replaces it");
  // The first-time buyer subscribes: the customer Checkout made becomes theirs.
  const newMd = { workspace_id: A.wid, membership_id: A.tier.id, client_id: newbie, purpose: 'membership' };
  r = await fire('customer.subscription.created', subObj(`sub_pc_new_${STAMP}`, { metadata: newMd, customer: `cus_first_${STAMP}`, items: { data: [{ id: 'si_1', price: { id: A.tier.stripe_price_id } }] } }), A.acct);
  assert((await clientRow(newbie)).stripe_customer_id === `cus_first_${STAMP}`, 'first-time buyer: remembers the customer their membership created');
  r = await fire('customer.subscription.created', subObj(`sub_pc_new2_${STAMP}`, { metadata: { ...progMd, client_id: newbie }, customer: `cus_second_${STAMP}` }), A.acct);
  assert((await clientRow(newbie)).stripe_customer_id === `cus_first_${STAMP}`, 'a later purchase on another customer does not replace it');
  // The helper itself.
  assert(await rememberStripeCustomerIfNone({ workspaceId: A.wid, clientId: victim, customerId: 'cus_other' }) === false, 'helper: refuses when the client already has a customer');
  const blank = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.wid}, 'Blank', ${`pc-blank-${STAMP}@example.com`}, 'lead') RETURNING id`).rows[0].id;
  const B = await mkBiz('beta');
  cleanupUsers.push(B.uid);
  assert(await rememberStripeCustomerIfNone({ workspaceId: B.wid, clientId: blank, customerId: 'cus_x' }) === false && (await clientRow(blank)).stripe_customer_id == null, "helper: never writes to another business's client");
  assert(await rememberStripeCustomerIfNone({ workspaceId: A.wid, clientId: blank, customerId: 'not-a-customer' }) === false, 'helper: ignores anything that is not a customer id');
  assert(await rememberStripeCustomerIfNone({ workspaceId: A.wid, clientId: blank, customerId: 'cus_x' }) === true && (await clientRow(blank)).stripe_customer_id === 'cus_x', 'helper: stores it for a client with none');

  // Legacy per-business webhook (owner pasted their own keys): same rule.
  const lSecret = `whsec_pc_legacy_${STAMP}`;
  const L = await mkBiz('legacy', { legacySecret: lSecret });
  cleanupUsers.push(L.uid);
  const lVictim = await mkClientWithCard(L.wid, `pc-legacy-${STAMP}@example.com`, `cus_lvictim_${STAMP}`);
  calls.length = 0;
  r = await call(membershipCheckout, post({ slug: L.slug, membershipId: L.tier.id, name: 'Not Them', email: `pc-legacy-${STAMP}@example.com` }));
  const lcs = lastSession();
  assert(r.statusCode === 200 && !('customer' in lcs.body) && lcs.body.customer_email === `pc-legacy-${STAMP}@example.com` && stripeCalls(/\/v1\/customers/).length === 0, 'legacy keys: membership checkout carries the email only');
  r = await fireLegacy('checkout.session.completed', { id: `cs_pc_lmem_${STAMP}`, mode: 'subscription', payment_status: 'paid', subscription: `sub_pc_lmem_${STAMP}`, customer: `cus_guest_l_${STAMP}`,
    metadata: { workspace_id: L.wid, membership_id: L.tier.id, client_id: lVictim, purpose: 'membership' } }, L.wid, lSecret);
  const lcm = (await sql`SELECT client_id FROM client_memberships WHERE stripe_subscription_id = ${`sub_pc_lmem_${STAMP}`}`).rows;
  assert(r.statusCode === 200 && lcm.length === 1 && lcm[0].client_id === lVictim, `legacy keys: membership lands on the right client (${JSON.stringify(r.body)})`);
  assert(cardIntact(await clientRow(lVictim), `cus_lvictim_${STAMP}`), 'legacy keys: the client keeps their own customer and saved card');

  // ── cleanup ─────────────────────────────────────────────────────────
  await settle();
  for (const uid of cleanupUsers) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });

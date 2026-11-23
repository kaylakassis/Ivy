// A stranger's checkout never gets a returning client's Stripe record.
//
// Stripe's hosted checkout, opened for an existing customer, prefills that
// customer's name, saved card and billing address and lets the visitor pay
// with the card. The public checkout forms only ask for a typed email.
//
//   [1] who counts as proven (api/_lib/checkoutIdentity.js)
//   [2] memberships, packages, programs: a typed email gets a clean checkout
//   [3] the client's own signed-in account still gets their customer
//   [4] booking: keeping a card on file never uses an existing customer for a visitor
//   [5] afterwards: the saved card and its customer are stored together
//   [6] wiring
//
// Run: node --import ./tests/bootstrap.mjs ./tests/checkout-identity.test.mjs
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
process.env.STRIPE_SECRET_KEY = 'sk_test_identity';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_identity';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { buyerIsSignedInAs } from '../api/_lib/checkoutIdentity.js';
import { cardOnFileCheckout } from '../api/_lib/bookingFees.js';
import { depositCardSetupForRequest } from '../api/_lib/bookingRequests.js';
import { createCheckoutSession, createSetupCheckoutSession } from '../api/_lib/stripe.js';
import membershipCheckout from '../api/memberships/checkout.js';
import packageCheckout from '../api/packages/checkout.js';
import programCheckout from '../api/programs/checkout.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'www.joinivy.ai';
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Stripe, faked: every call is recorded.
const calls = [];
let seq = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) return json({ id: 'em' });
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  calls.push({ url: u, method, body, headers: init.headers || {} });
  if (/\/v1\/customers\?/.test(u)) return json({ data: [] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: `cus_made_${++seq}`, email: body.email });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/${seq}`, customer: body.customer || null });
  if (/\/v1\/setup_intents\//.test(u)) return json({ id: u.split('/').pop(), payment_method: 'pm_fresh_card' });
  if (/\/v1\/payment_methods\//.test(u)) return json({ id: 'pm_fresh_card', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 } });
  return json({});
};
const sessions = () => calls.filter((c) => /\/v1\/checkout\/sessions$/.test(c.url) && c.method === 'POST');
const customerCalls = () => calls.filter((c) => /\/v1\/customers/.test(c.url));

function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
let ipN = 0;
const reqOf = ({ body, cookie, bearer } = {}) => ({
  method: 'POST', url: '/api/x', query: {}, body,
  headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', 'x-real-ip': `198.18.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`,
    ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
});
async function call(handler, opts) { const r = reqOf(opts); const res = mkRes(); res.req = r; await handler(r, res); return res; }
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;

async function main() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'mship:%' OR key LIKE 'pkg%' OR key LIKE 'prog%'`;

  // A business taking cards through Stripe, with a returning client who has a card on file.
  const owner = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ci-owner-${S}@example.com`}, 'x', 'Olive Owner', NOW()) RETURNING id`).rows[0].id;
  users.push(owner);
  const ws = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${owner}, 'Identity Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `ci-${S}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${ws}, 'Identity Studio', ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = EXCLUDED.biz_name, slug = EXCLUDED.slug`;
  const acct = `acct_ci_${S}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency) VALUES (${ws}, ${acct}, 'complete', 'USD')
    ON CONFLICT (workspace_id) DO UPDATE SET stripe_connect_user_id = EXCLUDED.stripe_connect_user_id, stripe_onboarding_status = 'complete'`;
  const victimEmail = `ci-victim-${S}@example.com`;
  const VICTIM_CUS = `cus_victim_${S}`;
  const victimUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${victimEmail}, 'x', 'Vera Victim', NOW()) RETURNING id`).rows[0].id;
  users.push(victimUser);
  const victim = (await sql`INSERT INTO clients (workspace_id, user_id, name, email, stage, stripe_customer_id, payment_method_id, payment_method_last4)
    VALUES (${ws}, ${victimUser}, 'Vera Victim', ${victimEmail}, 'active', ${VICTIM_CUS}, 'pm_veras_card', '1111') RETURNING id`).rows[0].id;
  const tier = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active, stripe_price_id) VALUES (${ws}, 'Monthly', 4900, 'month', TRUE, 'price_ci') RETURNING id`).rows[0].id;
  const pkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, active, visibility) VALUES (${ws}, 'Five pack', 5, 200, TRUE, 'public') RETURNING id`).rows[0].id;
  const prog = (await sql`INSERT INTO programs (workspace_id, title, status, price_cents, billing) VALUES (${ws}, 'Course', 'published', 9900, 'one_time') RETURNING id`).rows[0].id;
  const progSub = (await sql`INSERT INTO programs (workspace_id, title, status, price_cents, billing) VALUES (${ws}, 'Club', 'published', 1900, 'month') RETURNING id`).rows[0].id;

  console.log('\n[1] who counts as proven');
  const other = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ci-other-${S}@example.com`}, 'x', 'Otto Other', NOW()) RETURNING id`).rows[0].id;
  const unverified = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`ci-unverified-${S}@example.com`}, 'x', 'Una Unverified') RETURNING id`).rows[0].id;
  users.push(other, unverified);
  const rq = (cookie) => reqOf({ cookie });
  assert(await buyerIsSignedInAs(rq(cookieFor(victimUser)), victimEmail) === true, 'signed in, email confirmed, and it is their own email: proven');
  assert(await buyerIsSignedInAs(rq(cookieFor(victimUser)), victimEmail.toUpperCase()) === true, 'capital letters in the typed email make no difference');
  assert(await buyerIsSignedInAs(reqOf({ bearer: signSession(victimUser) }), victimEmail) === true, 'the iPhone app\'s sign-in counts the same way');
  assert(await buyerIsSignedInAs(rq(null), victimEmail) === false, 'not signed in: not proven, whatever is typed');
  assert(await buyerIsSignedInAs(rq(cookieFor(other)), victimEmail) === false, 'signed in as someone else: not proven');
  assert(await buyerIsSignedInAs(rq(cookieFor(unverified)), `ci-unverified-${S}@example.com`) === false, 'an account that never confirmed its email: not proven');
  assert(await buyerIsSignedInAs(rq('ivy_session=not-a-real-session'), victimEmail) === false && await buyerIsSignedInAs(rq(cookieFor(victimUser)), '') === false, 'a forged session or an empty email: not proven');
  await sql`UPDATE users SET password_changed_at = NOW() + INTERVAL '1 hour' WHERE id = ${other}`;
  assert(await buyerIsSignedInAs(rq(cookieFor(other)), `ci-other-${S}@example.com`) === false, 'a session from before a password change: not proven');
  await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${unverified}`;
  assert(await buyerIsSignedInAs(rq(cookieFor(unverified)), `ci-unverified-${S}@example.com`) === false, 'a deleted account: not proven');

  console.log('\n[2] a typed email gets a clean checkout');
  const flows = [
    ['membership', membershipCheckout, { slug, membershipId: tier, name: 'Someone Else', email: victimEmail }],
    ['package', packageCheckout, { slug, packageId: pkg, name: 'Someone Else', email: victimEmail }],
    ['program (one payment)', programCheckout, { programId: prog, name: 'Someone Else', email: victimEmail }],
    ['program (subscription)', programCheckout, { programId: progSub, name: 'Someone Else', email: victimEmail }],
  ];
  for (const [label, handler, body] of flows) {
    calls.length = 0;
    const r = await call(handler, { body });
    const cs = sessions().at(-1);
    assert(r.statusCode === 200 && cs && !('customer' in cs.body) && cs.body.customer_email === victimEmail && !JSON.stringify(cs.body).includes(VICTIM_CUS),
      `${label}: a stranger typing the client's email gets no Stripe customer on the checkout (${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
    assert(customerCalls().length === 0, `${label}: and Stripe is not even asked about that customer`);
    assert(cs.body['metadata[client_id]'] === victim, `${label}: the purchase is still tied to the right client, by client id`);
  }
  const still = (await sql`SELECT stripe_customer_id, payment_method_id FROM clients WHERE id = ${victim}`).rows[0];
  assert(still.stripe_customer_id === VICTIM_CUS && still.payment_method_id === 'pm_veras_card', 'the client\'s own Stripe record and saved card are untouched by any of it');
  calls.length = 0;
  const newEmail = `ci-new-${S}@example.com`;
  let r = await call(membershipCheckout, { body: { slug, membershipId: tier, name: 'Nia New', email: newEmail } });
  const made = (await sql`SELECT id, stripe_customer_id FROM clients WHERE workspace_id = ${ws} AND email = ${newEmail}`).rows[0];
  assert(r.statusCode === 200 && made && made.stripe_customer_id === null && customerCalls().length === 0 && sessions().at(-1).body.customer_email === newEmail,
    'a brand-new buyer: a client is created, and no Stripe customer is made until they actually pay');
  calls.length = 0;
  r = await call(membershipCheckout, { body: { slug, membershipId: tier, name: 'Otto', email: victimEmail }, cookie: cookieFor(other) });
  assert(r.statusCode === 200 && !('customer' in sessions().at(-1).body), 'signed in as a different person and typing the client\'s email: still clean');

  console.log('\n[3] the client\'s own signed-in account');
  for (const [label, handler, body] of flows) {
    calls.length = 0;
    r = await call(handler, { body, cookie: cookieFor(victimUser) });
    const cs = sessions().at(-1);
    assert(r.statusCode === 200 && cs?.body.customer === VICTIM_CUS && !('customer_email' in cs.body), `${label}: their own checkout carries their own Stripe customer (saved card offered to its owner)`);
  }
  calls.length = 0;
  const fresh = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${newEmail}, 'x', 'Nia New', NOW()) RETURNING id`).rows[0].id;
  users.push(fresh);
  r = await call(packageCheckout, { body: { slug, packageId: pkg, name: 'Nia New', email: newEmail }, cookie: cookieFor(fresh) });
  const linked = (await sql`SELECT stripe_customer_id FROM clients WHERE id = ${made.id}`).rows[0].stripe_customer_id;
  assert(r.statusCode === 200 && /^cus_made_/.test(linked) && sessions().at(-1).body.customer === linked, 'signed in with no Stripe customer yet: one is made for them and remembered');

  console.log('\n[4] booking: keeping a card on file');
  const svc = { cancellation_fee_amount: 25, no_show_fee_amount: 0 };
  const noCard = (await sql`INSERT INTO clients (workspace_id, name, email, stage, stripe_customer_id) VALUES (${ws}, 'Rae Returning', ${`ci-rae-${S}@example.com`}, 'active', ${`cus_rae_${S}`}) RETURNING id`).rows[0].id;
  calls.length = 0;
  let keep = await cardOnFileCheckout({ workspaceId: ws, clientId: noCard, service: svc, mode: 'customer' });
  assert(keep && keep.newCustomer === true && !keep.customerId && calls.length === 0, 'deposit for a visitor: the card will go on a new customer; the client\'s existing one is not used or looked up');
  keep = await cardOnFileCheckout({ workspaceId: ws, clientId: noCard, service: svc, mode: 'customer', trusted: true });
  assert(keep?.customerId === `cus_rae_${S}`, 'deposit for the client\'s own signed-in account: their existing customer');
  assert(await cardOnFileCheckout({ workspaceId: ws, clientId: victim, service: svc, mode: 'customer' }) === null, 'a client who already has a card on file is never offered a replacement from a public form');
  calls.length = 0;
  await createCheckoutSession({ secretKey: 'sk_test_identity', stripeAccount: acct, invoice: { id: 'bookdep_x', number: 'Deposit', workspace_id: ws, client_id: noCard }, currency: 'USD', totalCents: 2000,
    successUrl: 'https://x/ok', cancelUrl: 'https://x/no', customerEmail: `ci-rae-${S}@example.com`, saveCard: true, newCustomer: true });
  let b = sessions().at(-1).body;
  assert(!('customer' in b) && b.customer_creation === 'always' && b.customer_email === `ci-rae-${S}@example.com` && b['payment_intent_data[setup_future_usage]'] === 'off_session' && b['metadata[client_id]'] === noCard,
    'the deposit page then makes its own new customer and keeps the card on it');
  calls.length = 0;
  const setup = await cardOnFileCheckout({ workspaceId: ws, clientId: noCard, service: svc, mode: 'setup', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  b = sessions().at(-1).body;
  assert(setup?.url && b.mode === 'setup' && !('customer' in b) && b.customer_creation === 'always' && b.customer_email === `ci-rae-${S}@example.com` && customerCalls().length === 0,
    'the "save a card, no charge" page for a visitor is not opened on the existing customer either');
  calls.length = 0;
  await cardOnFileCheckout({ workspaceId: ws, clientId: noCard, service: svc, mode: 'setup', trusted: true, successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  assert(sessions().at(-1).body.customer === `cus_rae_${S}`, 'for their own signed-in account it is');
  calls.length = 0;
  const reqUrl = await depositCardSetupForRequest({ workspaceId: ws, clientId: noCard, bookingId: null, successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  b = sessions().at(-1).body;
  assert(reqUrl && !('customer' in b) && b.customer_creation === 'always', 'same for a booking request waiting on the owner\'s approval');
  let threw = false; try { await createSetupCheckoutSession({ secretKey: 'sk', workspaceId: ws, clientId: noCard }); } catch { threw = true; }
  assert(threw, 'a card page with neither a customer nor an email is refused');

  console.log('\n[5] afterwards: the card and its customer are stored together');
  const payload = JSON.stringify({ id: `evt_ci_${S}`, type: 'checkout.session.completed', account: acct, data: { object: {
    id: `cs_setup_${S}`, mode: 'setup', setup_intent: `seti_${S}`, customer: `cus_fresh_${S}`,
    metadata: { purpose: 'save_card', workspace_id: ws, client_id: noCard } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  const after = (await sql`SELECT stripe_customer_id, payment_method_id, payment_method_last4 FROM clients WHERE id = ${noCard}`).rows[0];
  assert(res.statusCode === 200 && after.payment_method_id === 'pm_fresh_card' && after.payment_method_last4 === '4242' && after.stripe_customer_id === `cus_fresh_${S}`,
    `a card saved on a new customer is recorded with that customer, so a later fee charges the right pair (${JSON.stringify(res.body)})`);

  console.log('\n[6] wiring');
  const booking = read('api/calendar/public/[slug].js');
  assert((booking.match(/trusted: await buyerIsSignedInAs\(req, clientEmail\)/g) || []).length === 3, 'all three card-on-file paths in the public booking form ask who is really there');
  assert(/keep\?\.newCustomer \? \{ newCustomer: true, saveCard: true \}/.test(booking), 'and the deposit checkout uses a new customer for a visitor');
  for (const p of ['api/memberships/checkout.js', 'api/packages/checkout.js', 'api/programs/checkout.js']) {
    const src = read(p);
    assert(/const trusted = await buyerIsSignedInAs\(req, buyerEmail\);\s*if \(!trusted\) stripeCustomerId = null;\s*if \(trusted && !stripeCustomerId\)/.test(src), `${p.split('/')[1]}: an existing customer is dropped unless the buyer is proven`);
  }
  const perWs = read('api/webhooks/stripe/[workspaceId].js'); const plat = read('api/webhooks/stripe-platform.js');
  assert(/stripe_customer_id = COALESCE\(\$\{setupCustomer\}, stripe_customer_id\)/.test(perWs) && /stripe_customer_id = COALESCE\(\$\{setupCustomer\}, stripe_customer_id\)/.test(plat), 'both payment webhooks store the saved card together with its customer');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

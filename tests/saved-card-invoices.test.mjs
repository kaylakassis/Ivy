// Saved card for repeat invoices (Stripe Connect, direct charges on the
// connected account). Stripe's HTTP API is mocked at globalThis.fetch.
//
//   [1] "Save this card" on the public checkout → Checkout session carries
//       customer + payment_intent_data[setup_future_usage]=off_session
//   [2] the paid webhook stores ONLY ids + brand/last4/expiry on the clients row
//   [3] a second invoice from the same business offers the saved card
//   [4] one-tap pay charges off-session and marks paid through the shared
//       fulfilment path (receipt + owner notification identical)
//   [5] requires_action falls back to a normal Checkout
//   [6] a different business never sees the card
//   [7] "Remove saved card" detaches it and the next invoice offers nothing
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/saved-card-invoices.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_saved_card';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_saved_card';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import payHandler from '../api/invoice-pay/[token].js';
import viewHandler from '../api/invoice-view/[token].js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import removeCardHandler from '../api/me/payment-methods/[clientId].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Stripe + Resend mock ──
const stripeCalls = [];
const emails = [];
let offSessionMode = 'succeed'; // 'succeed' | 'auth_required'
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';
  const body = init.body ? String(init.body) : '';
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(body)); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  stripeCalls.push({ url: u, method, body, headers: init.headers || {} });
  const params = new URLSearchParams(body);
  if (/\/v1\/customers\?email=/.test(u)) return json({ object: 'list', data: [] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: 'cus_saved_1', email: params.get('email') });
  if (/\/v1\/customers\/cus_saved_1$/.test(u) && method === 'POST') return json({ id: 'cus_saved_1' });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${stripeCalls.length}`, url: 'https://checkout.stripe.com/c/pay/cs_test' });
  if (/\/v1\/payment_intents\/pi_saved_1$/.test(u)) return json({ id: 'pi_saved_1', payment_method: 'pm_saved_1', setup_future_usage: 'off_session', customer: 'cus_saved_1' });
  if (/\/v1\/payment_methods\/pm_saved_1$/.test(u) && method === 'GET') return json({ id: 'pm_saved_1', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031, fingerprint: 'SHOULD_NOT_BE_STORED', number: '4242424242424242' } });
  if (/\/v1\/payment_methods\/pm_saved_1\/detach$/.test(u)) return json({ id: 'pm_saved_1', customer: null });
  if (/\/v1\/payment_intents$/.test(u) && method === 'POST') {
    if (offSessionMode === 'auth_required') {
      return json({ error: { code: 'authentication_required', message: 'Your card was declined. This transaction requires authentication.', payment_intent: { id: 'pi_needs_auth', status: 'requires_action' } } }, 402);
    }
    return json({
      id: 'pi_offsession_1', status: 'succeeded', amount: Number(params.get('amount')), amount_received: Number(params.get('amount')),
      customer: params.get('customer'), payment_method: params.get('payment_method'),
      metadata: { invoice_id: params.get('metadata[invoice_id]'), workspace_id: params.get('metadata[workspace_id]'), client_id: params.get('metadata[client_id]') },
      payment_method_types: ['card'],
    });
  }
  return json({});
};

// Receipts are fire-and-forget inside markInvoicePaid; give them a beat.
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const hdrs = (extra = {}) => ({ host: 'www.joinivy.ai', origin: 'https://www.joinivy.ai', 'user-agent': 'test', 'x-forwarded-for': '198.18.2.2', ...extra });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}
async function pay(token, body) {
  const res = mkRes();
  await payHandler({ method: 'POST', headers: hdrs({ 'content-type': 'application/json' }), query: { token }, body }, res);
  return res;
}
async function view(token) {
  const res = mkRes();
  await viewHandler({ method: 'GET', headers: hdrs(), query: { token } }, res);
  return res;
}

async function run() {
  await ensureSchemaApplied();
  const tag = `sc-${Date.now()}`;
  const acct = `acct_${tag}`;
  const ownerA = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${tag}-a@example.com`}, 'x', 'Owner A', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const widA = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${ownerA}, 'Studio A', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${widA}, 'Studio A', ${`studio-a-${Date.now()}`})`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, payment_provider)
    VALUES (${widA}, ${acct}, 'complete', 'stripe')`;
  const clientEmail = `${tag}-client@example.com`;
  const clientUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${clientEmail}, 'x', 'Casey Client', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const clientA = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${widA}, 'Casey Client', ${clientEmail}, 'active', ${clientUser}) RETURNING id`).rows[0].id;

  const mkInvoice = async (wid, cid, number, amount) => {
    const raw = crypto.randomBytes(24).toString('hex');
    const id = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount, view_token_hash, sent_at)
      VALUES (${wid}, ${cid}, 'Casey Client', ${clientEmail}, ${number}, 'sent', ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, ${sha(raw)}, NOW())
      RETURNING id`).rows[0].id;
    return { id, raw };
  };

  console.log('\n[1] first invoice: "save this card" shapes the Checkout session');
  const inv1 = await mkInvoice(widA, clientA, 'INV-SC-1', 120);
  let v = await view(inv1.raw);
  assert(v.statusCode === 200 && v.body.invoice.savedCard === null, 'no saved card yet on the first invoice');
  assert(v.body.invoice.canSaveCard === true, 'the client may save a card (Stripe workspace, known client)');
  stripeCalls.length = 0;
  let r = await pay(inv1.raw, { saveCard: true });
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body?.url || ''), `checkout url returned (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const cs = stripeCalls.find((c) => /checkout\/sessions$/.test(c.url));
  const csParams = new URLSearchParams(cs?.body || '');
  assert(cs?.headers?.['Stripe-Account'] === acct, 'session is created ON the connected account (direct charge)');
  assert(csParams.get('customer') === 'cus_saved_1', 'session is tied to a Customer on the connected account');
  assert(csParams.get('payment_intent_data[setup_future_usage]') === 'off_session', 'payment_intent_data[setup_future_usage]=off_session');
  assert(csParams.get('metadata[save_card]') === '1' && csParams.get('metadata[client_id]') === clientA, 'save_card + client_id in session metadata');
  assert(!csParams.has('customer_email'), 'customer_email is dropped when a customer is set (Stripe rejects both)');
  const custCreate = stripeCalls.find((c) => /\/v1\/customers$/.test(c.url) && c.method === 'POST');
  assert(new URLSearchParams(custCreate?.body || '').get('email') === clientEmail, 'Customer keyed to the client email in this workspace');
  const client1 = (await sql`SELECT stripe_customer_id, payment_method_id FROM clients WHERE id = ${clientA}`).rows[0];
  assert(client1.stripe_customer_id === 'cus_saved_1' && !client1.payment_method_id, 'customer id persisted; no card yet');

  console.log('\n[2] paid webhook stores only ids + brand/last4/expiry');
  emails.length = 0;
  let w = mkRes();
  await platformWebhook(signedWebhook({
    id: `evt_${tag}_1`, type: 'checkout.session.completed', account: acct,
    data: { object: { id: cs ? `cs_${stripeCalls.indexOf(cs) + 1}` : 'cs_1', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 12000,
      payment_intent: 'pi_saved_1', customer: 'cus_saved_1', payment_method_types: ['card', 'us_bank_account'],
      metadata: { invoice_id: inv1.id, workspace_id: widA, save_card: '1', client_id: clientA } } },
  }), w);
  assert(w.statusCode === 200 && w.body?.result === 'paid', `webhook marks invoice paid (got ${JSON.stringify(w.body)})`);
  const inv1Row = (await sql`SELECT status, paid_method, stripe_payment_intent FROM invoices WHERE id = ${inv1.id}`).rows[0];
  assert(inv1Row.status === 'paid' && inv1Row.paid_method === 'card' && inv1Row.stripe_payment_intent === 'pi_saved_1', 'invoice paid by card with the PI recorded');
  const clientRow = (await sql`SELECT * FROM clients WHERE id = ${clientA}`).rows[0];
  assert(clientRow.payment_method_id === 'pm_saved_1' && clientRow.stripe_customer_id === 'cus_saved_1', 'payment method id + customer id stored');
  assert(clientRow.payment_method_brand === 'visa' && clientRow.payment_method_last4 === '4242', 'brand + last4 stored');
  assert(clientRow.payment_method_exp_month === 12 && clientRow.payment_method_exp_year === 2031, 'expiry stored');
  const rowJson = JSON.stringify(clientRow);
  assert(!/4242424242424242|SHOULD_NOT_BE_STORED/.test(rowJson), 'no card number or fingerprint anywhere on the row');
  await settle();
  const receipt = emails.find((e) => /Receipt: invoice INV-SC-1/.test(e.subject || ''));
  assert(!!receipt, 'client receipt email went out via the shared paid path');

  console.log('\n[3] a second invoice from the same business offers the saved card');
  const inv2 = await mkInvoice(widA, clientA, 'INV-SC-2', 80);
  v = await view(inv2.raw);
  assert(v.body?.invoice?.savedCard?.brand === 'visa' && v.body.invoice.savedCard.last4 === '4242', 'public invoice shows Visa •••• 4242');
  assert(!/pm_saved_1|cus_saved_1/.test(JSON.stringify(v.body)), 'Stripe ids never reach the public payload');

  console.log('\n[4] one tap: off-session charge → paid through the same fulfilment path');
  stripeCalls.length = 0; emails.length = 0;
  r = await pay(inv2.raw, { useSavedCard: true });
  assert(r.statusCode === 200 && r.body?.paid === true, `paid:true (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const piCall = stripeCalls.find((c) => /\/v1\/payment_intents$/.test(c.url));
  const piParams = new URLSearchParams(piCall?.body || '');
  assert(piCall?.headers?.['Stripe-Account'] === acct, 'PaymentIntent created on the connected account');
  assert(piParams.get('off_session') === 'true' && piParams.get('confirm') === 'true', 'confirmed off-session');
  assert(piParams.get('customer') === 'cus_saved_1' && piParams.get('payment_method') === 'pm_saved_1', 'uses the saved customer + payment method');
  assert(piParams.get('amount') === '8000' && piParams.get('metadata[invoice_id]') === inv2.id, 'charges the invoice amount with invoice metadata');
  assert(!!piCall?.headers?.['Idempotency-Key'], 'Idempotency-Key set so a double tap cannot double charge');
  const inv2Row = (await sql`SELECT status, paid_method, paid_amount, stripe_payment_intent, view_token_hash FROM invoices WHERE id = ${inv2.id}`).rows[0];
  assert(inv2Row.status === 'paid' && Number(inv2Row.paid_amount) === 80 && inv2Row.stripe_payment_intent === 'pi_offsession_1', 'invoice marked paid with the off-session PI');
  assert(inv2Row.view_token_hash === null, 'pay link consumed like a Checkout payment');
  await settle();
  assert(emails.some((e) => /Receipt: invoice INV-SC-2/.test(e.subject || '')), 'same receipt email as a Checkout payment');
  v = await view(inv2.raw);
  assert(v.statusCode === 404, 'paid invoice link is no longer active');

  console.log('\n[5] requires_action falls back to the normal Checkout');
  const inv3 = await mkInvoice(widA, clientA, 'INV-SC-3', 50);
  offSessionMode = 'auth_required';
  stripeCalls.length = 0;
  r = await pay(inv3.raw, { useSavedCard: true });
  offSessionMode = 'succeed';
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body?.url || '') && r.body?.fallback === 'requires_action', `falls back to a Checkout url (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const fallbackCs = stripeCalls.find((c) => /checkout\/sessions$/.test(c.url));
  assert(new URLSearchParams(fallbackCs?.body || '').get('customer') === 'cus_saved_1', 'fallback Checkout reuses the same Customer');
  const inv3Row = (await sql`SELECT status FROM invoices WHERE id = ${inv3.id}`).rows[0];
  assert(inv3Row.status === 'sent', 'invoice stays unpaid until Checkout completes');

  console.log('\n[6] a different business never sees the card');
  const ownerB = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${tag}-b@example.com`}, 'x', 'Owner B', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const widB = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${ownerB}, 'Studio B', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${widB}, 'Studio B', ${`studio-b-${Date.now()}`})`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, payment_provider)
    VALUES (${widB}, ${`acct_b_${tag}`}, 'complete', 'stripe')`;
  const clientB = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${widB}, 'Casey Client', ${clientEmail}, 'active', ${clientUser}) RETURNING id`).rows[0].id;
  const invB = await mkInvoice(widB, clientB, 'INV-B-1', 40);
  v = await view(invB.raw);
  assert(v.statusCode === 200 && v.body.invoice.savedCard === null, 'Studio B invoice shows no saved card for the same email');
  r = await pay(invB.raw, { useSavedCard: true });
  assert(r.statusCode === 400, `Studio B cannot charge the Studio A card (got ${r.statusCode})`);
  assert((await sql`SELECT status FROM invoices WHERE id = ${invB.id}`).rows[0].status === 'sent', 'Studio B invoice untouched');

  console.log('\n[7] Remove saved card (portal → Profile → Payment methods)');
  stripeCalls.length = 0;
  w = mkRes();
  await removeCardHandler({ method: 'DELETE', headers: hdrs({ cookie: `ivy_session=${signSession(clientUser)}` }), query: { clientId: clientA } }, w);
  assert(w.statusCode === 204, `DELETE /api/me/payment-methods/:clientId → 204 (got ${w.statusCode})`);
  assert(stripeCalls.some((c) => /pm_saved_1\/detach$/.test(c.url) && c.headers?.['Stripe-Account'] === acct), 'payment method detached on the connected account');
  const cleared = (await sql`SELECT payment_method_id, payment_method_brand, payment_method_last4 FROM clients WHERE id = ${clientA}`).rows[0];
  assert(!cleared.payment_method_id && !cleared.payment_method_brand && !cleared.payment_method_last4, 'card fragments wiped from the clients row');
  v = await view(inv3.raw);
  assert(v.body?.invoice?.savedCard === null, 'the open invoice no longer offers a saved card');
  r = await pay(inv3.raw, { useSavedCard: true });
  assert(r.statusCode === 400, 'one-tap pay refused once the card is removed');

  await sql`DELETE FROM workspaces WHERE id IN (${widA}, ${widB})`;
  await sql`DELETE FROM users WHERE id IN (${ownerA}, ${ownerB}, ${clientUser})`;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

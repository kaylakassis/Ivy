// A saved card never shows up on a Stripe payment page.
//
// Checked against Stripe in test mode: a card saved through Checkout in
// setup mode (automatic payments, the portal's "save a card", the booking
// page's card on file) comes back marked allow_redisplay=always, and a
// payment page offers such a card ("Pay with .... 4242", one click, no card
// number or security code) to whoever opened a checkout with that customer
// attached. Marked "limited" the card is not offered, and off-session
// charges on it still succeed.
//
//   [1] hideCardFromCheckout: tells Stripe "limited", on the right account,
//       skips the call when there is nothing to change, never throws
//   [2] every setup-mode save turns the card to "limited": the platform
//       webhook and the legacy per-business webhook (the automatic payments
//       return is covered in recurring-autopay.test.mjs)
//   [3] a deposit checkout for someone who is not signed in keeps the card
//       on a NEW customer: no existing customer on the session
//   [4] the one-off sweep over cards saved before this: a dry run changes
//       nothing, --apply changes only what needs it, one business at a time
//   [5] the code paths cannot quietly go back
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/saved-card-redisplay.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STRIPE_SECRET_KEY = 'sk_test_redisplay';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_redisplay';
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { encrypt } from '../api/_lib/secrets.js';
import { hideCardFromCheckout, listCustomerCards, createCheckoutSession } from '../api/_lib/stripe.js';
import { hideSavedCardsForWorkspace } from '../api/_lib/savedCards.js';
import { cardOnFileCheckout } from '../api/_lib/bookingFees.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const STAMP = Date.now();

// ── Stripe mock: a tiny card store ───────────────────────────────────
// cards: pm id → { customer, allow_redisplay, brand, last4 }. An update
// really changes the stored value, so a second look sees it.
const cards = new Map();
const failUpdate = new Set();   // pm ids whose update Stripe refuses
const goneCustomers = new Set(); // customers deleted in Stripe
const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const pmObj = (id) => { const c = cards.get(id); return { id, object: 'payment_method', type: 'card', customer: c.customer, allow_redisplay: c.allow_redisplay, card: { brand: c.brand, last4: c.last4, exp_month: 12, exp_year: 2034 } }; };
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (!/api\.stripe\.com/.test(u)) return json({ id: `x_${++seq}` });
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  calls.push({ url: u, method, body, headers: init.headers || {} });
  let m;
  if ((m = u.match(/\/v1\/customers\/([^/?]+)\/payment_methods/))) {
    if (goneCustomers.has(m[1])) return json({ error: { message: 'No such customer' } }, 404);
    return json({ data: [...cards.keys()].filter((id) => cards.get(id).customer === m[1]).map(pmObj) });
  }
  if ((m = u.match(/\/v1\/payment_methods\/([^/?]+)$/))) {
    if (!cards.has(m[1])) return json({ error: { message: 'No such payment_method' } }, 404);
    if (method === 'POST') {
      if (failUpdate.has(m[1])) return json({ error: { message: 'Stripe is having a moment' } }, 500);
      if (body.allow_redisplay) cards.get(m[1]).allow_redisplay = body.allow_redisplay;
    }
    return json(pmObj(m[1]));
  }
  if ((m = u.match(/\/v1\/setup_intents\/([^/?]+)$/))) return json({ id: m[1], status: 'succeeded', payment_method: m[1].replace(/^seti_/, 'pm_') });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/pay/cs_${seq}` });
  if (/\/v1\/customers/.test(u)) return json({ id: `cus_made_${++seq}`, data: [] });
  return json({});
};
const updates = (pm) => calls.filter((c) => c.method === 'POST' && new RegExp(`/v1/payment_methods/${pm}$`).test(c.url));
const addCard = (id, customer, allow = 'always', last4 = '4242') => cards.set(id, { customer, allow_redisplay: allow, brand: 'visa', last4 });

// ── helpers ──────────────────────────────────────────────────────────
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
let evtN = 0;
function sign(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
}
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_rd_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': sign(payload, process.env.STRIPE_WEBHOOK_SECRET), 'content-type': 'application/json' } }, res);
  return res;
}
async function fireLegacy(type, object, workspaceId, secret) {
  const payload = JSON.stringify({ id: `evt_rdl_${STAMP}_${++evtN}`, type, data: { object } });
  const res = mkRes();
  await legacyWebhook({ method: 'POST', url: `/api/webhooks/stripe/${workspaceId}`, query: { workspaceId }, body: payload, headers: { 'stripe-signature': sign(payload, secret), 'content-type': 'application/json' } }, res);
  return res;
}
async function mkBiz(label, { legacySecret = null } = {}) {
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`rd-${label}-${STAMP}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const acct = `acct_rd_${label}_${STAMP}`;
  if (legacySecret) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted, currency)
      VALUES (${wid}, ${encrypt('sk_test_rd_legacy')}, ${encrypt(legacySecret)}, 'USD')`;
  } else {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  }
  return { uid, wid, acct };
}
const mkClient = (wid, label, customerId = null, pm = null) => sql`
  INSERT INTO clients (workspace_id, name, email, stage, stripe_customer_id, payment_method_id)
  VALUES (${wid}, ${label}, ${`rd-${label}-${STAMP}@example.com`.toLowerCase()}, 'active', ${customerId}, ${pm}) RETURNING id`.then((r) => r.rows[0].id);
const clientRow = (id) => sql`SELECT * FROM clients WHERE id = ${id}`.then((r) => r.rows[0]);

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('alpha');
  const B = await mkBiz('beta');
  const cleanupUsers = [A.uid, B.uid];
  const KEY = 'sk_test_redisplay';

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] hideCardFromCheckout');
  addCard('pm_h1', 'cus_h');
  calls.length = 0;
  let ok = await hideCardFromCheckout({ secretKey: KEY, stripeAccount: A.acct, paymentMethodId: 'pm_h1' });
  let up = updates('pm_h1');
  assert(ok === true && up.length === 1 && up[0].body.allow_redisplay === 'limited' && Object.keys(up[0].body).length === 1, 'tells Stripe allow_redisplay=limited, and nothing else about the card');
  assert(up[0].headers['Stripe-Account'] === A.acct && up[0].headers.Authorization === `Bearer ${KEY}`, "on the business's connected account");
  assert(cards.get('pm_h1').allow_redisplay === 'limited', 'the card is limited afterwards');
  calls.length = 0;
  ok = await hideCardFromCheckout({ secretKey: KEY, stripeAccount: A.acct, paymentMethodId: 'pm_h1', paymentMethod: { id: 'pm_h1', allow_redisplay: 'limited' } });
  assert(ok === true && calls.length === 0, 'already limited: no call made');
  addCard('pm_h2', 'cus_h', 'unspecified');
  ok = await hideCardFromCheckout({ secretKey: KEY, stripeAccount: A.acct, paymentMethod: { id: 'pm_h2', allow_redisplay: 'unspecified' } });
  assert(ok === true && cards.get('pm_h2').allow_redisplay === 'limited', 'an unspecified card is limited too (takes the id from the object)');
  addCard('pm_h3', 'cus_h');
  failUpdate.add('pm_h3');
  let threw = false;
  try { ok = await hideCardFromCheckout({ secretKey: KEY, stripeAccount: A.acct, paymentMethodId: 'pm_h3' }); } catch { threw = true; }
  assert(!threw && ok === false, 'Stripe refuses: reports false, never throws (saving the card must not fail over this)');
  assert(await hideCardFromCheckout({ secretKey: KEY, stripeAccount: A.acct }) === false, 'no card id: false');
  const listed = await listCustomerCards({ secretKey: KEY, stripeAccount: A.acct, customerId: 'cus_h' });
  assert(listed.length === 3 && calls.at(-1).url.includes('/v1/customers/cus_h/payment_methods?type=card&limit=100'), 'listCustomerCards reads the customer\'s cards');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] a card saved in setup mode is limited as it is stored');
  const pat = await mkClient(A.wid, 'pat', `cus_pat_${STAMP}`);
  addCard(`pm_pat_${STAMP}`, `cus_pat_${STAMP}`, 'always', '1111');
  calls.length = 0;
  let r = await fire('checkout.session.completed', {
    id: `cs_rd_setup_${STAMP}`, mode: 'setup', status: 'complete', setup_intent: `seti_pat_${STAMP}`, customer: `cus_pat_${STAMP}`,
    metadata: { purpose: 'save_card', workspace_id: A.wid, client_id: pat },
  }, A.acct);
  up = updates(`pm_pat_${STAMP}`);
  assert(r.statusCode === 200 && r.body.marked === 'card-saved', `platform webhook stores the card (${JSON.stringify(r.body)})`);
  assert(up.length === 1 && up[0].body.allow_redisplay === 'limited' && up[0].headers['Stripe-Account'] === A.acct, 'platform webhook: the card is turned to limited on the connected account');
  assert(cards.get(`pm_pat_${STAMP}`).allow_redisplay === 'limited' && (await clientRow(pat)).payment_method_id === `pm_pat_${STAMP}` && (await clientRow(pat)).payment_method_last4 === '1111', 'the card is on file AND off payment pages');
  // Stripe refuses the update: the card is still saved.
  const quinn = await mkClient(A.wid, 'quinn', `cus_quinn_${STAMP}`);
  addCard(`pm_quinn_${STAMP}`, `cus_quinn_${STAMP}`);
  failUpdate.add(`pm_quinn_${STAMP}`);
  r = await fire('checkout.session.completed', {
    id: `cs_rd_setup2_${STAMP}`, mode: 'setup', status: 'complete', setup_intent: `seti_quinn_${STAMP}`, customer: `cus_quinn_${STAMP}`,
    metadata: { purpose: 'save_card', workspace_id: A.wid, client_id: quinn },
  }, A.acct);
  assert(r.body.marked === 'card-saved' && (await clientRow(quinn)).payment_method_id === `pm_quinn_${STAMP}`, 'if Stripe refuses the update the card is still saved (the sweep below picks it up)');
  failUpdate.delete(`pm_quinn_${STAMP}`);

  const lSecret = `whsec_rd_legacy_${STAMP}`;
  const L = await mkBiz('legacy', { legacySecret: lSecret });
  cleanupUsers.push(L.uid);
  const lee = await mkClient(L.wid, 'lee', `cus_lee_${STAMP}`);
  addCard(`pm_lee_${STAMP}`, `cus_lee_${STAMP}`);
  calls.length = 0;
  r = await fireLegacy('checkout.session.completed', {
    id: `cs_rd_lsetup_${STAMP}`, mode: 'setup', status: 'complete', setup_intent: `seti_lee_${STAMP}`, customer: `cus_lee_${STAMP}`,
    metadata: { purpose: 'save_card', workspace_id: L.wid, client_id: lee },
  }, L.wid, lSecret);
  up = updates(`pm_lee_${STAMP}`);
  assert(r.statusCode === 200 && r.body.marked === 'card-saved' && up.length === 1 && up[0].body.allow_redisplay === 'limited' && up[0].headers.Authorization === 'Bearer sk_test_rd_legacy',
    `legacy webhook: card stored and turned to limited with the business's own key (${JSON.stringify(r.body)})`);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] a deposit from someone not signed in keeps the card on a NEW customer');
  const inv = { id: 'bookdep_x', number: 'Deposit', workspace_id: A.wid, client_id: pat };
  const base = { secretKey: KEY, stripeAccount: A.acct, invoice: inv, currency: 'USD', totalCents: 2500, successUrl: 'https://x/ok', cancelUrl: 'https://x/no', customerEmail: 'typed@example.com' };
  const sessionBody = async (opts) => { calls.length = 0; await createCheckoutSession({ ...base, ...opts }); return calls.find((c) => /checkout\/sessions$/.test(c.url)).body; };
  let b = await sessionBody({ saveCard: true, newCustomer: true });
  assert(!('customer' in b) && b.customer_creation === 'always' && b.customer_email === 'typed@example.com', 'no existing customer: the typed email, and Stripe makes a new customer when it is paid');
  assert(b['payment_intent_data[setup_future_usage]'] === 'off_session' && b['metadata[save_card]'] === '1' && b['metadata[client_id]'] === pat && b['payment_intent_data[metadata][client_id]'] === pat, 'the card is still kept for later fees and tied to the client');
  b = await sessionBody({ saveCard: true, newCustomer: true, customerId: 'cus_known' });
  assert(b.customer === 'cus_known' && !('customer_creation' in b) && !('customer_email' in b), 'a signed-in or tokened flow that passes its customer is unchanged');
  b = await sessionBody({ saveCard: false, newCustomer: true });
  assert(!('customer' in b) && !('customer_creation' in b) && !('payment_intent_data[setup_future_usage]' in b), 'not keeping a card: an ordinary guest checkout');
  b = await sessionBody({ saveCard: true });
  assert(!('customer' in b) && !('customer_creation' in b) && !('payment_intent_data[setup_future_usage]' in b), 'saveCard without a customer or newCustomer keeps nothing (as before)');
  // Stripe refuses the whole session when customer_update is sent without
  // an existing customer (checked): tax on must not break a guest checkout.
  b = await sessionBody({ automaticTax: true, saveCard: true, newCustomer: true });
  assert(b['automatic_tax[enabled]'] === 'true' && !('customer_update[address]' in b) && b.billing_address_collection === 'required', 'tax on, no existing customer: no customer_update (address comes from the billing form)');
  b = await sessionBody({ automaticTax: true, saveCard: true, customerId: 'cus_known' });
  assert(b['customer_update[address]'] === 'auto', 'tax on, existing customer: customer_update as before');

  // The booking page's helper: a deposit never reaches for a Stripe customer.
  const svc = { cancellation_fee_amount: 20, no_show_fee_amount: 0 };
  const nocard = await mkClient(A.wid, 'nocard', `cus_leftover_${STAMP}`);
  calls.length = 0;
  let keep = await cardOnFileCheckout({ workspaceId: A.wid, clientId: nocard, service: svc, mode: 'deposit' });
  assert(keep?.keepCard === true && !('customerId' in keep) && calls.length === 0, 'deposit mode: keep the card, no customer handed back, Stripe not called');
  assert((await clientRow(nocard)).stripe_customer_id === `cus_leftover_${STAMP}`, 'the client row is not touched');
  const hascard = await mkClient(A.wid, 'hascard', `cus_has_${STAMP}`, 'pm_on_file');
  assert(await cardOnFileCheckout({ workspaceId: A.wid, clientId: hascard, service: svc, mode: 'deposit' }) === null, 'a client with a card on file is never offered a replacement');
  assert(await cardOnFileCheckout({ workspaceId: A.wid, clientId: nocard, service: { cancellation_fee_amount: 0 }, mode: 'deposit' }) === null, 'no fees on the service: no card kept');
  calls.length = 0;
  keep = await cardOnFileCheckout({ workspaceId: A.wid, clientId: nocard, service: svc, mode: 'setup', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  const setupCall = calls.find((c) => /checkout\/sessions$/.test(c.url));
  assert(!!keep?.url && setupCall?.body.mode === 'setup' && setupCall.body.customer === `cus_leftover_${STAMP}`, 'setup mode (a page that shows no saved cards) still saves onto the client\'s customer');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] the sweep over cards saved before this');
  // Business A: two customers. One has the card on file plus an older one
  // left behind; both "always". The other has an already-limited card.
  const s1 = await mkClient(A.wid, 'sweep1', `cus_s1_${STAMP}`, `pm_s1_new_${STAMP}`);
  addCard(`pm_s1_new_${STAMP}`, `cus_s1_${STAMP}`, 'always', '0001');
  addCard(`pm_s1_old_${STAMP}`, `cus_s1_${STAMP}`, 'always', '0002');
  await mkClient(A.wid, 'sweep2', `cus_s2_${STAMP}`, `pm_s2_${STAMP}`);
  addCard(`pm_s2_${STAMP}`, `cus_s2_${STAMP}`, 'limited', '0003');
  // A second client row sharing a customer is looked at once.
  await mkClient(A.wid, 'sweep1b', `cus_s1_${STAMP}`);
  // A customer deleted in Stripe.
  await mkClient(A.wid, 'gone', `cus_gone_${STAMP}`);
  goneCustomers.add(`cus_gone_${STAMP}`);
  // Business B's card must not be touched by a sweep of A.
  await mkClient(B.wid, 'other', `cus_b_${STAMP}`, `pm_b_${STAMP}`);
  addCard(`pm_b_${STAMP}`, `cus_b_${STAMP}`, 'always', '0009');
  const credsA = { secretKey: KEY, stripeAccount: A.acct };

  calls.length = 0;
  const seen = [];
  let rep = await hideSavedCardsForWorkspace({ workspaceId: A.wid, creds: credsA, onCard: (c) => seen.push(c) });
  // pat, quinn, nocard's leftover, hascard and the sweep customers.
  const always = () => [...cards.entries()].filter(([, c]) => c.allow_redisplay === 'always').map(([id]) => id).sort();
  assert(calls.every((c) => c.method === 'GET'), 'dry run (the default): only reads, nothing changed in Stripe');
  assert(rep.hidden === 0 && rep.toHide === 3 && rep.failed === 0, `dry run counts what it would change: quinn's refused card + the two on sweep1 (${JSON.stringify({ ...rep, errors: undefined })})`);
  assert(seen.length === 3 && seen.every((c) => c.last4 && c.customerId) && seen.some((c) => c.paymentMethodId === `pm_s1_old_${STAMP}`), 'the leftover older card is found, not only the card on the client row');
  assert(calls.filter((c) => c.url.includes(`/customers/cus_s1_${STAMP}/payment_methods`)).length === 1, 'a customer shared by two client rows is looked at once');
  assert(rep.errors.length === 0, 'a customer deleted in Stripe is not an error');
  assert(always().includes(`pm_b_${STAMP}`) && !calls.some((c) => c.url.includes(`cus_b_${STAMP}`)), "another business's customers are never read");

  calls.length = 0;
  rep = await hideSavedCardsForWorkspace({ workspaceId: A.wid, creds: credsA, apply: true });
  assert(rep.toHide === 3 && rep.hidden === 3 && rep.failed === 0, `apply: all three changed (${JSON.stringify({ ...rep, errors: undefined })})`);
  assert(cards.get(`pm_s1_new_${STAMP}`).allow_redisplay === 'limited' && cards.get(`pm_s1_old_${STAMP}`).allow_redisplay === 'limited' && cards.get(`pm_quinn_${STAMP}`).allow_redisplay === 'limited', 'the cards are limited in Stripe');
  assert(updates(`pm_s2_${STAMP}`).length === 0 && updates(`pm_pat_${STAMP}`).length === 0, 'cards that were already limited are left alone');
  assert(calls.filter((c) => c.method === 'POST').every((c) => c.headers['Stripe-Account'] === A.acct && c.body.allow_redisplay === 'limited' && Object.keys(c.body).length === 1), 'every change is that one field, on this business\'s account');
  assert(cards.get(`pm_b_${STAMP}`).allow_redisplay === 'always', "the other business's card is untouched");
  assert((await clientRow(s1)).payment_method_id === `pm_s1_new_${STAMP}` && (await clientRow(s1)).stripe_customer_id === `cus_s1_${STAMP}`, 'the client row (card on file, customer) is not changed by the sweep');
  rep = await hideSavedCardsForWorkspace({ workspaceId: A.wid, creds: credsA, apply: true });
  assert(rep.toHide === 0 && rep.hidden === 0, 'running it again finds nothing to do');
  // A failure is counted and named, and the rest still go through.
  addCard(`pm_s1_x_${STAMP}`, `cus_s1_${STAMP}`, 'always', '0004');
  addCard(`pm_s1_y_${STAMP}`, `cus_s1_${STAMP}`, 'always', '0005');
  failUpdate.add(`pm_s1_x_${STAMP}`);
  rep = await hideSavedCardsForWorkspace({ workspaceId: A.wid, creds: credsA, apply: true });
  assert(rep.toHide === 2 && rep.hidden === 1 && rep.failed === 1 && rep.errors.length === 1 && rep.errors[0].includes(`pm_s1_x_${STAMP}`), 'a card Stripe refuses is counted and named; the others still change');
  assert((await hideSavedCardsForWorkspace({ workspaceId: A.wid, creds: null, apply: true })).customers === 0, 'no credentials: does nothing');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[5] the code paths cannot quietly go back');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const code = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const rel of ['api/_lib/autopay.js', 'api/webhooks/stripe-platform.js', 'api/webhooks/stripe/[workspaceId].js']) {
    assert(/hideCardFromCheckout\(/.test(code(rel)), `${rel}: a setup-mode save turns the card to limited`);
  }
  const slug = code('api/calendar/public/[slug].js');
  assert(/mode: 'deposit'/.test(slug) && /saveCard: true, newCustomer: true/.test(slug) && !/customerId: keep/.test(slug) && !/mode: 'customer'/.test(slug), 'the public booking deposit asks for a new customer and never passes an existing one');
  const script = fs.readFileSync(path.join(root, 'scripts/hide-saved-cards-from-checkout.mjs'), 'utf8');
  assert(/const apply = args\.includes\('--apply'\)/.test(script) && /hideSavedCardsForWorkspace\(\{\s*workspaceId, creds, apply,/.test(script), 'the one-off script changes nothing unless --apply is given');

  // ── cleanup ─────────────────────────────────────────────────────────
  for (const uid of cleanupUsers) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });

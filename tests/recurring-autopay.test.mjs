// Autopay for recurring invoices (api/_lib/autopay.js). Stripe's HTTP API
// and Resend are mocked at globalThis.fetch; the mock replays a stored
// answer for a repeated Idempotency-Key, like Stripe does.
//
//   [1]  owner asks -> client email + "waiting"; Square/PayPal refused; other workspace 404
//   [2]  no consent -> invoice sent normally, nothing charged
//   [3]  client authorizes -> immutable consent snapshot; strangers can't
//   [4]  two cron runs in parallel -> one invoice, ONE PaymentIntent, paid, receipt
//   [5]  webhook replay -> no double record, no second receipt
//   [6]  amount = balance due (discount, tax, gift card); never above the approval
//   [7]  voided / paid / archived / partly paid never charged
//   [8]  retryable decline -> invoice emailed with pay link, owner told, ONE retry
//   [9]  expired card -> no retry;  [10] authentication_required -> no retry
//   [11] lost answer -> recovered with the SAME idempotency key, charged once
//   [12] client turns off -> next invoice manual, owner told
//   [13] series stopped -> agreement ends, nothing charged
//   [14] card removed / card changed -> nothing charged
//   [15] isolation: other workspace / other client user
//   [16] add a card in the flow (setup session checked server-side)
//   [17] test vs live mode; deleted client
//
// Run: node --import ./tests/bootstrap.mjs ./tests/recurring-autopay.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_autopay';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_autopay';
process.env.CRON_SECRET = 'cron-autopay-test';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import cronHandler from '../api/cron/recurring-invoices.js';
import ownerAutopay from '../api/recurring-invoices/autopay.js';
import seriesHandler from '../api/recurring-invoices/[id].js';
import seriesList from '../api/recurring-invoices/index.js';
import meAutopay from '../api/me/autopay.js';
import meInvoices from '../api/me/invoices/index.js';
import removeCardHandler from '../api/me/payment-methods/[clientId].js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import {
  chargeInvoiceAutopay, runAutopaySweep, balanceDueCents, classifyChargeError, endOrphanedAgreements,
} from '../api/_lib/autopay.js';
import { invoiceAutopayLine, seriesAutopayLabel, buildConsentText } from '../src/lib/autopayRules.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Stripe + Resend mock ──
const stripeCalls = [];
const emails = [];
const idemStore = new Map();
let piMode = 'succeed';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const card = (id, last4, brand = 'visa', customer = 'cus_ap_1') => ({ id, type: 'card', customer, card: { brand, last4, exp_month: 12, exp_year: 2031 } });
const piCalls = () => stripeCalls.filter((c) => /\/v1\/payment_intents$/.test(c.url) && c.method === 'POST');
let piSeq = 0;
function piResponse(params) {
  const amount = Number(params.get('amount'));
  const meta = {};
  for (const [k, v] of params.entries()) { const m = /^metadata\[(.+)\]$/.exec(k); if (m) meta[m[1]] = v; }
  const id = `pi_ap_${++piSeq}`;
  if (piMode === 'succeed') return [200, { id, status: 'succeeded', amount, amount_received: amount, currency: params.get('currency'), customer: params.get('customer'), payment_method: params.get('payment_method'), metadata: meta, payment_method_types: ['card'] }];
  if (piMode === 'insufficient') return [402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.', payment_intent: { id, status: 'requires_payment_method' } } }];
  if (piMode === 'expired') return [402, { error: { type: 'card_error', code: 'expired_card', message: 'Your card has expired.', payment_intent: { id } } }];
  if (piMode === 'auth') return [402, { error: { type: 'card_error', code: 'authentication_required', decline_code: 'authentication_required', message: 'This transaction requires authentication.', payment_intent: { id, status: 'requires_action' } } }];
  if (piMode === 'outage') return [500, { error: { type: 'api_error', message: 'Something went wrong' } }];
  return [400, { error: { message: 'unknown mode' } }];
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';
  const body = init.body ? String(init.body) : '';
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(body)); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  if (!/api\.stripe\.com/.test(u)) return json({});
  const headers = init.headers || {};
  stripeCalls.push({ url: u, method, body, headers });
  const params = new URLSearchParams(body);
  if (/\/v1\/payment_intents$/.test(u) && method === 'POST') {
    await new Promise((r) => setTimeout(r, 30)); // let racers overlap
    const key = headers['Idempotency-Key'];
    if (key && idemStore.has(key)) { const [s, o] = idemStore.get(key); return json(o, s); }
    const [s, o] = piResponse(params);
    if (key && piMode !== 'outage') idemStore.set(key, [s, o]);
    return json(o, s);
  }
  if (/\/v1\/payment_methods\/pm_ap_1$/.test(u)) return json(card('pm_ap_1', '4242'));
  if (/\/v1\/payment_methods\/pm_ap_2$/.test(u)) return json(card('pm_ap_2', '1111', 'mastercard'));
  if (/\/v1\/payment_methods\/pm_ap_1\/detach$/.test(u)) return json({ id: 'pm_ap_1' });
  if (/\/v1\/checkout\/sessions\/cs_setup_ok/.test(u)) return json({ id: 'cs_setup_ok', mode: 'setup', status: 'complete', setup_intent: 'seti_ok', customer: 'cus_ap_1', metadata: globalThis.__setupMeta || {} });
  if (/\/v1\/checkout\/sessions\/cs_setup_other/.test(u)) return json({ id: 'cs_setup_other', mode: 'setup', status: 'complete', setup_intent: 'seti_ok', customer: 'cus_x', metadata: { client_id: '00000000-0000-0000-0000-000000000000', workspace_id: 'x' } });
  if (/\/v1\/setup_intents\/seti_ok$/.test(u)) return json({ id: 'seti_ok', status: 'succeeded', payment_method: 'pm_ap_2' });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: 'cs_new_setup', url: 'https://checkout.stripe.com/c/setup/cs_new_setup' });
  if (/\/v1\/customers/.test(u)) return json({ id: 'cus_ap_1', data: [] });
  return json({});
};

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
const hdrs = (userId, extra = {}) => ({
  host: 'www.joinivy.ai', origin: 'https://www.joinivy.ai', 'user-agent': 'AutopayTest/1.0 (iPhone)',
  'x-forwarded-for': '198.18.7.7', 'content-type': 'application/json',
  ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}), ...extra,
});
async function call(handler, { method = 'POST', userId, body, query = {} }) {
  const res = mkRes();
  await handler({ method, headers: hdrs(userId), query, body }, res);
  return res;
}
async function cron() {
  const res = mkRes();
  await cronHandler({ method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} }, res);
  return res;
}
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}

async function run() {
  await ensureSchemaApplied();
  const tag = `ap-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const acct = `acct_${tag}`;
  const mkUser = async (email, name) => (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${name}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const mkWs = async (ownerId, name, provider = 'stripe', acctId = acct) => {
    const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
      VALUES (${ownerId}, ${name}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${name}, ${`${tag}-${name.toLowerCase().replace(/\W+/g, '-')}`})`;
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, payment_provider)
      VALUES (${wid}, ${acctId}, 'complete', ${provider})`;
    return wid;
  };
  const ownerA = await mkUser(`${tag}-owner-a@example.com`, 'Olive Owner');
  const ownerB = await mkUser(`${tag}-owner-b@example.com`, 'Bo Owner');
  const ownerSq = await mkUser(`${tag}-owner-sq@example.com`, 'Sq Owner');
  const wsA = await mkWs(ownerA, 'Glow Studio');
  const wsB = await mkWs(ownerB, 'Other Studio', 'stripe', `acct_b_${tag}`);
  const wsSq = await mkWs(ownerSq, 'Square Studio', 'square', null);
  const clientEmail = `${tag}-casey@example.com`;
  const clientUser = await mkUser(clientEmail, 'Casey Client');
  const strangerUser = await mkUser(`${tag}-stranger@example.com`, 'Stan Stranger');
  const clientA = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id, stripe_customer_id, payment_method_id, payment_method_brand, payment_method_last4)
    VALUES (${wsA}, 'Casey Client', ${clientEmail}, 'active', ${clientUser}, 'cus_ap_1', 'pm_ap_1', 'visa', '4242') RETURNING id`).rows[0].id;
  const strangerClientB = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${wsB}, 'Stan Stranger', ${`${tag}-stranger@example.com`}, 'active', ${strangerUser}) RETURNING id`).rows[0].id;
  const clientSq = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wsSq}, 'Sam Sq', ${`${tag}-sam@example.com`}, 'active') RETURNING id`).rows[0].id;
  const items = JSON.stringify([{ id: 'li1', description: 'Monthly coaching', quantity: 1, rate: 100 }]);
  const mkSeries = async (wid, cid, name, extra = {}) => (await sql`
    INSERT INTO recurring_invoices (workspace_id, name, client_id, client_name, client_email, items, tax_rate, discount, cadence, next_run_at, status, auto_send, currency)
    VALUES (${wid}, ${name}, ${cid}, 'Casey Client', ${clientEmail}, ${extra.items || items}::jsonb, ${extra.taxRate ?? 10}, ${extra.discount ?? 0}, 'monthly', CURRENT_DATE - 1, 'active', ${extra.autoSend ?? true}, 'USD')
    RETURNING id`).rows[0].id;
  const seriesA = await mkSeries(wsA, clientA, 'Coaching retainer');
  // Not due yet: only seriesA is materialized by the first cron passes.
  await sql`UPDATE recurring_invoices SET next_run_at = CURRENT_DATE + 20 WHERE id = ${seriesA}`;
  const seriesSq = await mkSeries(wsSq, clientSq, 'Square series');
  await sql`UPDATE recurring_invoices SET next_run_at = CURRENT_DATE + 20 WHERE id = ${seriesSq}`;
  const notes = async (uid, title) => (await sql`SELECT title, body FROM notifications WHERE user_id = ${uid} AND title = ${title} ORDER BY created_at DESC`).rows;
  const makeDue = (sid) => sql`UPDATE recurring_invoices SET next_run_at = CURRENT_DATE - 1 WHERE id = ${sid}`;
  const invoicesOf = async (sid) => (await sql`SELECT * FROM invoices WHERE recurring_invoice_id = ${sid} ORDER BY created_at ASC`).rows;

  console.log('\n[1] owner turns autopay on -> request email; limits');
  emails.length = 0;
  let r = await call(ownerAutopay, { userId: ownerA, body: { id: seriesA, action: 'request' } });
  assert(r.statusCode === 200 && r.body.schedule.autopay.state === 'waiting', `series now "waiting" (got ${r.statusCode} ${JSON.stringify(r.body?.schedule?.autopay || r.body)})`);
  assert(seriesAutopayLabel(r.body.schedule.autopay) === 'Waiting for client to authorize', 'label: Waiting for client to authorize');
  await settle(100);
  const reqMail = emails.find((e) => /asked about automatic payments/.test(e.subject || ''));
  assert(!!reqMail && reqMail.to?.includes?.(clientEmail) !== false, 'client got the "approve automatic payments" email');
  assert(/\/me\/invoices\?autopay=/.test(reqMail?.html || ''), 'email links to the portal approval');
  emails.length = 0;
  r = await call(ownerAutopay, { userId: ownerA, body: { id: seriesA, action: 'request' } });
  await settle(100);
  assert(r.statusCode === 200 && !emails.some((e) => /automatic payments/.test(e.subject || '')), 'asking again within the hour does not re-send');
  assert((await sql`SELECT COUNT(*)::int AS n FROM autopay_agreements WHERE recurring_invoice_id = ${seriesA} AND status = 'requested'`).rows[0].n === 1, 'still one open request');
  r = await call(ownerAutopay, { userId: ownerSq, body: { id: seriesSq, action: 'request' } });
  assert(r.statusCode === 400 && /need Stripe/.test(r.body?.error || '') && /Square/.test(r.body?.error || ''), `Square business refused in plain words (got ${r.statusCode} ${r.body?.error})`);
  r = await call(ownerAutopay, { userId: ownerB, body: { id: seriesA, action: 'request' } });
  assert(r.statusCode === 404, `another business cannot touch this series (got ${r.statusCode})`);
  r = await call(seriesList, { method: 'GET', userId: ownerSq });
  const sqRow = (r.body?.schedules || []).find((s) => s.id === seriesSq);
  assert(sqRow && sqRow.autopayAvailable === false && /Square/.test(sqRow.autopayUnavailableReason || ''), 'Square series lists autopay as unavailable with the reason');

  console.log('\n[2] no consent yet -> invoice sent normally, no charge');
  stripeCalls.length = 0; emails.length = 0;
  await makeDue(seriesA);
  r = await cron();
  assert(r.statusCode === 200, `cron ok (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  let invs = await invoicesOf(seriesA);
  assert(invs.length === 1, 'one invoice issued');
  assert(piCalls().length === 0, 'no PaymentIntent without consent');
  assert(invs[0].status === 'sent' && invs[0].autopay_status === 'skipped' && invs[0].autopay_skip_reason === 'waiting_for_authorization', 'invoice sent with a pay link, marked "waiting for authorization"');
  assert(emails.some((e) => /^Invoice INV-/.test(e.subject || '')), 'normal invoice email went out');

  console.log('\n[3] client authorizes in the portal');
  r = await call(meAutopay, { method: 'GET', userId: clientUser });
  const pending = (r.body.agreements || []).find((a) => a.status === 'requested');
  assert(!!pending && pending.amountCents === 11000 && pending.savedCard?.last4 === '4242', `portal lists the request: $110.00, Visa 4242 on file (got ${JSON.stringify(pending)})`);
  assert(/Visa ending in 4242/.test(pending.terms) && /every month/.test(pending.terms) && /\$110\.00/.test(pending.terms) && /turn off/.test(pending.terms), 'terms state card, frequency, cap and how to cancel');
  assert(!/pm_|cus_|acct_/.test(JSON.stringify(r.body)), 'no Stripe ids reach the portal');
  r = await call(meAutopay, { method: 'GET', userId: strangerUser });
  assert((r.body.agreements || []).length === 0, 'a different person sees none of it');
  r = await call(meAutopay, { userId: strangerUser, body: { action: 'authorize', agreementId: pending.id, agree: true } });
  assert(r.statusCode === 404, `a different person cannot authorize it (got ${r.statusCode})`);
  r = await call(meAutopay, { userId: clientUser, body: { action: 'authorize', agreementId: pending.id } });
  assert(r.statusCode === 400, 'must tick "I agree"');
  r = await call(meAutopay, { userId: clientUser, body: { action: 'authorize', agreementId: pending.id, agree: true } });
  assert(r.statusCode === 200 && r.body.agreements.find((a) => a.id === pending.id)?.status === 'active', `authorized (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const ag = (await sql`SELECT * FROM autopay_agreements WHERE id = ${pending.id}`).rows[0];
  assert(ag.consent_text === pending.terms, 'the stored words are exactly the words shown');
  assert(ag.consent_ip === '198.18.7.7' && /AutopayTest/.test(ag.consent_user_agent) && ag.consent_user_id === clientUser && ag.authorized_at, 'IP, user agent, user and time stored');
  assert(ag.card_last4 === '4242' && ag.payment_method_id === 'pm_ap_1' && ag.recurring_invoice_id === seriesA && ag.max_amount_cents === 11000 && ag.livemode === false && ag.stripe_account === acct, 'card, series, cap, mode and account stored');
  let threw = false;
  try { await sql`UPDATE autopay_agreements SET consent_text = 'tampered' WHERE id = ${ag.id}`; } catch { threw = true; }
  assert(threw, 'consent snapshot cannot be edited (DB trigger)');
  threw = false;
  try { await sql`UPDATE autopay_agreements SET max_amount_cents = 999999 WHERE id = ${ag.id}`; } catch { threw = true; }
  assert(threw, 'approved amount cannot be raised after the fact');
  await settle(100);
  assert((await notes(ownerA, 'Autopay approved')).length === 1, 'owner notified: Autopay approved');
  r = await call(seriesHandler, { method: 'GET', userId: ownerA, query: { id: seriesA } });
  assert(r.body.schedule.autopay.state === 'on' && seriesAutopayLabel(r.body.schedule.autopay) === 'Autopay on (Visa 4242)', 'series shows "Autopay on (Visa 4242)"');

  console.log('\n[4] two cron runs at once -> one invoice, one charge');
  stripeCalls.length = 0; emails.length = 0;
  await makeDue(seriesA);
  const [c1, c2] = await Promise.all([cron(), cron()]);
  assert(c1.statusCode === 200 && c2.statusCode === 200, 'both runs finish');
  invs = await invoicesOf(seriesA);
  assert(invs.length === 2, `one new invoice for the cycle (got ${invs.length - 1})`);
  const inv2 = invs[1];
  assert(piCalls().length === 1, `exactly one PaymentIntent (got ${piCalls().length})`);
  const p = new URLSearchParams(piCalls()[0]?.body || '');
  assert(p.get('amount') === '11000' && p.get('currency') === 'usd', 'charged the balance due, $110.00 USD (tax included)');
  assert(piCalls()[0]?.headers?.['Stripe-Account'] === acct, 'charged on the business\'s connected account');
  assert(p.get('off_session') === 'true' && p.get('confirm') === 'true' && p.get('customer') === 'cus_ap_1' && p.get('payment_method') === 'pm_ap_1', 'off-session with the approved card');
  assert(piCalls()[0]?.headers?.['Idempotency-Key'] === `ivy-autopay-${inv2.id}-a1`, 'idempotency key per invoice + attempt');
  assert(p.get('metadata[invoice_id]') === inv2.id && p.get('metadata[source]') === 'autopay' && !p.has('receipt_email'), 'invoice metadata; Ivy sends the receipt (no Stripe receipt)');
  assert(inv2.status === 'paid' && Number(inv2.paid_amount) === 110 && inv2.autopay_status === 'succeeded' && inv2.paid_method === 'card', 'invoice paid through the normal paid path');
  await settle();
  const receipts = emails.filter((e) => /Receipt: invoice/.test(e.subject || ''));
  assert(receipts.length === 1 && /Paid automatically with Visa ending in 4242/.test(receipts[0].html || ''), 'one receipt: "Paid automatically with Visa ending in 4242"');
  assert(!emails.some((e) => /^Invoice INV-/.test(e.subject || '')), 'no "please pay" invoice email for an autopaid invoice');
  assert((await notes(ownerA, 'Autopay collected')).length >= 1, 'owner notified: Autopay collected');
  assert(invoiceAutopayLine({ status: 'paid', autopayStatus: 'succeeded', autopayCard: { brand: 'visa', last4: '4242' } }) === 'Paid automatically with Visa ending in 4242.', 'owner invoice line');
  r = await call(meInvoices, { method: 'GET', userId: clientUser });
  const mine = (r.body.invoices || []).find((i) => i.id === inv2.id);
  assert(mine?.autopayStatus === 'succeeded' && mine?.autopayCard?.last4 === '4242', 'portal invoice says it was paid automatically');

  console.log('\n[5] webhook replay never double records');
  emails.length = 0;
  const piObj = { id: inv2.autopay_payment_intent, object: 'payment_intent', status: 'succeeded', amount: 11000, amount_received: 11000, metadata: { invoice_id: inv2.id, workspace_id: wsA, source: 'autopay' }, payment_method_types: ['card'] };
  for (let i = 0; i < 2; i++) {
    const w = mkRes();
    // eslint-disable-next-line no-await-in-loop
    await platformWebhook(signedWebhook({ id: `evt_${tag}_${i}`, type: 'payment_intent.succeeded', account: acct, data: { object: piObj } }), w);
    assert(w.statusCode === 200 && /already-paid|duplicate/.test(JSON.stringify(w.body)), `webhook ${i + 1}: already paid (got ${JSON.stringify(w.body)})`);
  }
  await settle();
  assert(!emails.some((e) => /Receipt/.test(e.subject || '')), 'no second receipt');
  assert(Number((await sql`SELECT paid_amount FROM invoices WHERE id = ${inv2.id}`).rows[0].paid_amount) === 110, 'paid amount unchanged');
  stripeCalls.length = 0;
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv2.id });
  assert(piCalls().length === 0 && r.outcome === 'not_open', 'a paid invoice is never charged again');

  // Helper: an invoice in this series as the cron would mint it.
  let n = 0;
  const mkInv = async (extra = {}) => (await sql`
    INSERT INTO invoices (workspace_id, number, client_id, client_name, client_email, items, tax_rate, discount, status, currency, recurring_invoice_id, gift_card_credit_cents, archived_at, paid_amount)
    VALUES (${extra.ws || wsA}, ${`AP-${tag}-${++n}`}, ${extra.clientId === undefined ? clientA : extra.clientId}, 'Casey Client', ${clientEmail}, ${extra.items || items}::jsonb, ${extra.taxRate ?? 10}, ${extra.discount ?? 0},
            ${extra.status || 'draft'}, 'USD', ${extra.series === undefined ? seriesA : extra.series}, ${extra.gift || 0}, ${extra.archived ? new Date().toISOString() : null}, ${extra.paid ?? null})
    RETURNING *`).rows[0];

  console.log('\n[6] amount = balance due; never above the approval');
  stripeCalls.length = 0;
  let inv = await mkInv({ discount: 10, gift: 2000 });
  assert(balanceDueCents(inv) === 7900, 'balance due: (100 - 10) + 10% tax - $20 gift card = $79.00');
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  assert(r.outcome === 'succeeded' && new URLSearchParams(piCalls()[0]?.body || '').get('amount') === '7900', `charged $79.00 (got ${r.outcome} ${new URLSearchParams(piCalls()[0]?.body || '').get('amount')})`);
  assert((await sql`SELECT status FROM invoices WHERE id = ${inv.id}`).rows[0].status === 'paid', 'paid in full after gift card');
  stripeCalls.length = 0;
  inv = await mkInv({ items: JSON.stringify([{ id: 'li1', description: 'Bigger month', quantity: 2, rate: 100 }]) });
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  assert(r.outcome === 'skipped' && r.reason === 'over_approved_amount' && piCalls().length === 0, '$220 > $110 approved: not charged');
  assert((await sql`SELECT autopay_skip_reason FROM invoices WHERE id = ${inv.id}`).rows[0].autopay_skip_reason === 'over_approved_amount', 'invoice records why');
  await settle(100);
  assert((await notes(ownerA, 'Autopay did not run')).length >= 1, 'owner told autopay did not run');

  console.log('\n[7] voided / paid / archived / partly paid are never charged');
  stripeCalls.length = 0;
  for (const [label, extra] of [['voided', { status: 'voided' }], ['paid', { status: 'paid', paid: 110 }], ['archived', { archived: true }], ['partly paid', { status: 'sent', paid: 20 }]]) {
    inv = await mkInv(extra); // eslint-disable-line no-await-in-loop
    r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id }); // eslint-disable-line no-await-in-loop
    assert(piCalls().length === 0, `${label}: no charge (${r.outcome}${r.reason ? ' ' + r.reason : ''})`);
    // eslint-disable-next-line no-await-in-loop
    const after = (await sql`SELECT autopay_status, status FROM invoices WHERE id = ${inv.id}`).rows[0];
    assert(label === 'partly paid' ? after.autopay_status === 'skipped' : !after.autopay_status, `${label}: left alone`);
  }

  console.log('\n[8] retryable decline -> pay link + owner told + ONE retry');
  stripeCalls.length = 0; emails.length = 0; piMode = 'insufficient';
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  let row = (await sql`SELECT * FROM invoices WHERE id = ${inv.id}`).rows[0];
  assert(r.outcome === 'failed' && r.willRetry === true, 'declined, retry planned');
  assert(row.status === 'sent' && row.view_token_hash && row.autopay_status === 'retry_scheduled' && row.autopay_failure_code === 'insufficient_funds', 'invoice sent with a pay link; retry scheduled');
  const days = (new Date(row.autopay_retry_at) - Date.now()) / 86400000;
  assert(days > 2.9 && days < 3.1, `retry in 3 days (got ${days.toFixed(2)})`);
  await settle();
  const failMail = emails.find((e) => /We couldn't charge your card/.test(e.subject || ''));
  assert(!!failMail && /\/invoice\//.test(failMail.html || '') && /try your card once more/.test(failMail.html || ''), 'client email: friendly note, pay link, when we retry');
  assert((await notes(ownerA, 'Autopay failed')).length >= 1, 'owner notified: Autopay failed');
  const line = invoiceAutopayLine({ status: 'sent', autopayStatus: 'retry_scheduled', autopayFailedAt: row.autopay_failed_at, autopayFailureCode: 'insufficient_funds', autopayRetryAt: row.autopay_retry_at, autopayCard: { brand: 'visa', last4: '4242' } });
  assert(/^Automatic payment failed on [A-Z][a-z]{2} \d+: not enough funds on the card\. Ivy will try once more on/.test(line), `invoice shows the failure (${line})`);
  stripeCalls.length = 0;
  await runAutopaySweep();
  assert(piCalls().length === 0, 'no retry before the retry date');
  await sql`UPDATE invoices SET autopay_retry_at = NOW() - INTERVAL '1 minute' WHERE id = ${inv.id}`;
  emails.length = 0;
  await Promise.all([runAutopaySweep(), runAutopaySweep()]);
  assert(piCalls().length === 1 && piCalls()[0].headers['Idempotency-Key'] === `ivy-autopay-${inv.id}-a2`, `one retry, new key for attempt 2 (got ${piCalls().length})`);
  row = (await sql`SELECT * FROM invoices WHERE id = ${inv.id}`).rows[0];
  assert(row.autopay_status === 'failed' && row.autopay_attempts === 2, 'second decline is final');
  await settle();
  assert(emails.some((e) => /tried your Visa ending in 4242 again/.test(e.html || '')), 'client told we tried again');
  stripeCalls.length = 0;
  await sql`UPDATE invoices SET autopay_retry_at = NOW() - INTERVAL '1 minute' WHERE id = ${inv.id}`;
  await runAutopaySweep();
  assert(piCalls().length === 0, 'never a third attempt');

  console.log('\n[9] expired card -> no retry');
  piMode = 'expired';
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  row = (await sql`SELECT autopay_status, autopay_failure_code, autopay_retry_at, status FROM invoices WHERE id = ${inv.id}`).rows[0];
  assert(r.outcome === 'failed' && row.autopay_status === 'failed' && row.autopay_failure_code === 'expired_card' && !row.autopay_retry_at && row.status === 'sent', 'expired: failed, sent for manual payment, no retry');

  console.log('\n[10] authentication_required -> client pays on the page, no retry');
  piMode = 'auth';
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  row = (await sql`SELECT autopay_status, autopay_failure_code, autopay_retry_at, status, view_token_hash FROM invoices WHERE id = ${inv.id}`).rows[0];
  assert(row.autopay_failure_code === 'authentication_required' && row.autopay_status === 'failed' && !row.autopay_retry_at && row.status === 'sent' && row.view_token_hash, 'needs the client: sent with a pay link, no retry');
  assert(classifyChargeError({ status: 402, stripeType: 'card_error', stripeCode: 'card_declined', declineCode: 'stolen_card' }).retryable === false, 'stolen/lost cards are never retried');
  assert(classifyChargeError({}).kind === 'unknown', 'no answer = unknown (never assumed failed)');

  console.log('\n[11] lost answer -> same key later -> charged once');
  stripeCalls.length = 0; piMode = 'outage';
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  row = (await sql`SELECT autopay_status, status FROM invoices WHERE id = ${inv.id}`).rows[0];
  assert(r.outcome === 'unknown' && row.autopay_status === 'charging' && row.status === 'draft', 'kept as "charging", nothing emailed');
  piMode = 'succeed';
  await runAutopaySweep();
  assert(piCalls().length === 1, 'not re-asked before 15 minutes');
  await sql`UPDATE invoices SET autopay_last_attempt_at = NOW() - INTERVAL '20 minutes' WHERE id = ${inv.id}`;
  await Promise.all([runAutopaySweep(), runAutopaySweep()]);
  assert(piCalls().length === 2 && piCalls()[1].headers['Idempotency-Key'] === piCalls()[0].headers['Idempotency-Key'], 'recovered once, with the same idempotency key');
  assert((await sql`SELECT status FROM invoices WHERE id = ${inv.id}`).rows[0].status === 'paid', 'paid');

  console.log('\n[12] client turns autopay off -> next invoice is manual');
  emails.length = 0; stripeCalls.length = 0;
  r = await call(meAutopay, { userId: clientUser, body: { action: 'turn-off', agreementId: ag.id } });
  assert(r.statusCode === 200 && r.body.agreements.find((a) => a.id === ag.id)?.status === 'ended', 'ended');
  await settle(100);
  assert((await notes(ownerA, 'Autopay turned off')).length >= 1, 'owner notified: Autopay turned off');
  await makeDue(seriesA);
  await cron();
  invs = await invoicesOf(seriesA);
  const inv3 = invs[invs.length - 1];
  assert(piCalls().length === 0 && inv3.status === 'sent' && !inv3.autopay_status, 'next invoice: no charge, emailed normally');
  r = await call(seriesHandler, { method: 'GET', userId: ownerA, query: { id: seriesA } });
  assert(r.body.schedule.autopay.state === 'off' && r.body.schedule.autopay.lastEnded?.by === 'client', 'series shows "Autopay off" (client turned it off)');

  console.log('\n[13] series stopped -> agreement ends, nothing charged');
  const approve = async (sid) => {
    await call(ownerAutopay, { userId: ownerA, body: { id: sid, action: 'request' } });
    const list = (await call(meAutopay, { method: 'GET', userId: clientUser })).body.agreements;
    const a = list.find((x) => x.status === 'requested');
    await call(meAutopay, { userId: clientUser, body: { action: 'authorize', agreementId: a.id, agree: true } });
    return a.id;
  };
  const ag2 = await approve(seriesA);
  assert((await sql`SELECT status FROM autopay_agreements WHERE id = ${ag2}`).rows[0].status === 'active', 're-approved');
  emails.length = 0;
  r = await call(seriesHandler, { method: 'PATCH', userId: ownerA, query: { id: seriesA }, body: { status: 'ended' } });
  assert(r.statusCode === 200 && r.body.schedule.autopay.state === 'off', 'series ended -> autopay off');
  assert((await sql`SELECT status, ended_reason FROM autopay_agreements WHERE id = ${ag2}`).rows[0].ended_reason === 'series_stopped', 'agreement ended: series_stopped');
  await settle(100);
  assert(emails.some((e) => /Automatic payments turned off/.test(e.subject || '')), 'client told automatic payments are off');
  stripeCalls.length = 0;
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  assert(r.outcome === 'no_consent' && piCalls().length === 0, 'stopped series: nothing charged');

  console.log('\n[14] card removed / card changed -> nothing charged');
  await sql`UPDATE recurring_invoices SET status = 'active' WHERE id = ${seriesA}`;
  const ag3 = await approve(seriesA);
  await sql`UPDATE clients SET payment_method_id = 'pm_ap_2', payment_method_last4 = '1111' WHERE id = ${clientA}`;
  stripeCalls.length = 0;
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  assert(r.outcome === 'skipped' && r.reason === 'card_changed' && piCalls().length === 0, 'new card not yet approved: not charged');
  let list = (await call(meAutopay, { method: 'GET', userId: clientUser })).body.agreements;
  assert(list.find((a) => a.id === ag3)?.cardChanged === true, 'portal asks the client to approve the new card');
  r = await call(meAutopay, { userId: clientUser, body: { action: 'authorize', agreementId: ag3, agree: true } });
  list = r.body.agreements || [];
  const ag4 = list.find((a) => a.status === 'active');
  assert(r.statusCode === 200 && ag4 && ag4.id !== ag3 && ag4.card?.last4 === '1111', `re-approved with Mastercard 1111 as a NEW agreement (got ${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)})`);
  assert((await sql`SELECT ended_reason FROM autopay_agreements WHERE id = ${ag3}`).rows[0].ended_reason === 'replaced', 'old approval kept on record as replaced');
  r = await call(removeCardHandler, { method: 'DELETE', userId: clientUser, query: { clientId: clientA } });
  assert(r.statusCode === 204, 'card removed');
  assert((await sql`SELECT status, ended_reason FROM autopay_agreements WHERE id = ${ag4.id}`).rows[0].ended_reason === 'card_removed', 'approval ended: card_removed');
  stripeCalls.length = 0;
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  assert(r.outcome === 'no_consent' && piCalls().length === 0, 'no card -> nothing charged');

  console.log('\n[15] isolation');
  await sql`UPDATE clients SET payment_method_id = 'pm_ap_1', payment_method_last4 = '4242', stripe_customer_id = 'cus_ap_1' WHERE id = ${clientA}`;
  const ag5 = await approve(seriesA);
  inv = await mkInv();
  stripeCalls.length = 0;
  r = await chargeInvoiceAutopay({ workspaceId: wsB, invoiceId: inv.id });
  assert(r.outcome === 'no_consent' && piCalls().length === 0, 'another workspace id cannot charge this invoice');
  const invOtherClient = await mkInv({ clientId: strangerClientB });
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: invOtherClient.id });
  assert(r.outcome === 'no_consent' && piCalls().length === 0, 'approval for one client never charges another client');
  const invNoSeries = await mkInv({ series: null });
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: invNoSeries.id });
  assert(r.outcome === 'no_consent' && piCalls().length === 0, 'one-off invoices are never autopaid');
  r = await call(seriesList, { method: 'GET', userId: ownerB });
  assert(!(r.body.schedules || []).some((s) => s.id === seriesA), 'other owner does not see the series');
  r = await call(meAutopay, { userId: strangerUser, body: { action: 'turn-off', agreementId: ag5 } });
  assert(r.statusCode === 404 && (await sql`SELECT status FROM autopay_agreements WHERE id = ${ag5}`).rows[0].status === 'active', 'a stranger cannot turn it off');

  console.log('\n[16] add a card inside the approval flow');
  const ownerReq = await call(ownerAutopay, { userId: ownerA, body: { id: seriesA, action: 'off' } });
  assert(ownerReq.statusCode === 200 && ownerReq.body.schedule.autopay.state === 'off', 'owner turns it off');
  await sql`UPDATE clients SET payment_method_id = NULL, payment_method_last4 = NULL, payment_method_brand = NULL WHERE id = ${clientA}`;
  await call(ownerAutopay, { userId: ownerA, body: { id: seriesA, action: 'request' } });
  const req6 = (await call(meAutopay, { method: 'GET', userId: clientUser })).body.agreements.find((a) => a.status === 'requested');
  r = await call(meAutopay, { userId: clientUser, body: { action: 'authorize', agreementId: req6.id, agree: true } });
  assert(r.statusCode === 400 && /Add a card/.test(r.body.error), 'no card yet: asked to add one');
  stripeCalls.length = 0;
  r = await call(meAutopay, { userId: clientUser, body: { action: 'add-card', agreementId: req6.id } });
  const cs = stripeCalls.find((c) => /checkout\/sessions$/.test(c.url));
  const csp = new URLSearchParams(cs?.body || '');
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url) && csp.get('mode') === 'setup' && cs.headers['Stripe-Account'] === acct, 'setup Checkout on the connected account');
  assert(csp.get('success_url').includes(`autopay=${req6.id}`) && csp.get('success_url').includes('setup={CHECKOUT_SESSION_ID}'), 'comes back to the same approval');
  r = await call(meAutopay, { userId: clientUser, body: { action: 'sync-card', agreementId: req6.id, setupSessionId: 'cs_setup_other' } });
  assert(r.statusCode === 400, 'a setup session for someone else is refused');
  globalThis.__setupMeta = { client_id: clientA, workspace_id: wsA };
  r = await call(meAutopay, { userId: clientUser, body: { action: 'sync-card', agreementId: req6.id, setupSessionId: 'cs_setup_ok' } });
  assert(r.statusCode === 200 && r.body.card.last4 === '1111', 'card stored from the finished setup');
  r = await call(meAutopay, { userId: clientUser, body: { action: 'authorize', agreementId: req6.id, agree: true } });
  assert(r.statusCode === 200 && r.body.agreements.find((a) => a.id === req6.id)?.card?.last4 === '1111', 'approved with the new card');

  console.log('\n[17] live/test mode + deleted client');
  process.env.STRIPE_SECRET_KEY = 'sk_live_autopay';
  stripeCalls.length = 0;
  inv = await mkInv();
  r = await chargeInvoiceAutopay({ workspaceId: wsA, invoiceId: inv.id });
  process.env.STRIPE_SECRET_KEY = 'sk_test_autopay';
  assert(r.outcome === 'skipped' && r.reason === 'stripe_changed' && piCalls().length === 0, 'a test-mode approval is never used in live mode');
  await sql`DELETE FROM clients WHERE id = ${clientA}`;
  await endOrphanedAgreements();
  assert((await sql`SELECT status, ended_reason FROM autopay_agreements WHERE id = ${req6.id}`).rows[0].ended_reason === 'client_deleted', 'deleted client: approval ended');
  const kept = (await sql`SELECT consent_text, card_last4 FROM autopay_agreements WHERE id = ${req6.id}`).rows[0];
  assert(!!kept.consent_text && kept.card_last4 === '1111', 'consent record kept after the client is deleted');
  assert(buildConsentText({ businessName: 'X', seriesName: 'Y', brand: 'visa', last4: '4242', cadence: 'weekly', maxAmountCents: 5000, currency: 'USD', startDate: '2026-11-06' }).includes('every week starting Nov 6, 2026'), 'consent text names the start date');

  await sql`DELETE FROM workspaces WHERE id IN (${wsA}, ${wsB}, ${wsSq})`;
  await sql`DELETE FROM users WHERE id IN (${ownerA}, ${ownerB}, ${ownerSq}, ${clientUser}, ${strangerUser})`;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

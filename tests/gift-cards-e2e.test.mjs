// Gift cards, end to end, for the owner and for the buyer / recipient.
//
//   [1] owner list starts empty and is scoped to the owner's workspace
//   [2] public purchase mints a checkout session with the right amount,
//       metadata and connected account; validation + "not set up" copy
//   [3] paid webhook issues the card ONCE (code emailed to the recipient,
//       balance, recipient, message); unpaid session issues nothing;
//       duplicate delivery (same PI, new event id) is a no-op
//   [4] /api/gift-cards/check validates a code, never leaks other cards,
//       other workspaces, or internal fields; per-IP rate limit
//   [5] redemption at a booking: exact debit, partial remainder, audit row,
//       depleted at zero, a card from workspace A is refused at workspace B
//   [6] a card can never go below zero
//   [7] cancelling the booking puts the credit back exactly once
//   [8] charge.refunded from the payment dashboard: partial refund trims the
//       balance, full refund voids the card, re-delivery is a no-op
//   [9] an expired card is refused at check and at booking
//  [10] owner list reflects everything; the other owner still sees nothing
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/gift-cards-e2e.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_gift';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_gift';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { normalizeCode, hashCode, redeemAtomic } from '../api/_lib/giftCards.js';
import ownerListHandler from '../api/gift-cards/index.js';
import checkHandler from '../api/gift-cards/check.js';
import checkoutHandler from '../api/gift-cards/checkout.js';
import publicBookingHandler from '../api/calendar/public/[slug].js';
import ownerBookingHandler from '../api/calendar/bookings/[id].js';
import platformWebhook from '../api/webhooks/stripe-platform.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Outbound network is mocked: Stripe + the mail provider ───────────
const stripeCalls = [];
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (/\/checkout\/sessions$/.test(u)) return json({ id: `cs_${stripeCalls.length}`, url: `https://checkout.example/cs_${stripeCalls.length}` });
    return json({});
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

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
const HOST = 'www.joinivy.ai';
const req = ({ method = 'GET', cookie, query = {}, body = {}, ip = '198.18.7.1' } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': ip,
    ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

let evtN = 0;
async function fire(type, object, acct, eventId = null) {
  const payload = JSON.stringify({ id: eventId || `evt_gc_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const paidGiftSession = ({ id, pi, wid, amount, recipientEmail, message }) => ({
  id, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: pi, amount_total: amount,
  metadata: { purpose: 'gift_card', workspace_id: wid, amount_cents: String(amount),
    sender_name: 'Pat Sender', sender_email: `pat-${STAMP}@example.com`,
    recipient_name: 'Sam Recipient', recipient_email: recipientEmail, ...(message ? { gift_message: message } : {}) },
});

const STAMP = Date.now();
// What a person reads: HTML comments are not rendered.
const visible = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const noVendor = (s) => !/stripe|square|paypal|business os/i.test(visible(s));
const noEmDash = (s) => !/—/.test(visible(s));

// A business with an active subscription, a booking page and a connected
// card processor (platform Connect account id).
async function mkBiz(label, { connected = true } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`gc-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  const slug = `gc-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const acct = `acct_gc_${label}_${STAMP}`;
  if (connected) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status)
      VALUES (${wid}, ${acct}, 'complete')`;
  }
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, 'Session', 50, 60, 'public') RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, acct, svc, cookie: `ivy_session=${signSession(u)}` };
}
// A Tuesday 7 to 13 days out: inside the default horizon, past the 24h
// notice, inside the default Tue 9:00 to 17:00 availability.
function nextBookableDate() {
  const d = new Date(Date.now() + 7 * 864e5);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const cardRow = (id) => sql`SELECT * FROM gift_cards WHERE id = ${id}`.then((r) => r.rows[0]);

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('A');
  const B = await mkBiz('B');
  const C = await mkBiz('C', { connected: false });
  const date = nextBookableDate();

  console.log('\n[1] owner list starts empty and is scoped to the workspace');
  let r = await call(ownerListHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.cards.length === 0 && r.body.summary.total === 0, 'owner A: no cards, summary zero');

  console.log('\n[2] public purchase mints a checkout session');
  const recipientEmail = `sam-${STAMP}@example.com`;
  const buy = (over = {}, ip = '198.18.7.2') => call(checkoutHandler, req({ method: 'POST', ip, body: {
    slug: A.slug, amountCents: 7500, senderName: 'Pat Sender', senderEmail: `pat-${STAMP}@example.com`,
    recipientName: 'Sam Recipient', recipientEmail, message: 'Happy birthday!', ...over } }));
  r = await buy();
  assert(r.statusCode === 200 && /^https:\/\/checkout\.example\//.test(r.body.url), `checkout → 200 with redirect url (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const cs = stripeCalls.find((c) => /checkout\/sessions$/.test(c.url));
  assert(!!cs && cs.headers['Stripe-Account'] === A.acct, 'session is created on the connected account (Stripe-Account header)');
  assert(cs?.body['line_items[0][price_data][unit_amount]'] === '7500' && cs?.body.mode === 'payment', 'amount $75.00, one-time payment');
  assert(cs?.body['metadata[purpose]'] === 'gift_card' && cs?.body['metadata[workspace_id]'] === A.wid && cs?.body['metadata[amount_cents]'] === '7500', 'metadata carries purpose / workspace / amount');
  assert(cs?.body['metadata[recipient_email]'] === recipientEmail && cs?.body['metadata[gift_message]'] === 'Happy birthday!', 'metadata carries recipient + message');
  assert(cs?.body.success_url?.includes(`/book/${A.slug}?giftcard=ok`), 'success url returns to the booking page');
  r = await buy({ amountCents: 1234 });
  assert(r.statusCode === 400, 'off-ladder amount is refused');
  r = await buy({ recipientEmail: 'nope' });
  assert(r.statusCode === 400, 'invalid recipient email is refused');
  r = await buy({ slug: 'no-such-handle' });
  assert(r.statusCode === 404, 'unknown handle → 404');
  r = await buy({ slug: C.slug });
  assert(r.statusCode === 400 && noVendor(r.body.error) && noEmDash(r.body.error), `business without card payments → plain "not set up" message (${r.body.error})`);

  console.log('\n[3] paid webhook issues the card once; unpaid issues nothing');
  const unpaid = { ...paidGiftSession({ id: 'cs_gc_unpaid', pi: `pi_gc_unpaid_${STAMP}`, wid: A.wid, amount: 7500, recipientEmail }), payment_status: 'unpaid' };
  r = await fire('checkout.session.completed', unpaid, A.acct);
  assert(r.statusCode === 200 && /awaiting settlement/.test(r.body.ignored || ''), 'unpaid session is not fulfilled');
  assert((await sql`SELECT COUNT(*)::int AS n FROM gift_cards WHERE workspace_id = ${A.wid}`).rows[0].n === 0, 'no card issued for the unpaid session');

  const pi1 = `pi_gc_1_${STAMP}`;
  const paid = paidGiftSession({ id: 'cs_gc_1', pi: pi1, wid: A.wid, amount: 7500, recipientEmail, message: 'Happy birthday!' });
  emails.length = 0;
  r = await fire('checkout.session.completed', paid, A.acct, `evt_gc_paid_${STAMP}`);
  assert(r.statusCode === 200 && r.body.marked === 'gift-card-issued', `paid session issues the card (${JSON.stringify(r.body)})`);
  await settle();
  const cards = (await sql`SELECT * FROM gift_cards WHERE workspace_id = ${A.wid} ORDER BY created_at`).rows;
  assert(cards.length === 1, 'exactly one card issued');
  const card = cards[0];
  assert(Number(card.original_amount_cents) === 7500 && Number(card.balance_cents) === 7500 && card.status === 'active', 'balance $75.00, active');
  assert(card.recipient_email === recipientEmail && card.recipient_name === 'Sam Recipient' && card.message === 'Happy birthday!' && card.sender_name === 'Pat Sender', 'recipient, sender and message recorded');
  assert(card.stripe_payment_intent === pi1, 'payment intent stored for refunds');
  const mail = emails.find((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(recipientEmail));
  assert(!!mail, 'recipient got an email');
  const code = (String(mail?.html || '').match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/) || [])[0];
  assert(!!code, `email contains the code (${code})`);
  assert(code && hashCode(normalizeCode(code)) === card.code_hash && card.code_last4 === normalizeCode(code).slice(-4), 'emailed code hashes to the stored card; last4 matches');
  assert(/75\.00/.test(mail?.html || '') && /Happy birthday!/.test(mail?.html || ''), 'email shows the balance and the message');
  assert(noVendor(mail?.html) && noEmDash(mail?.html), 'recipient email names no vendor and has no em dash');
  // The buyer gets a receipt: the amount and who it went to, never the code.
  const receipts = emails.filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(`pat-${STAMP}@example.com`));
  assert(receipts.length === 1, `buyer got exactly one receipt (${receipts.length})`);
  assert(/Receipt: gift card for Sam Recipient/.test(receipts[0]?.subject || '') && /75\.00/.test(receipts[0]?.subject || ''), `receipt subject carries recipient + amount (${receipts[0]?.subject})`);
  assert(/75\.00/.test(receipts[0]?.html || '') && /Sam Recipient/.test(receipts[0]?.html || '') && !/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.test(receipts[0]?.html || ''), 'receipt shows the amount and recipient, not the code');
  assert(noVendor(receipts[0]?.html) && noEmDash(receipts[0]?.html), 'receipt names no vendor and has no em dash');

  r = await fire('checkout.session.completed', paid, A.acct, `evt_gc_paid_${STAMP}`);
  assert(r.body?.deduped === true, 'same event id is deduped');
  r = await fire('checkout.session.completed', paid, A.acct);
  assert(r.statusCode === 200 && /already issued/.test(r.body.ignored || ''), 'replay with a new event id is a no-op');
  r = await fire('checkout.session.async_payment_succeeded', paid, A.acct);
  assert(/already issued/.test(r.body.ignored || ''), 'async_payment_succeeded after a paid completion is a no-op');
  assert((await sql`SELECT COUNT(*)::int AS n FROM gift_cards WHERE workspace_id = ${A.wid}`).rows[0].n === 1, 'still exactly one card');
  assert(emails.filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(`pat-${STAMP}@example.com`)).length === 1, 'replays sent the buyer no second receipt');

  console.log('\n[4] /api/gift-cards/check validates a code without leaking anything');
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code } }));
  assert(r.statusCode === 200 && r.body.card.balanceCents === 7500 && r.body.card.codeLast4 === card.code_last4, 'valid code → balance + last4');
  assert(Object.keys(r.body.card).sort().join(',') === 'balanceCents,codeLast4,expiresAt', `response carries only balance / last4 / expiry (${Object.keys(r.body.card)})`);
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code: code.toLowerCase().replace(/-/g, ' ') } }));
  assert(r.statusCode === 200, 'code is accepted in any case / spacing');
  r = await call(checkHandler, req({ method: 'POST', body: { slug: B.slug, code } }));
  assert(r.statusCode === 404, "workspace A's card is unknown at workspace B");
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code: 'ZZZZ-ZZZZ-ZZZZ' } }));
  assert(r.statusCode === 404, 'wrong code → 404');
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code: 'AB' } }));
  assert(r.statusCode === 404, 'too-short code → 404 (no DB match attempted)');
  let limited = null;
  for (let i = 0; i < 31 && !limited; i++) {
    const rr = await call(checkHandler, req({ method: 'POST', ip: '198.18.7.99', body: { slug: A.slug, code: 'ZZZZ-ZZZZ-ZZZZ' } }));
    if (rr.statusCode === 429) limited = i + 1;
  }
  assert(limited === 31, `31st check from one IP in an hour is rate limited (hit at ${limited})`);

  console.log('\n[5] redemption at booking: exact debit, remainder, audit row, workspace isolation');
  const book = (biz, over = {}, ip = '198.18.7.3') => call(publicBookingHandler, req({ method: 'POST', ip, query: { slug: biz.slug }, body: {
    serviceId: biz.svc, date, startMin: 600, endMin: 660, clientName: 'Casey Client', clientEmail: `casey-${STAMP}@example.com`, ...over } }));
  r = await book(B, { giftCardCode: code });
  assert(r.statusCode === 400 && /gift card code/i.test(r.body.error), "booking at workspace B with A's code is refused");
  assert(Number((await cardRow(card.id)).balance_cents) === 7500, 'balance untouched by the refused attempt');

  r = await book(A, { giftCardCode: code });
  assert(r.statusCode === 201, `booking with the code → 201 (${JSON.stringify(r.body).slice(0, 200)})`);
  const booking1 = r.body.booking;
  let c = await cardRow(card.id);
  assert(Number(c.balance_cents) === 2500 && c.status === 'active', `$50 service debits exactly $50; $25 remains (balance ${c.balance_cents})`);
  const b1 = (await sql`SELECT gift_card_credit_cents, deposit_required FROM bookings WHERE id = ${booking1.id}`).rows[0];
  assert(Number(b1.gift_card_credit_cents) === 5000, 'booking records the $50 credit');
  let reds = (await sql`SELECT * FROM gift_card_redemptions WHERE gift_card_id = ${card.id} ORDER BY created_at`).rows;
  assert(reds.length === 1 && Number(reds[0].amount_cents) === 5000 && reds[0].applied_to_kind === 'booking' && reds[0].applied_to_id === booking1.id && reds[0].workspace_id === A.wid, 'redemption audit row written');
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code } }));
  assert(r.body?.card?.balanceCents === 2500, 'check shows the remainder');

  r = await book(A, { giftCardCode: code, startMin: 720, endMin: 780 });
  assert(r.statusCode === 201, 'second booking with the remainder → 201');
  const booking2 = r.body.booking;
  c = await cardRow(card.id);
  assert(Number(c.balance_cents) === 0 && c.status === 'depleted', 'partial cover: card drains to $0 and becomes depleted');
  assert(Number((await sql`SELECT gift_card_credit_cents FROM bookings WHERE id = ${booking2.id}`).rows[0].gift_card_credit_cents) === 2500, 'second booking records the $25 credit only');
  reds = (await sql`SELECT SUM(amount_cents)::int AS s FROM gift_card_redemptions WHERE gift_card_id = ${card.id}`).rows;
  assert(Number(reds[0].s) === 7500, 'redemptions add up to the card value');
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code } }));
  assert(r.statusCode === 404, 'a depleted card no longer validates');
  r = await book(A, { giftCardCode: code, startMin: 840, endMin: 900 });
  assert(r.statusCode === 400, 'a depleted card cannot be applied to a booking');

  console.log('\n[6] a card can never go below zero');
  await sql`UPDATE gift_cards SET balance_cents = 1000, status = 'active' WHERE id = ${card.id}`;
  let threw = null;
  try { await redeemAtomic({ giftCardId: card.id, workspaceId: A.wid, amountCents: 1001, appliedToKind: 'booking', appliedToId: booking1.id, clientId: null }); }
  catch (e) { threw = e; }
  assert(threw?.code === 'insufficient' && Number((await cardRow(card.id)).balance_cents) === 1000, 'overspend is refused and the balance is unchanged');
  threw = null;
  try { await redeemAtomic({ giftCardId: card.id, workspaceId: B.wid, amountCents: 100, appliedToKind: 'booking', appliedToId: booking1.id, clientId: null }); }
  catch (e) { threw = e; }
  assert(threw?.code === 'insufficient' && Number((await cardRow(card.id)).balance_cents) === 1000, 'redeemAtomic scoped by workspace: B cannot debit A\'s card');
  await sql`DELETE FROM gift_card_redemptions WHERE gift_card_id = ${card.id} AND amount_cents = 1001`;
  await sql`UPDATE gift_cards SET balance_cents = 0, status = 'depleted' WHERE id = ${card.id}`;

  console.log('\n[7] cancelling the booking restores the credit exactly once');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: booking2.id } }));
  assert(r.statusCode === 204, 'owner cancels booking 2');
  await settle();
  c = await cardRow(card.id);
  assert(Number(c.balance_cents) === 2500 && c.status === 'active', 'the $25 goes back on the card, card is active again');
  assert(Number((await sql`SELECT gift_card_credit_cents FROM bookings WHERE id = ${booking2.id}`).rows[0].gift_card_credit_cents) === 0, 'booking no longer carries the credit');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: booking2.id } }));
  assert(r.statusCode === 404 && Number((await cardRow(card.id)).balance_cents) === 2500, 'cancelling again does not restore twice');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: B.cookie, query: { id: booking1.id } }));
  assert(r.statusCode === 404 && Number((await cardRow(card.id)).balance_cents) === 2500, "owner B cannot cancel A's booking (no credit movement)");

  console.log('\n[8] charge.refunded from the payment dashboard');
  const pi2 = `pi_gc_2_${STAMP}`;
  const recipient2 = `sam2-${STAMP}@example.com`;
  r = await fire('checkout.session.completed', paidGiftSession({ id: 'cs_gc_2', pi: pi2, wid: A.wid, amount: 10000, recipientEmail: recipient2 }), A.acct);
  assert(r.body.marked === 'gift-card-issued', 'second card ($100) issued');
  const card2 = (await sql`SELECT * FROM gift_cards WHERE stripe_payment_intent = ${pi2}`).rows[0];
  r = await fire('charge.refunded', { id: 'ch_gc_2', payment_intent: pi2, amount: 10000, amount_refunded: 2500 }, A.acct);
  assert(r.body.applied === 'gift-card-refund-synced' && r.body.fully === false, `partial refund synced (${JSON.stringify(r.body)})`);
  c = await cardRow(card2.id);
  assert(Number(c.balance_cents) === 7500 && c.status === 'active' && Number(c.refunded_cents) === 2500, 'partial refund trims the balance to $75');
  let refundMails = emails.filter((e) => /Refund issued/.test(e.subject || '') && (Array.isArray(e.to) ? e.to : [e.to]).includes(`pat-${STAMP}@example.com`));
  assert(refundMails.length === 1 && /25\.00/.test(refundMails[0].subject) && /partial refund/.test(refundMails[0].html), `buyer emailed once about the $25 partial refund (${refundMails.length})`);
  r = await fire('charge.refunded', { id: 'ch_gc_2', payment_intent: pi2, amount: 10000, amount_refunded: 2500 }, A.acct);
  assert(r.body.ignored === 'refund already recorded' && Number((await cardRow(card2.id)).balance_cents) === 7500, 're-delivery of the same cumulative refund is a no-op');
  refundMails = emails.filter((e) => /Refund issued/.test(e.subject || '') && (Array.isArray(e.to) ? e.to : [e.to]).includes(`pat-${STAMP}@example.com`));
  assert(refundMails.length === 1, 're-delivery sends no second refund email');
  r = await fire('charge.refunded', { id: 'ch_gc_2', payment_intent: pi2, amount: 10000, amount_refunded: 10000 }, A.acct);
  assert(r.body.applied === 'gift-card-refund-synced' && r.body.fully === true, 'full refund synced');
  c = await cardRow(card2.id);
  assert(Number(c.balance_cents) === 0 && c.status === 'voided', 'full refund voids the card and zeroes the balance');
  await settle();
  r = await fire('charge.refunded', { id: 'ch_gc_x', payment_intent: pi2, amount: 10000, amount_refunded: 10000 }, B.acct);
  assert(r.body.ignored === 'no purchase for payment_intent', "a refund event on workspace B's account cannot touch A's card");
  r = await fire('charge.refunded', { id: 'ch_none', payment_intent: 'pi_unknown', amount: 100, amount_refunded: 100 }, A.acct);
  assert(r.statusCode === 200 && r.body.ignored === 'no purchase for payment_intent', 'unknown payment intent is acknowledged quietly');

  console.log('\n[9] an expired card is refused');
  const pi3 = `pi_gc_3_${STAMP}`;
  r = await fire('checkout.session.completed', paidGiftSession({ id: 'cs_gc_3', pi: pi3, wid: A.wid, amount: 2500, recipientEmail: `sam3-${STAMP}@example.com` }), A.acct);
  const card3 = (await sql`SELECT * FROM gift_cards WHERE stripe_payment_intent = ${pi3}`).rows[0];
  const mail3 = emails.find((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(`sam3-${STAMP}@example.com`));
  const code3 = (String(mail3?.html || '').match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/) || [])[0];
  assert(!!code3 && hashCode(normalizeCode(code3)) === card3.code_hash, 'third card issued with its emailed code');
  await sql`UPDATE gift_cards SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${card3.id}`;
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code: code3 } }));
  assert(r.statusCode === 404, 'expired card fails check');
  r = await book(A, { giftCardCode: code3, startMin: 900, endMin: 960 });
  assert(r.statusCode === 400 && Number((await cardRow(card3.id)).balance_cents) === 2500, 'expired card cannot be applied; balance untouched');
  await sql`UPDATE gift_cards SET expires_at = NOW() + INTERVAL '30 days' WHERE id = ${card3.id}`;
  r = await call(checkHandler, req({ method: 'POST', body: { slug: A.slug, code: code3 } }));
  assert(r.statusCode === 200 && !!r.body.card.expiresAt, 'future expiry is reported to the buyer');

  console.log('\n[10] owner list reflects everything; the other owner sees nothing');
  r = await call(ownerListHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.cards.length === 3, `owner A sees 3 cards (${r.body.cards?.length})`);
  const s = r.body.summary;
  assert(s.total === 3 && s.issuedCents === 20000 && s.outstandingCents === 5000, `summary: issued $200, outstanding $50 (${JSON.stringify(s)})`);
  assert(s.redeemedCents === 5000 && s.refundedCents === 10000, `summary: redeemed $50 (refunded $100 is not "redeemed")`);
  assert(r.body.cards.every((x) => !('codeHash' in x) && !('code_hash' in x) && x.codeLast4?.length === 4), 'owner list shows last4 only, never the hash');
  const statuses = r.body.cards.map((x) => x.status).sort().join(',');
  assert(statuses === 'active,active,voided', `statuses: ${statuses}`);
  r = await call(ownerListHandler, req({ cookie: B.cookie }));
  assert(r.statusCode === 200 && r.body.cards.length === 0, "owner B sees none of A's cards");
  r = await call(ownerListHandler, req({}));
  assert(r.statusCode === 401, 'anonymous owner list → 401');

  // Cleanup
  for (const w of [A, B, C]) {
    await sql`DELETE FROM gift_cards WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM bookings WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${w.wid}`;
    await sql`DELETE FROM users WHERE id = ${w.userId}`;
  }
  await sql`DELETE FROM rate_limits WHERE key LIKE 'gc-%' OR key LIKE 'book:%'`.catch(() => {});
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});

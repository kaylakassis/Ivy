// In-app refunds for programs, gift cards and packages, end to end through
// the real owner endpoints, with the processor and the mail provider mocked
// and the payment-dashboard webhook arriving as signed payloads.
//
//   [1] program: owner-only + same-origin + workspace-scoped; over-refund 400;
//       partial keeps access, records refunded_cents, hits the processor on
//       the connected account with an idempotency key, emails the client
//       once, writes an audit row; two racing requests apply once (the
//       loser is deduped); the remainder closes the enrollment; the
//       dashboard echo is a no-op (no second state change, no second
//       email); a further refund is a 400; subscriptions and manual grants
//       are refused with plain copy
//   [2] gift card: partial trims the balance, full voids the card, the
//       buyer is emailed once per refund, the echo is a no-op, over-refund 400,
//       another owner cannot reach it
//   [3] package: partial recorded (bundle untouched), full cancels the
//       bundle and zeroes credits, echo no-op, over-refund 400, an
//       owner-sold bundle with no online payment has nothing to refund
//   [4] copy rules on every client email
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/purchase-refunds.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_prefund';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_prefund';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import programsIndex from '../api/programs/index.js';
import programById from '../api/programs/[id].js';
import programMembers from '../api/programs/[id]/members.js';
import programRefund from '../api/programs/refund.js';
import giftCardRefund from '../api/gift-cards/refund.js';
import giftCardList from '../api/gift-cards/index.js';
import packageRefund from '../api/packages/refund.js';
import packagesHandler from '../api/packages/index.js';
import clientPackagesHandler from '../api/clients/[id]/packages.js';
import mePrograms from '../api/me/programs/index.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const stripeCalls = [];
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (/\/refunds$/.test(u)) return json({ id: `re_${init.headers?.['Idempotency-Key'] || stripeCalls.length}`, amount: Number(body.amount || 0), status: 'succeeded' });
    if (/\/checkout\/sessions$/.test(u)) return json({ id: `cs_${stripeCalls.length}`, url: `https://checkout.example/cs_${stripeCalls.length}` });
    if (/\/customers\?/.test(u)) return json({ data: [] });
    if (/\/customers$/.test(u)) return json({ id: `cus_${stripeCalls.length}` });
    return json({});
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const refundCalls = () => stripeCalls.filter((c) => /\/refunds$/.test(c.url));
const toList = (e) => (Array.isArray(e?.to) ? e.to : [e?.to]);
const refundMailsTo = (email) => emails.filter((e) => /Refund issued/.test(e.subject || '') && toList(e).includes(email));
const visible = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const noVendor = (s) => !/stripe|square|paypal|resend|business os/i.test(visible(s));
const noEmDash = (s) => !/—/.test(visible(s));

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
const req = ({ method = 'GET', cookie, query = {}, body = {}, ip = '198.18.10.1', origin = `https://${HOST}` } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin, host: HOST, 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_pr_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const STAMP = Date.now();

async function mkBiz(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pr-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `pr-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const acct = `acct_pr_${label}_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${acct}, 'complete')`;
  return { userId: u, wid, slug, acct, cookie: `ivy_session=${signSession(u)}` };
}
async function mkClient(label, biz) {
  const email = `pr-client-${label}-${STAMP}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Casey Client', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id) VALUES (${biz.wid}, 'Casey Client', ${email}, 'active', ${u}) RETURNING id`).rows[0].id;
  return { userId: u, clientId: c, email, cookie: `ivy_session=${signSession(u)}` };
}
const enrollment = (id) => sql`SELECT * FROM program_enrollments WHERE id = ${id}`.then((r) => r.rows[0]);
const cardRow = (id) => sql`SELECT * FROM gift_cards WHERE id = ${id}`.then((r) => r.rows[0]);
const cpRow = (id) => sql`SELECT * FROM client_packages WHERE id = ${id}`.then((r) => r.rows[0]);
const audits = (wid, action) => sql`SELECT * FROM audit_events WHERE workspace_id = ${wid} AND action = ${action}`.then((r) => r.rows);

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('A');
  const B = await mkBiz('B');
  const casey = await mkClient('casey', A);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] program purchase');
  let r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'Mobility Reset', priceCents: 4900, billing: 'one_time', accessDays: 60 } }));
  const prog = r.body.program;
  assert(r.statusCode === 201 && prog?.id, 'program created');
  await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: prog.id }, body: { status: 'published' } }));
  const piProg = `pi_pr_prog_${STAMP}`;
  r = await fire('checkout.session.completed', {
    id: `cs_pr_prog_${STAMP}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 4900, payment_intent: piProg,
    metadata: { workspace_id: A.wid, program_id: prog.id, client_id: casey.clientId, purpose: 'program' },
  }, A.acct);
  assert(r.body.applied === 'program-purchase', 'client bought the program');
  r = await call(programById, req({ cookie: A.cookie, query: { id: prog.id } }));
  const member = r.body.members[0];
  assert(member && member.refundable === true && member.refundedCents === 0 && member.priceCents === 4900, `member row is refundable (${JSON.stringify(member).slice(0, 120)})`);
  const eid = member.id;

  const refundProgram = (over = {}, cookie = A.cookie, extra = {}) =>
    call(programRefund, req({ method: 'POST', cookie, body: { enrollmentId: eid, ...over }, ...extra }));

  r = await call(programRefund, req({ method: 'POST', body: { enrollmentId: eid } }));
  assert(r.statusCode === 401, 'anonymous → 401');
  r = await refundProgram({}, A.cookie, { origin: 'https://evil.example' });
  assert(r.statusCode === 403, 'cross-site origin → 403');
  r = await refundProgram({}, B.cookie);
  assert(r.statusCode === 400 && /not found/i.test(r.body.error), "owner B cannot refund A's purchase");
  r = await refundProgram({ amountCents: 5000 });
  assert(r.statusCode === 400 && /more than remaining/.test(r.body.error) && /\$49\.00/.test(r.body.error), `over-refund → 400 (${r.body.error})`);
  r = await refundProgram({ amountCents: 0 });
  assert(r.statusCode === 400, 'zero → 400');
  assert(refundCalls().length === 0 && (await enrollment(eid)).status === 'active', 'nothing reached the processor; access intact');

  emails.length = 0;
  r = await refundProgram({ amountCents: 1000, reason: 'requested_by_customer' });
  assert(r.statusCode === 200 && r.body.refund.amountCents === 1000 && r.body.refund.fullyRefunded === false && !r.body.refund.deduped, `partial $10 refund → 200 (${JSON.stringify(r.body.refund)})`);
  assert(r.body.member.refundedCents === 1000 && r.body.member.status === 'active' && r.body.member.refundable === true, 'member payload: $10 refunded, still active, still refundable');
  let rc = refundCalls();
  assert(rc.length === 1 && rc[0].body.payment_intent === piProg && rc[0].body.amount === '1000' && rc[0].body.reason === 'requested_by_customer', 'processor refund: right payment, $10, reason');
  assert(rc[0].headers['Stripe-Account'] === A.acct, 'issued on the connected account');
  assert(rc[0].headers['Idempotency-Key'] === `refund-program-${eid}-0`, `idempotency key = purchase + cumulative so far (${rc[0].headers['Idempotency-Key']})`);
  let e = await enrollment(eid);
  assert(e.status === 'active' && Number(e.refunded_cents) === 1000, 'enrollment: active, refunded_cents 1000');
  let mails = refundMailsTo(casey.email);
  assert(mails.length === 1 && /\$10\.00/.test(mails[0].subject) && /Mobility Reset/.test(mails[0].subject), `client emailed once (${mails[0]?.subject})`);
  assert(/partial refund/.test(mails[0].html) && /\$39\.00 of your payment stays applied/.test(mails[0].html) && /access to the program continues/.test(mails[0].html) && /5 to 10 business days/.test(mails[0].html), 'partial copy: what stays applied, access continues, 5 to 10 business days');
  let au = await audits(A.wid, 'program.refund');
  assert(au.length === 1 && au[0].meta.amount_cents === 1000 && au[0].meta.provider_refund_id === `re_refund-program-${eid}-0`, 'audit row with amount and provider refund id');

  // Two racing requests for another $10: both reach the processor with the
  // SAME idempotency key (it returns the original refund), exactly one
  // applies, the other is deduped.
  const [ra, rb] = await Promise.all([refundProgram({ amountCents: 1000 }), refundProgram({ amountCents: 1000 })]);
  const applied = [ra, rb].filter((x) => x.statusCode === 200 && !x.body.refund.deduped);
  const deduped = [ra, rb].filter((x) => x.statusCode === 200 && x.body.refund.deduped);
  assert(applied.length === 1 && deduped.length === 1, `racing duplicates: one applied, one deduped (${ra.statusCode}/${JSON.stringify(ra.body.refund)} vs ${rb.statusCode}/${JSON.stringify(rb.body.refund)})`);
  rc = refundCalls();
  assert(rc.length === 3 && rc[1].headers['Idempotency-Key'] === rc[2].headers['Idempotency-Key'], 'both used the same idempotency key, so the processor moved money once');
  e = await enrollment(eid);
  assert(Number(e.refunded_cents) === 2000 && e.status === 'active', 'refunded_cents 2000 (not 3000), still active');
  assert(refundMailsTo(casey.email).length === 2, 'the deduped request sent no email');

  // The remainder closes access.
  r = await refundProgram({});
  assert(r.statusCode === 200 && r.body.refund.amountCents === 2900 && r.body.refund.fullyRefunded === true, `remainder $29 → fully refunded (${JSON.stringify(r.body.refund)})`);
  e = await enrollment(eid);
  assert(e.status === 'cancelled' && !!e.cancelled_at && Number(e.refunded_cents) === 4900, 'enrollment closed, refunded_cents 4900');
  assert(r.body.member.refundable === false && r.body.member.status === 'cancelled', 'member payload no longer refundable');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(r.body.programs.length === 0, 'portal: access is gone');
  mails = refundMailsTo(casey.email);
  assert(mails.length === 3 && /\$29\.00/.test(mails[2].subject) && /fully refunded/.test(mails[2].html) && /access to the program has ended/.test(mails[2].html), 'full-refund email: fully refunded, access ended');

  // Dashboard echo of what Ivy already did: nothing changes, nobody is emailed.
  r = await fire('charge.refunded', { id: 'ch_prog', payment_intent: piProg, amount: 4900, amount_refunded: 4900 }, A.acct);
  assert(r.body.applied === 'program-refund' && r.body.result === 'already-cancelled', `echo → already-cancelled (${JSON.stringify(r.body)})`);
  r = await fire('charge.refunded', { id: 'ch_prog', payment_intent: piProg, amount: 4900, amount_refunded: 2000 }, A.acct);
  assert(r.body.result === 'already-recorded', 'a stale partial echo is already recorded');
  assert(refundMailsTo(casey.email).length === 3 && Number((await enrollment(eid)).refunded_cents) === 4900, 'echo: no email, no change');
  r = await refundProgram({});
  assert(r.statusCode === 400 && /already been fully refunded/.test(r.body.error), 'a further refund → 400');
  assert((await audits(A.wid, 'program.refund')).length === 3, 'three applied refunds, three audit rows');

  // Subscription program and a manual grant are not refundable here.
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'Monthly Club', priceCents: 2000, billing: 'month' } }));
  const subProg = r.body.program;
  await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, billing, price_cents, stripe_subscription_id, status)
    VALUES (${subProg.id}, ${A.wid}, ${casey.clientId}, 'subscription', 'month', 2000, ${`sub_pr_${STAMP}`}, 'active')`;
  const subE = (await sql`SELECT id FROM program_enrollments WHERE program_id = ${subProg.id}`).rows[0];
  r = await call(programRefund, req({ method: 'POST', cookie: A.cookie, body: { enrollmentId: subE.id } }));
  assert(r.statusCode === 400 && /subscription/i.test(r.body.error) && noVendor(r.body.error) && noEmDash(r.body.error), `subscription → 400 with plain copy (${r.body.error})`);
  r = await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: prog.id }, body: { name: 'Manny', email: `manny-${STAMP}@example.com` } }));
  r = await call(programRefund, req({ method: 'POST', cookie: A.cookie, body: { enrollmentId: r.body.enrollmentId } }));
  assert(r.statusCode === 400 && /not paid online/i.test(r.body.error), `manual grant → 400 (${r.body.error})`);
  r = await call(programRefund, req({ method: 'POST', cookie: A.cookie, body: { enrollmentId: 'nope' } }));
  assert(r.statusCode === 400 && /not found/i.test(r.body.error), 'non-uuid id → 400, not a 500');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] gift card');
  const buyer = `pat-pr-${STAMP}@example.com`;
  const piCard = `pi_pr_card_${STAMP}`;
  r = await fire('checkout.session.completed', {
    id: `cs_pr_card_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: piCard, amount_total: 10000,
    metadata: { purpose: 'gift_card', workspace_id: A.wid, amount_cents: '10000', sender_name: 'Pat Sender', sender_email: buyer,
      recipient_name: 'Sam Recipient', recipient_email: `sam-pr-${STAMP}@example.com` },
  }, A.acct);
  const card = (await sql`SELECT * FROM gift_cards WHERE stripe_payment_intent = ${piCard}`).rows[0];
  assert(r.body.marked === 'gift-card-issued' && Number(card.balance_cents) === 10000, '$100 card issued');
  // $30 of it was already spent at a booking.
  await sql`UPDATE gift_cards SET balance_cents = 7000 WHERE id = ${card.id}`;
  r = await call(giftCardList, req({ cookie: A.cookie }));
  assert(r.body.cards.find((c) => c.id === card.id)?.paidOnline === true, 'owner list says the card was paid online (refundable)');

  const refundCard = (over = {}, cookie = A.cookie) => call(giftCardRefund, req({ method: 'POST', cookie, body: { id: card.id, ...over } }));
  r = await refundCard({}, B.cookie);
  assert(r.statusCode === 400 && /not found/i.test(r.body.error), "owner B cannot refund A's card");
  r = await refundCard({ amountCents: 10001 });
  assert(r.statusCode === 400 && /more than remaining/.test(r.body.error), 'over-refund → 400');
  emails.length = 0; stripeCalls.length = 0;
  r = await refundCard({ amountCents: 2500 });
  assert(r.statusCode === 200 && r.body.refund.amountCents === 2500 && r.body.refund.fullyRefunded === false, `partial $25 → 200 (${JSON.stringify(r.body.refund)})`);
  assert(r.body.card.balanceCents === 4500 && r.body.card.refundedCents === 2500 && r.body.card.status === 'active', 'card payload: balance trimmed to $45, $25 refunded, active');
  rc = refundCalls();
  assert(rc.length === 1 && rc[0].body.payment_intent === piCard && rc[0].body.amount === '2500' && rc[0].headers['Idempotency-Key'] === `refund-gift_card-${card.id}-0`, 'processor refund for $25 with the per-purchase key');
  let c = await cardRow(card.id);
  assert(Number(c.balance_cents) === 4500 && Number(c.refunded_cents) === 2500 && c.status === 'active', 'db: same state the dashboard path produces');
  mails = refundMailsTo(buyer);
  assert(mails.length === 1 && /\$25\.00/.test(mails[0].subject) && new RegExp(`gift card ending ${card.code_last4}`).test(mails[0].subject) && /partial refund/.test(mails[0].html) && /balance on the gift card has been lowered/.test(mails[0].html), `buyer emailed once about the partial (${mails[0]?.subject})`);
  r = await fire('charge.refunded', { id: 'ch_card', payment_intent: piCard, amount: 10000, amount_refunded: 2500 }, A.acct);
  assert(r.body.ignored === 'refund already recorded' && Number((await cardRow(card.id)).balance_cents) === 4500 && refundMailsTo(buyer).length === 1, 'dashboard echo: no double-apply, no second email');
  r = await refundCard({});
  assert(r.statusCode === 200 && r.body.refund.amountCents === 7500 && r.body.refund.fullyRefunded === true, `remainder $75 → fully refunded (${JSON.stringify(r.body.refund)})`);
  c = await cardRow(card.id);
  assert(Number(c.balance_cents) === 0 && c.status === 'voided' && Number(c.refunded_cents) === 10000, 'full refund voids the card and zeroes the balance');
  mails = refundMailsTo(buyer);
  assert(mails.length === 2 && /fully refunded/.test(mails[1].html) && /can no longer be used/.test(mails[1].html), 'full-refund email: card can no longer be used');
  r = await fire('charge.refunded', { id: 'ch_card', payment_intent: piCard, amount: 10000, amount_refunded: 10000 }, A.acct);
  assert(r.body.ignored === 'refund already recorded' && refundMailsTo(buyer).length === 2, 'full echo is a no-op');
  r = await refundCard({});
  assert(r.statusCode === 400 && /fully refunded/.test(r.body.error), 'a further refund → 400');
  assert((await audits(A.wid, 'gift_card.refund')).length === 2, 'two audit rows for the card');
  r = await call(giftCardList, req({ cookie: A.cookie }));
  const summary = r.body.summary;
  assert(summary.refundedCents === 10000 && summary.redeemedCents === 0, `owner summary: $100 refunded, nothing counted as redeemed (${JSON.stringify(summary)})`);
  // An owner-issued card (no online payment) has nothing to refund.
  const manual = (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, status)
    VALUES (${A.wid}, ${`hash-${STAMP}`}, 'MANL', 5000, 5000, 'active') RETURNING id`).rows[0];
  r = await call(giftCardRefund, req({ method: 'POST', cookie: A.cookie, body: { id: manual.id } }));
  assert(r.statusCode === 400 && /not paid online/i.test(r.body.error), 'owner-issued card → 400');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] package');
  r = await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: '5 Cuts', sessionCount: 5, price: 180, expiryDays: 90 } }));
  const pkg = r.body.package;
  const piPkg = `pi_pr_pkg_${STAMP}`;
  r = await fire('checkout.session.completed', {
    id: `cs_pr_pkg_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: piPkg, amount_total: 18000,
    metadata: { purpose: 'package', workspace_id: A.wid, package_id: pkg.id, client_id: casey.clientId },
  }, A.acct);
  assert(r.body.applied === 'package-provisioned', 'client bought the package');
  const cp = (await sql`SELECT * FROM client_packages WHERE stripe_payment_intent = ${piPkg}`).rows[0];
  r = await call(clientPackagesHandler, req({ cookie: A.cookie, query: { id: casey.clientId } }));
  assert(r.body.packages[0]?.paidOnline === true && r.body.packages[0]?.refundedCents === 0, 'owner client packages list says paid online');

  const refundPkg = (over = {}, cookie = A.cookie) => call(packageRefund, req({ method: 'POST', cookie, body: { id: cp.id, ...over } }));
  r = await refundPkg({}, B.cookie);
  assert(r.statusCode === 400 && /not found/i.test(r.body.error), "owner B cannot refund A's bundle");
  r = await refundPkg({ amountCents: 18001 });
  assert(r.statusCode === 400 && /more than remaining/.test(r.body.error), 'over-refund → 400');
  emails.length = 0; stripeCalls.length = 0;
  r = await refundPkg({ amountCents: 5000 });
  assert(r.statusCode === 200 && r.body.refund.amountCents === 5000 && r.body.refund.fullyRefunded === false, `partial $50 → 200 (${JSON.stringify(r.body.refund)})`);
  assert(r.body.package.status === 'active' && r.body.package.creditsRemaining === 5 && r.body.package.refundedCents === 5000, 'partial: bundle untouched, $50 recorded');
  rc = refundCalls();
  assert(rc.length === 1 && rc[0].body.payment_intent === piPkg && rc[0].body.amount === '5000' && rc[0].headers['Idempotency-Key'] === `refund-package-${cp.id}-0`, 'processor refund for $50 with the per-purchase key');
  mails = refundMailsTo(casey.email);
  assert(mails.length === 1 && /\$50\.00/.test(mails[0].subject) && /5 Cuts/.test(mails[0].subject) && /\$130\.00 of your payment stays applied/.test(mails[0].html), `client emailed once (${mails[0]?.subject})`);
  r = await fire('charge.refunded', { id: 'ch_pkg', payment_intent: piPkg, amount: 18000, amount_refunded: 5000 }, A.acct);
  assert(r.body.ignored === 'refund already recorded' && refundMailsTo(casey.email).length === 1, 'dashboard echo: no-op, no second email');
  r = await refundPkg({});
  assert(r.statusCode === 200 && r.body.refund.amountCents === 13000 && r.body.refund.fullyRefunded === true, `remainder $130 → fully refunded (${JSON.stringify(r.body.refund)})`);
  let p = await cpRow(cp.id);
  assert(p.status === 'cancelled' && Number(p.credits_remaining) === 0 && Number(p.refunded_cents) === 18000, 'full refund cancels the bundle and zeroes credits');
  mails = refundMailsTo(casey.email);
  assert(mails.length === 2 && /fully refunded/.test(mails[1].html) && /remaining sessions on this package have been cancelled/.test(mails[1].html), 'full-refund email: sessions cancelled');
  r = await fire('charge.refunded', { id: 'ch_pkg', payment_intent: piPkg, amount: 18000, amount_refunded: 18000 }, A.acct);
  assert(r.body.ignored === 'refund already recorded' && refundMailsTo(casey.email).length === 2, 'full echo is a no-op');
  r = await refundPkg({});
  assert(r.statusCode === 400 && /fully refunded/.test(r.body.error), 'a further refund → 400');
  assert((await audits(A.wid, 'package.refund')).length === 2, 'two audit rows for the package');
  // Owner-sold bundle: no online payment to refund.
  r = await call(clientPackagesHandler, req({ method: 'POST', cookie: A.cookie, query: { id: casey.clientId }, body: { packageId: pkg.id } }));
  const sold = r.body.package;
  r = await call(packageRefund, req({ method: 'POST', cookie: A.cookie, body: { id: sold.id } }));
  assert(r.statusCode === 400 && /not paid online/i.test(r.body.error) && noEmDash(r.body.error), `owner-sold bundle → 400 (${r.body.error})`);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] copy rules');
  const everything = emails.map((e) => e.subject + e.html).join('\n');
  assert(noVendor(everything) && noEmDash(everything), 'no vendor names, no em dashes, never "business OS" in any client email');
  assert(!/<script/i.test(everything), 'no scripts');

  for (const w of [A, B]) {
    await sql`DELETE FROM gift_cards WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${w.wid}`;
    await sql`DELETE FROM users WHERE id = ${w.userId}`;
  }
  await sql`DELETE FROM users WHERE id = ${casey.userId}`;
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});

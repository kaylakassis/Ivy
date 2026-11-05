// Cancellation policy + the money it governs, end to end.
//
//   [1]  owner writes the policy: versions, no-op on same text, caps, the
//        switch needs text first, workspace isolation
//   [2]  records are append-only (versions + acceptances) and go away only
//        with the workspace
//   [3]  booking page with the switch on: no box → refused, older app →
//        booked + "not accepted", stale version → 409, ticked → stored
//        with the exact text, hash, version, fees, IP, browser, name, email
//   [4]  owner sees acceptances (client profile, booking), printable record
//        escapes everything, other owners get nothing
//   [5]  package booking path honours the switch
//   [6]  website section + footer link render the latest text, escaped
//   [7]  client data export holds only the client's own acceptances
//   [8]  deposits: saved card at deposit checkout, card setup when no
//        deposit, webhook stores the card
//   [9]  client cancels before the window: NO refund until the owner taps
//        Refund (pending request, owner told); approve refunds exactly once;
//        Keep records who/when
//  [10]  client cancels inside the window: deposit kept, rest of the fee
//        charged exactly once (concurrent double cancel)
//  [11]  deposit larger than fee: nothing charged
//  [12]  declined card: no fee recorded, draft invoice once, owner told,
//        retry with a new card charges and voids the draft
//  [13]  no-show: deposit counts first, exactly once
//  [14]  owner cancels: never a fee, deposit refunded (or kept on request)
//  [15]  client agreed to a lower fee than today's: charged the agreed fee
//  [16]  time zones for the window
//  [17]  package sessions (agreed rule): "used when booked" late cancel /
//        no-show keeps the session and charges no fee; "used when
//        completed" releases the session and charges the fee once
//  [18]  dashboard refund (charge.refunded) is recorded, never refunded twice
//  [19]  currency follows the business
//  [20]  waitlist acceptance follows the promoted booking
//  [21]  owner-sent acceptance link
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/cancellation-policy.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_cpol';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_cpol';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import policyHandler from '../api/cancellation-policy/index.js';
import acceptancesHandler from '../api/cancellation-policy/acceptances.js';
import recordHandler from '../api/cancellation-policy/record.js';
import publicPolicyHandler from '../api/cancellation-policy/public.js';
import requestHandler from '../api/cancellation-policy/request.js';
import publicCalendarHandler from '../api/calendar/public/[slug].js';
import meBookingHandler from '../api/me/bookings/[id].js';
import meBookingsHandler from '../api/me/bookings.js';
import ownerBookingHandler from '../api/calendar/bookings/[id].js';
import noShowHandler from '../api/calendar/bookings/no-show.js';
import chargeFeeHandler from '../api/calendar/bookings/charge-fee.js';
import refundDepositHandler from '../api/calendar/bookings/refund-deposit.js';
import depositReviewsHandler from '../api/calendar/bookings/deposit-reviews.js';
import meBookHandler from '../api/me/packages/[id]/book.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import { buildClientPortalExport } from '../api/_lib/clientExport.js';
import { loadPublicSite } from '../api/_lib/publicSite.js';
import { renderSiteHtml } from '../api/_lib/siteHtml.js';
import { isInsideWindow, effectiveTerms } from '../api/_lib/bookingFees.js';
import { promoteWaitlistOnCancel } from '../api/_lib/waitlist.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Outbound network mocked: Stripe (with idempotency replay) + mail ────
const stripe = { calls: [], idem: new Map(), declinePm: new Set(), n: 0 };
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    const key = headers['Idempotency-Key'];
    if (key && stripe.idem.has(key)) {
      stripe.calls.push({ url: u, method, headers, body, replayed: true });
      return stripe.idem.get(key).clone();
    }
    stripe.calls.push({ url: u, method, headers, body });
    const n = ++stripe.n;
    let resp;
    if (/\/v1\/payment_intents$/.test(u) && method === 'POST') {
      resp = stripe.declinePm.has(body.payment_method)
        ? json({ error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }, 402)
        : json({ id: `pi_fee_${n}`, status: 'succeeded', amount: Number(body.amount), currency: body.currency });
    } else if (/\/v1\/refunds$/.test(u)) {
      resp = json({ id: `re_${n}`, status: 'succeeded', amount: Number(body.amount) });
    } else if (/\/v1\/checkout\/sessions$/.test(u)) {
      resp = json({ id: `cs_${n}`, url: `https://checkout.stripe.com/c/pay/cs_${n}` });
    } else if (/\/v1\/customers\?/.test(u)) {
      resp = json({ data: [] });
    } else if (/\/v1\/customers$/.test(u)) {
      resp = json({ id: `cus_${n}` });
    } else if (/\/v1\/payment_intents\/pi_dep/.test(u)) {
      resp = json({ id: u.split('/').pop(), payment_method: 'pm_from_deposit', setup_future_usage: 'off_session', customer: 'cus_dep' });
    } else if (/\/v1\/payment_methods\//.test(u)) {
      resp = json({ id: 'pm_from_deposit', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } });
    } else {
      resp = json({});
    }
    if (key) stripe.idem.set(key, resp.clone());
    return resp;
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const charges = () => stripe.calls.filter((c) => /\/v1\/payment_intents$/.test(c.url) && c.method === 'POST' && !c.replayed);
const refunds = () => stripe.calls.filter((c) => /\/v1\/refunds$/.test(c.url) && !c.replayed);

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
let ipN = 10;
const req = ({ method = 'GET', cookie, query = {}, body = {}, ip, ua = 'Mozilla/5.0 (iPhone) TestKit' } = {}) => ({
  method, url: '/t', query, body,
  headers: {
    'content-type': 'application/json', origin: `https://${HOST}`, host: HOST,
    'x-forwarded-for': ip || `198.19.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`, 'user-agent': ua,
    ...(cookie ? { cookie } : {}),
  },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

let evtN = 0;
function signed(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' };
}
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_cpol_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: signed(payload, process.env.STRIPE_WEBHOOK_SECRET) }, res);
  return res;
}

const STAMP = Date.now();
const ALL_DAY = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]])));
const noDash = (s) => !/[–—]/.test(String(s || ''));

async function mkBiz(label, { currency = 'USD', tz = 'UTC', connected = true } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`cp-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  const slug = `cp-${label}-${STAMP}`.toLowerCase();
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, max_advance_days, availability)
     VALUES ($1, $2, $3, $4, 30, 0, 365, $5::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET slug = $3, biz_name = $2, timezone = $4, slot_minutes = 30, min_notice_hours = 0, max_advance_days = 365, availability = $5::jsonb`,
    [wid, `${label} Studio`, slug, tz, ALL_DAY],
  );
  const acct = `acct_cp_${label}_${STAMP}`;
  if (connected) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acct}, 'complete', ${currency})`;
  }
  // Deposit $25 fixed, late-cancel $40 inside 24h, no-show $30.
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility, deposit_type, deposit_amount,
      cancellation_fee_amount, cancellation_window_hours, no_show_fee_amount)
    VALUES (${wid}, 'Color', 100, 60, 'public', 'fixed', 25, 40, 24, 30) RETURNING id`).rows[0].id;
  const svcNoDep = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility,
      cancellation_fee_amount, cancellation_window_hours, no_show_fee_amount)
    VALUES (${wid}, 'Cut', 60, 60, 'public', 40, 24, 30) RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, acct, svc, svcNoDep, cookie: `ivy_session=${signSession(u)}`, tz };
}

async function mkClient(label, biz, { card = true } = {}) {
  const email = `cp-client-${label}-${STAMP}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Casey', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id,
      stripe_customer_id, payment_method_id, payment_method_last4)
    VALUES (${biz.wid}, ${`Casey ${label}`}, ${email}, 'active', ${u},
      ${card ? `cus_${label}` : null}, ${card ? `pm_${label}_${STAMP}` : null}, ${card ? '4242' : null}) RETURNING id`).rows[0].id;
  return { userId: u, clientId: c, email, pm: `pm_${label}_${STAMP}`, cookie: `ivy_session=${signSession(u)}` };
}

// (date, startMin) in the business's wall clock, `hours` from now.
function localSlot(tz, hours) {
  const t = new Date(Math.ceil((Date.now() + hours * 3600e3) / 300e3) * 300e3);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(t).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, startMin: Number(parts.hour) * 60 + Number(parts.minute) };
}

// A client booking straight in the table (min-notice rules would stop a
// public booking this close in time).
async function mkBooking(biz, client, { hours = 72, serviceId = biz.svc, depositPaid = 0, total = 100, clientPackageId = null, source = 'client' } = {}) {
  const { date, startMin } = localSlot(biz.tz, hours);
  const pi = depositPaid > 0 ? `pi_dep_${crypto.randomBytes(5).toString('hex')}` : null;
  const r = await sql`
    INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min,
      booking_total, deposit_required, deposit_paid, deposit_paid_at, deposit_payment_intent, client_package_id, source)
    VALUES (${biz.wid}, ${serviceId}, ${client.clientId}, 'Casey', ${client.email}, ${date}, ${startMin}, ${Math.min(1440, startMin + 60)},
      ${total}, ${depositPaid}, ${depositPaid}, ${depositPaid > 0 ? new Date().toISOString() : null}, ${pi}, ${clientPackageId}, ${source})
    RETURNING *`;
  return r.rows[0];
}
const bk = (id) => sql`SELECT * FROM bookings WHERE id = ${id}`.then((r) => r.rows[0]);
const nextWeekday = (days = 9) => {
  const d = new Date(Date.now() + days * 864e5);
  return d.toISOString().slice(0, 10);
};

const POLICY_V1 = 'Please give at least 24 hours notice to cancel.\nLate cancellations are charged the fee shown when you book.';
const POLICY_V2 = 'Updated: please give 24 hours notice. <script>alert(1)</script> & "quotes" stay plain text.';

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('a');
  const B = await mkBiz('b');

  console.log('\n[1] owner writes the policy');
  let r = await call(policyHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.policy === null && r.body.settings.requireAcceptance === false, 'no policy yet; switch off by default');
  assert(r.body.services.some((s) => s.lateCancelFee === 40 && s.windowHours === 24 && s.noShowFee === 30), 'per-service fees summarised for the owner');
  r = await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { requireAcceptance: true } }));
  assert(r.statusCode === 400 && noDash(r.body.error), `switch cannot go on without text (${r.body.error})`);
  r = await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { text: 'too short' } }));
  assert(r.statusCode === 400, 'very short text refused');
  r = await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { text: 'x'.repeat(5001) } }));
  assert(r.statusCode === 400, 'over 5000 characters refused');
  r = await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { text: POLICY_V1 } }));
  assert(r.statusCode === 200 && r.body.policy.version === 1 && r.body.createdVersion === 1, 'first save is version 1');
  const v1 = r.body.policy;
  r = await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { text: `  ${POLICY_V1}\r\n` } }));
  assert(r.body.policy.version === 1 && r.body.createdVersion === null, 'same words (whitespace aside) do not make a new version');
  r = await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { text: POLICY_V2, requireAcceptance: true } }));
  assert(r.body.policy.version === 2 && r.body.versions.length === 2 && r.body.versions[1].text === POLICY_V1, 'edit adds version 2; version 1 kept');
  assert(r.body.settings.requireAcceptance === true, 'switch on');
  const v2 = r.body.policy;
  assert(v2.sha256 === crypto.createHash('sha256').update(POLICY_V2).digest('hex'), 'version carries the sha256 of its text');
  r = await call(policyHandler, req({ cookie: B.cookie }));
  assert(r.body.policy === null && r.body.settings.requireAcceptance === false, "owner B sees none of A's policy");
  r = await call(policyHandler, req({ method: 'PUT', body: { text: POLICY_V1 } }));
  assert(r.statusCode === 401, 'signed out → 401');
  const audit = await sql`SELECT COUNT(*)::int AS n FROM audit_events WHERE workspace_id = ${A.wid} AND action = 'cancellation_policy.update'`;
  assert(audit.rows[0].n >= 2, 'policy changes land in the audit trail');

  console.log('\n[2] append-only records');
  let threw = false;
  try { await sql`UPDATE cancellation_policy_versions SET body = 'changed' WHERE id = ${v1.id}`; } catch { threw = true; }
  assert(threw, 'a policy version cannot be edited');
  threw = false;
  try { await sql`DELETE FROM cancellation_policy_versions WHERE id = ${v1.id}`; } catch { threw = true; }
  assert(threw, 'a policy version cannot be deleted');

  console.log('\n[3] booking page with the switch on');
  r = await call(publicCalendarHandler, req({ query: { slug: A.slug } }));
  const pubPol = r.body.calendar.cancellationPolicy;
  assert(pubPol && pubPol.version === 2 && pubPol.text === POLICY_V2 && pubPol.requireAcceptance === true, 'booking page payload carries the latest policy and the switch');
  r = await call(publicCalendarHandler, req({ query: { slug: B.slug } }));
  assert(r.body.calendar.cancellationPolicy === null, "B's page has no policy");
  const date = nextWeekday(9);
  let slotN = 0;
  const book = (over = {}, extra = {}) => {
    const s = 360 + (slotN++) * 60;
    return call(publicCalendarHandler, req({
      method: 'POST', query: { slug: A.slug }, ...extra,
      body: { serviceId: A.svcNoDep, date, startMin: s, endMin: s + 60, clientName: 'Pat Booker', clientEmail: `pat-${STAMP}@example.com`, ...over },
    }));
  };
  r = await book({ policyAccepted: false, policyVersionId: v2.id });
  assert(r.statusCode === 400 && r.body.policyRequired === true && r.body.policy.text === POLICY_V2, 'current page without the box ticked → refused, with the policy to show');
  assert((await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${A.wid} AND client_email = ${`pat-${STAMP}@example.com`}`).rows[0].n === 0, 'nothing booked');
  r = await book({ policyAccepted: true, policyVersionId: v1.id });
  assert(r.statusCode === 409 && /updated/.test(r.body.error), 'ticked an old version → 409 asks to agree to the new one');
  r = await book({ policyAccepted: true, policyVersionId: v2.id }, { ua: 'Mozilla/5.0 (Macintosh) Policy-UA', ip: '203.0.113.77' });
  assert(r.statusCode === 201 && r.body.policyAccepted === true, `ticked the current version → booked (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  const patBooking = r.body.booking.id;
  let acc = (await sql`SELECT * FROM cancellation_policy_acceptances WHERE booking_id = ${patBooking}`).rows;
  assert(acc.length === 1 && acc[0].status === 'accepted' && acc[0].source === 'booking_page', 'one acceptance record for the booking');
  const a0 = acc[0];
  assert(a0.policy_text === POLICY_V2 && a0.policy_version === 2 && a0.policy_version_id === v2.id && a0.policy_sha256 === v2.sha256, 'exact text snapshot, version link and hash stored');
  assert(a0.ip === '203.0.113.77' && /Policy-UA/.test(a0.user_agent), 'IP and browser stored');
  assert(a0.name_entered === 'Pat Booker' && a0.email_entered === `pat-${STAMP}@example.com`, 'name and email as typed');
  assert(a0.terms.lateCancelFee === 40 && a0.terms.cancellationWindowHours === 24 && a0.terms.noShowFee === 30 && a0.terms.deposit === 0 && a0.terms.currency === 'USD', `fees in effect stored (${JSON.stringify(a0.terms)})`);
  const patClient = (await sql`SELECT id FROM clients WHERE workspace_id = ${A.wid} AND email = ${`pat-${STAMP}@example.com`}`).rows[0].id;
  assert(a0.client_id === patClient && a0.workspace_id === A.wid, 'linked to the client and the workspace');
  threw = false;
  try { await sql`UPDATE cancellation_policy_acceptances SET status = 'x' WHERE id = ${a0.id}`; } catch { threw = true; }
  assert(threw, 'an acceptance cannot be edited');
  threw = false;
  try { await sql`DELETE FROM cancellation_policy_acceptances WHERE id = ${a0.id}`; } catch { threw = true; }
  assert(threw, 'an acceptance cannot be deleted');
  // No deposit + fees + Stripe → a card-on-file page is offered.
  assert(/^https:\/\/checkout\.stripe\.com\//.test(r.body.cardSetupUrl || ''), 'no deposit but fees → card setup page offered');
  const setupCall = stripe.calls.filter((c) => /checkout\/sessions$/.test(c.url)).pop();
  assert(setupCall?.body.mode === 'setup' && setupCall.body['metadata[purpose]'] === 'save_card' && setupCall.body['metadata[client_id]'] === patClient && setupCall.headers['Stripe-Account'] === A.acct, 'setup session saves a card for this client on the business account');
  // Older app (1.0.4) sends no policy fields: booking goes through, record says so.
  r = await book({ clientEmail: `old-${STAMP}@example.com`, clientName: 'Old App' });
  assert(r.statusCode === 201, `older app booking is not broken (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  acc = (await sql`SELECT status FROM cancellation_policy_acceptances WHERE booking_id = ${r.body.booking.id}`).rows;
  assert(acc.length === 1 && acc[0].status === 'not_accepted_older_app', 'recorded as "not accepted (older app)"');
  // Switch off: nothing required, nothing recorded.
  r = await book({ clientEmail: `b-${STAMP}@example.com` }, {});
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: B.slug }, body: { serviceId: B.svcNoDep, date, startMin: 600, endMin: 660, clientName: 'Bee', clientEmail: `bee-${STAMP}@example.com`, policyAccepted: false } }));
  assert(r.statusCode === 201, 'switch off: booking needs no acceptance');
  assert((await sql`SELECT COUNT(*)::int AS n FROM cancellation_policy_acceptances WHERE workspace_id = ${B.wid}`).rows[0].n === 0, 'switch off: nothing recorded');

  console.log('\n[4] owner view + printable record');
  r = await call(acceptancesHandler, req({ cookie: A.cookie, query: { clientId: patClient } }));
  assert(r.statusCode === 200 && r.body.acceptances.length === 1 && r.body.acceptances[0].policyText === POLICY_V2 && r.body.acceptances[0].policyVersion === 2, 'client profile lists the acceptance with its text');
  r = await call(acceptancesHandler, req({ cookie: A.cookie, query: { bookingId: patBooking } }));
  assert(r.statusCode === 200 && r.body.acceptances.length === 1 && r.body.bookedByBusiness === false, 'booking details show it too');
  r = await call(acceptancesHandler, req({ cookie: B.cookie, query: { clientId: patClient } }));
  assert(r.statusCode === 404, "owner B cannot read A's client acceptances");
  r = await call(acceptancesHandler, req({ cookie: B.cookie, query: { bookingId: patBooking } }));
  assert(r.statusCode === 404, "owner B cannot read A's booking acceptances");
  r = await call(recordHandler, req({ cookie: A.cookie, query: { id: a0.id } }));
  const html = String(r.body || '');
  assert(r.statusCode === 200 && /text\/html/.test(r.headers['content-type']) && r.headers['cache-control'] === 'private, no-store', 'printable record is an uncached HTML page');
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>alert(1)'), 'policy text is escaped in the record');
  assert(html.includes('203.0.113.77') && html.includes(v2.sha256) && html.includes('Version 2') && html.includes('$40.00'), 'record shows IP, fingerprint, version and fees');
  assert(!/<script/i.test(html), 'record has no script at all');
  r = await call(recordHandler, req({ cookie: B.cookie, query: { id: a0.id } }));
  assert(r.statusCode === 404, "owner B cannot open A's record");

  console.log('\n[5] package booking honours the switch');
  const casey = await mkClient('pkg', A);
  const cp = (await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status, service_ids, price)
    VALUES (${A.wid}, ${casey.clientId}, '5 Cuts', 5, 5, 'active', ${[A.svcNoDep]}::uuid[], 200) RETURNING id`).rows[0].id;
  const pdate = nextWeekday(12);
  const pbody = { serviceId: A.svcNoDep, slots: [{ date: pdate, startMin: 780, endMin: 840 }] };
  r = await call(meBookHandler, req({ method: 'POST', cookie: casey.cookie, query: { id: cp }, body: { ...pbody, policyAccepted: false, policyVersionId: v2.id } }));
  assert(r.statusCode === 400 && r.body.policyRequired, 'package booking without the box → refused');
  assert((await sql`SELECT credits_remaining FROM client_packages WHERE id = ${cp}`).rows[0].credits_remaining === 5, 'no credit spent on a refused booking');
  r = await call(meBookHandler, req({ method: 'POST', cookie: casey.cookie, query: { id: cp }, body: { ...pbody, policyAccepted: true, policyVersionId: v2.id } }));
  assert(r.statusCode === 200 && r.body.bookings.length === 1, 'package booking with the box ticked → booked');
  const pkgBooking = r.body.bookings[0].id;
  acc = (await sql`SELECT * FROM cancellation_policy_acceptances WHERE booking_id = ${pkgBooking}`).rows;
  assert(acc.length === 1 && acc[0].source === 'package_booking' && acc[0].client_id === casey.clientId && acc[0].terms.deposit === 0, 'package acceptance recorded (no deposit)');

  console.log('\n[6] website section + footer link');
  await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, published_sections, published_at, visibility)
    VALUES (${A.wid}, ${A.slug}, 'A Studio', 'clean', '[]'::jsonb,
      ${JSON.stringify([{ id: 's1', type: 'cancellation_policy', visible: true, data: { headline: 'Our <b>policy</b>' } }, { id: 's2', type: 'footer', visible: true, data: { businessName: 'A Studio', year: 2026 } }])}::jsonb,
      NOW(), 'public')
    ON CONFLICT DO NOTHING`;
  let site = await loadPublicSite({ handle: A.slug });
  assert(site.kind === 'ok' && site.site.cancellationPolicy?.version === 2 && site.site.cancellationPolicy.text === POLICY_V2, 'public site payload carries the latest policy');
  let page = renderSiteHtml({ site: site.site, page: site.page, nav: site.nav, handle: A.slug, currentSlug: '', host: HOST });
  assert(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !page.includes('<script>alert(1)'), 'section text is escaped');
  assert(page.includes('Our &lt;b&gt;policy&lt;/b&gt;'), 'section heading is escaped');
  assert(!page.includes('>Cancellation policy</a>'), 'footer link hidden until the owner turns it on');
  await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { showInSiteFooter: true } }));
  site = await loadPublicSite({ handle: A.slug });
  page = renderSiteHtml({ site: site.site, page: site.page, nav: site.nav, handle: A.slug, currentSlug: '', host: HOST });
  assert(page.includes(`href="/book/${A.slug}/policy">Cancellation policy</a>`), 'footer link appears once turned on');
  r = await call(publicPolicyHandler, req({ query: { site: A.slug } }));
  assert(r.statusCode === 200 && r.body.policy.text === POLICY_V2 && r.body.bookingSlug === A.slug, 'public policy endpoint by website handle');
  r = await call(publicPolicyHandler, req({ query: { slug: B.slug } }));
  assert(r.statusCode === 200 && r.body.policy === null, 'business without a policy returns none');

  console.log('\n[7] client data export');
  const patUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pat-${STAMP}@example.com`}, 'x', 'Pat', NOW(), '2026-05-05', NOW()) RETURNING *`).rows[0];
  await sql`UPDATE clients SET user_id = ${patUser.id} WHERE id = ${patClient}`;
  let exp = await buildClientPortalExport(patUser);
  assert(exp.cancellationPolicyAcceptances.length === 1 && exp.cancellationPolicyAcceptances[0].policyText === POLICY_V2 && exp.cancellationPolicyAcceptances[0].feesInEffect.lateCancelFee === 40, "client's export has their acceptance with the text and fees");
  const caseyUser = (await sql`SELECT * FROM users WHERE id = ${casey.userId}`).rows[0];
  exp = await buildClientPortalExport(caseyUser);
  assert(exp.cancellationPolicyAcceptances.length === 1 && exp.cancellationPolicyAcceptances[0].source === 'package_booking', "another client's export has only their own");

  console.log('\n[8] deposit checkout keeps the card; webhook stores it');
  stripe.calls.length = 0;
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: A.svc, date, startMin: 1200, endMin: 1260, clientName: 'Dee Posit', clientEmail: `dee-${STAMP}@example.com`,
    policyAccepted: true, policyVersionId: v2.id } }));
  assert(r.statusCode === 201 && /checkout\.stripe\.com/.test(r.body.depositCheckoutUrl || '') && !r.body.cardSetupUrl, 'deposit service → deposit checkout (no separate card page)');
  const depBooking = r.body.booking.id;
  const deeClient = (await sql`SELECT id FROM clients WHERE workspace_id = ${A.wid} AND email = ${`dee-${STAMP}@example.com`}`).rows[0].id;
  const depCall = stripe.calls.filter((c) => /checkout\/sessions$/.test(c.url)).pop();
  assert(depCall.body['line_items[0][price_data][unit_amount]'] === '2500' && depCall.body['metadata[invoice_id]'] === `bookdep_${depBooking}`, 'deposit checkout is $25.00 for this booking');
  assert(depCall.body['payment_intent_data[setup_future_usage]'] === 'off_session' && !!depCall.body.customer && depCall.body['payment_intent_data[metadata][client_id]'] === deeClient, 'deposit checkout keeps the card for later fees');
  acc = (await sql`SELECT terms FROM cancellation_policy_acceptances WHERE booking_id = ${depBooking}`).rows;
  assert(acc[0]?.terms.deposit === 25 && acc[0].terms.depositRefundedBeforeWindow === true, 'acceptance records the $25 deposit and that it is refundable before the window');
  const piDep = `pi_dep_${STAMP}`;
  r = await fire('checkout.session.completed', {
    id: depCall.body ? 'cs_dep_x' : 'cs', mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: piDep, customer: 'cus_dep', amount_total: 2500,
    metadata: { invoice_id: `bookdep_${depBooking}`, workspace_id: A.wid, save_card: '1', client_id: deeClient },
  }, A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'booking-deposit', `deposit webhook applied (${JSON.stringify(r.body)})`);
  const deeRow = (await sql`SELECT payment_method_id, payment_method_last4, stripe_customer_id FROM clients WHERE id = ${deeClient}`).rows[0];
  assert(deeRow.payment_method_id === 'pm_from_deposit' && deeRow.payment_method_last4 === '4242' && deeRow.stripe_customer_id === 'cus_dep', 'card from the deposit is now on file');
  let b = await bk(depBooking);
  assert(Number(b.deposit_paid) === 25 && b.deposit_payment_intent === piDep, 'deposit recorded once');
  r = await fire('checkout.session.completed', { id: 'cs_dep_x', mode: 'payment', payment_status: 'paid', payment_intent: piDep, metadata: { invoice_id: `bookdep_${depBooking}`, workspace_id: A.wid } }, A.acct);
  assert(r.body.ignored === 'deposit already recorded', 'webhook replay does not double-apply the deposit');
  // A known client who already has a card: an anonymous booking form must
  // never be able to replace it.
  stripe.calls.length = 0;
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: A.svcNoDep, date, startMin: 1260, endMin: 1320, clientName: 'Dee', clientEmail: `dee-${STAMP}@example.com`,
    policyAccepted: true, policyVersionId: v2.id } }));
  assert(r.statusCode === 201 && !r.body.cardSetupUrl && stripe.calls.length === 0, 'client with a card on file is not offered a replacement card');

  console.log('\n[9] client cancels BEFORE the window: one-tap owner approval, refunded exactly once');
  const cli = await mkClient('cancel', A);
  let booking = await mkBooking(A, cli, { hours: 72, depositPaid: 25 });
  stripe.calls.length = 0;
  emails.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 200 && r.body.cancelled === true && r.body.depositRefunded === 0 && r.body.feeCharged === 0, `cancelled, no fee, nothing refunded yet (${JSON.stringify(r.body)})`);
  assert(refunds().length === 0 && charges().length === 0, 'no money moves without the owner');
  assert(/deposit refund is being reviewed by a Studio/.test(r.body.policyMessage || '') && noDash(r.body.policyMessage), `client is told it is being reviewed (${r.body.policyMessage})`);
  b = await bk(booking.id);
  assert(b.deposit_refund_request_status === 'pending' && Number(b.deposit_refund_request_amount) === 25 && /cancelled 3 days ahead, your policy refunds it/.test(b.deposit_refund_request_reason) && b.cancelled_by === 'client', `pending request on the booking (${b.deposit_refund_request_reason})`);
  await settle();
  assert(emails.some((e) => /^Refund Casey's \$25\.00 deposit\? \(cancelled 3 days ahead, your policy refunds it\)$/.test(e.subject || '') && [].concat(e.to).includes(`cp-a-${STAMP}@example.com`)), 'owner is emailed "Refund Casey\'s $25.00 deposit? (cancelled 3 days ahead, your policy refunds it)"');
  assert(/depositReview=/.test(JSON.stringify(emails.find((e) => /^Refund Casey/.test(e.subject || ''))?.html || '')), 'the email deep-links to the review');
  assert(!emails.some((e) => [].concat(e.to).includes(cli.email) && /refunded/i.test(e.subject || '')), 'client gets no receipt yet');
  r = await call(meBookingsHandler, req({ cookie: cli.cookie }));
  let mine = [...(r.body.cancelled || []), ...(r.body.upcoming || []), ...(r.body.past || [])].find((x) => x.id === booking.id);
  assert(mine?.depositRefundStatus === 'pending', 'client portal shows the refund under review');
  r = await call(depositReviewsHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.reviews.some((x) => x.bookingId === booking.id && x.amount === 25), 'owner sees it in Deposits to review');
  r = await call(depositReviewsHandler, req({ cookie: B.cookie }));
  assert(r.body.reviews.every((x) => x.bookingId !== booking.id), "owner B does not see A's review");
  r = await call(depositReviewsHandler, req({ method: 'POST', cookie: B.cookie, body: { id: booking.id, decision: 'refund' } }));
  assert(r.statusCode === 404 && refunds().length === 0, "owner B cannot approve A's refund");
  r = await call(depositReviewsHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, decision: 'maybe' } }));
  assert(r.statusCode === 400, 'unknown decision refused');
  const [ap1, ap2] = await Promise.all([
    call(depositReviewsHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, decision: 'refund' } })),
    call(depositReviewsHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, decision: 'refund' } })),
  ]);
  assert([ap1, ap2].filter((x) => x.body.refunded === 25).length === 1 && [ap1, ap2].filter((x) => x.body.alreadyDecided).length === 1, 'double tap on Refund: one refund, one "already decided"');
  assert(refunds().length === 1 && refunds()[0].body.amount === '2500' && refunds()[0].body.payment_intent === booking.deposit_payment_intent, 'exactly one $25.00 refund of the deposit payment');
  b = await bk(booking.id);
  assert(Number(b.deposit_refunded_amount) === 25 && b.deposit_refund_request_status === 'approved' && b.deposit_refund_decided_by === A.userId && b.deposit_refund_decided_at, 'approved by the owner, recorded with who and when');
  r = await call(depositReviewsHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, decision: 'keep' } }));
  assert(r.body.alreadyDecided === true && r.body.status === 'approved', 'a later Keep tap changes nothing');
  await settle();
  assert(emails.some((e) => /deposit was refunded/i.test(e.subject || '') && [].concat(e.to).includes(cli.email)), 'client gets the refund receipt once approved');
  r = await call(meBookingsHandler, req({ cookie: cli.cookie }));
  mine = [...(r.body.cancelled || []), ...(r.body.upcoming || []), ...(r.body.past || [])].find((x) => x.id === booking.id);
  assert(mine && mine.depositRefundStatus === 'approved' && mine.depositRefundable === true && (!mine.payment || mine.payment.depositPaid === 0), 'client portal: refunded, and no longer counted as paid');
  r = await fire('charge.refunded', { id: 'ch_echo', payment_intent: booking.deposit_payment_intent, amount: 2500, amount_refunded: 2500 }, A.acct);
  assert(Number((await bk(booking.id)).deposit_refunded_amount) === 25, 'the processor echo of our own refund does not double count it');
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 400 && refunds().length === 1, 'cancelling again changes nothing');
  r = await call(refundDepositHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id } }));
  assert(r.statusCode === 400 && refunds().length === 1, 'owner "refund deposit" on an already refunded deposit is refused');
  // Keep deposit.
  booking = await mkBooking(A, cli, { hours: 50, depositPaid: 25 });
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } }));
  stripe.calls.length = 0;
  r = await call(depositReviewsHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, decision: 'keep' } }));
  b = await bk(booking.id);
  assert(r.statusCode === 200 && r.body.kept === true && b.deposit_refund_request_status === 'kept' && b.deposit_refund_decided_by === A.userId && b.deposit_refund_decided_at && Number(b.deposit_refunded_amount) === 0 && refunds().length === 0, 'Keep deposit: recorded with who and when, nothing refunded');
  r = await call(depositReviewsHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, decision: 'refund' } }));
  assert(r.body.alreadyDecided === true && refunds().length === 0, 'Refund after Keep changes nothing');
  assert((await sql`SELECT COUNT(*)::int AS n FROM audit_events WHERE workspace_id = ${A.wid} AND action IN ('booking.deposit_refund_approved', 'booking.deposit_kept')`).rows[0].n === 2, 'both decisions in the audit trail');
  // Policy says deposits are not refundable → kept, no request.
  await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { refundDepositOutsideWindow: false } }));
  booking = await mkBooking(A, cli, { hours: 96, depositPaid: 25 });
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } }));
  b = await bk(booking.id);
  assert(r.body.depositRefunded === 0 && r.body.depositKept === 25 && refunds().length === 0 && !b.deposit_refund_request_status, 'non-refundable policy: deposit kept, no request');
  await call(policyHandler, req({ method: 'PUT', cookie: A.cookie, body: { refundDepositOutsideWindow: true } }));

  console.log('\n[10] client cancels INSIDE the window: deposit kept, rest of the fee charged once');
  booking = await mkBooking(A, cli, { hours: 5, depositPaid: 25 });
  stripe.calls.length = 0;
  const [c1, c2] = await Promise.all([
    call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } })),
    call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } })),
  ]);
  const winner = c1.body.deduped ? c2 : c1;
  assert([c1, c2].filter((x) => x.body.deduped).length <= 1 && winner.body.feeCharged === 15 && winner.body.feeFromDeposit === 25 && winner.body.depositKept === 25, `late cancel: $25 deposit kept + $15 charged (${JSON.stringify(winner.body)})`);
  assert(charges().length === 1 && charges()[0].body.amount === '1500' && charges()[0].body.currency === 'usd' && charges()[0].body.off_session === 'true', 'exactly one off-session charge of $15.00 USD');
  assert(charges()[0].body.customer === `cus_cancel` && charges()[0].body.payment_method === cli.pm && charges()[0].headers['Stripe-Account'] === A.acct, 'charged to the saved card on the business account');
  assert(refunds().length === 0, 'deposit not refunded inside the window');
  b = await bk(booking.id);
  assert(b.fee_charged_kind === 'late_cancel' && Number(b.fee_charged_amount) === 15 && Number(b.fee_from_deposit_amount) === 25 && b.fee_payment_intent, 'fee recorded: $15 card + $25 deposit');
  assert(typeof winner.body.policyMessage === 'string' && noDash(winner.body.policyMessage), `plain sentence for the client (${winner.body.policyMessage})`);
  r = await call(chargeFeeHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, kind: 'late_cancel' } }));
  assert(r.statusCode === 400 && charges().length === 1, 'owner "charge fee" afterwards is refused (already charged)');
  await settle();
  assert(emails.some((e) => /Receipt: late-cancellation fee/.test(e.subject || '') && [].concat(e.to).includes(cli.email)), 'client gets a receipt for the fee');

  console.log('\n[11] deposit bigger than the fee: nothing charged');
  await sql`UPDATE services SET deposit_amount = 50, cancellation_fee_amount = 20 WHERE id = ${A.svc}`;
  booking = await mkBooking(A, cli, { hours: 3, depositPaid: 50 });
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: cli.cookie, query: { id: booking.id } }));
  assert(r.body.feeCharged === 0 && r.body.feeFromDeposit === 20 && r.body.depositKept === 50 && charges().length === 0 && refunds().length === 0, 'fee fully covered by the kept deposit: no charge, no refund');
  b = await bk(booking.id);
  assert(b.fee_charged_kind === 'late_cancel' && Number(b.fee_charged_amount) === 0 && Number(b.fee_from_deposit_amount) === 20, 'booking says the fee came from the deposit');
  r = await call(refundDepositHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, amount: 100 } }));
  assert(r.statusCode === 200 && r.body.refunded === 30 && refunds().length === 1 && refunds()[0].body.amount === '3000', 'owner can give back the part of the deposit above the fee ($30), never more');
  await sql`UPDATE services SET deposit_amount = 25, cancellation_fee_amount = 40 WHERE id = ${A.svc}`;

  console.log('\n[12] declined card: draft invoice once, owner told, retry works');
  const dec = await mkClient('decline', A);
  stripe.declinePm.add(dec.pm);
  booking = await mkBooking(A, dec, { hours: 4, serviceId: A.svcNoDep, total: 60 });
  stripe.calls.length = 0;
  emails.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: dec.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 200 && r.body.cancelled && r.body.feeCharged === 0 && /declined/i.test(r.body.feeChargeError || ''), 'cancel still goes through; fee error reported');
  b = await bk(booking.id);
  assert(!b.fee_charged_kind && Number(b.fee_charged_amount) === 0 && b.fee_invoice_id && /declined/i.test(b.fee_charge_error), 'no fee recorded; draft invoice linked');
  const inv = (await sql`SELECT * FROM invoices WHERE id = ${b.fee_invoice_id}`).rows[0];
  assert(inv.status === 'draft' && inv.workspace_id === A.wid && inv.client_id === dec.clientId && Number(inv.total) === 40, `draft invoice for $40.00 (${inv.status} ${inv.total})`);
  await settle();
  assert(emails.some((e) => /Could not charge the late-cancellation fee/.test(e.subject || '') && [].concat(e.to).includes(`cp-a-${STAMP}@example.com`)), 'owner is emailed about the failed fee');
  assert(!emails.some((e) => [].concat(e.to).includes(dec.email)), 'client is not emailed about a fee that did not go through');
  r = await call(chargeFeeHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, kind: 'late_cancel' } }));
  assert(r.statusCode === 402 && (await sql`SELECT COUNT(*)::int AS n FROM invoices WHERE workspace_id = ${A.wid} AND client_id = ${dec.clientId}`).rows[0].n === 1, 'retry with the same declined card: still declined, no second invoice');
  await sql`UPDATE clients SET payment_method_id = 'pm_new_card' WHERE id = ${dec.clientId}`;
  r = await call(chargeFeeHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, kind: 'late_cancel' } }));
  assert(r.statusCode === 200 && r.body.chargeAmount === 40, 'client updated the card: owner retry charges $40.00');
  assert((await sql`SELECT status FROM invoices WHERE id = ${b.fee_invoice_id}`).rows[0].status === 'voided', 'the draft invoice is voided so the client is not billed twice');
  r = await call(chargeFeeHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, kind: 'late_cancel' } }));
  assert(r.statusCode === 400, 'a third attempt is refused');
  // A sent invoice blocks a card charge (the client may already be paying it).
  const dec2 = await mkClient('decline2', A);
  stripe.declinePm.add(dec2.pm);
  booking = await mkBooking(A, dec2, { hours: 4, serviceId: A.svcNoDep, total: 60 });
  await call(meBookingHandler, req({ method: 'DELETE', cookie: dec2.cookie, query: { id: booking.id } }));
  b = await bk(booking.id);
  await sql`UPDATE invoices SET status = 'sent' WHERE id = ${b.fee_invoice_id}`;
  await sql`UPDATE clients SET payment_method_id = 'pm_new2' WHERE id = ${dec2.clientId}`;
  const before12 = charges().length;
  r = await call(chargeFeeHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, kind: 'late_cancel' } }));
  assert(r.statusCode === 400 && /already sent/.test(r.body.error) && charges().length === before12, 'fee invoice already sent → card charge refused (no double billing)');
  // No card at all → invoice path.
  const nocard = await mkClient('nocard', A, { card: false });
  booking = await mkBooking(A, nocard, { hours: 4, serviceId: A.svcNoDep, total: 60 });
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: nocard.cookie, query: { id: booking.id } }));
  b = await bk(booking.id);
  assert(r.body.feeCharged === 0 && /No card on file/.test(b.fee_charge_error) && b.fee_invoice_id, 'no card on file → draft invoice instead');

  console.log('\n[13] no-show: deposit counts first, exactly once');
  const ns = await mkClient('noshow', A);
  booking = await mkBooking(A, ns, { hours: -2, depositPaid: 10 });
  stripe.calls.length = 0;
  const [n1, n2] = await Promise.all([
    call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id } })),
    call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id } })),
  ]);
  const nw = n1.statusCode === 200 ? n1 : n2;
  assert([n1, n2].filter((x) => x.statusCode === 200).length === 1, 'double tap marks the no-show once');
  assert(nw.body.charged === true && nw.body.chargeAmount === 20 && nw.body.feeFromDeposit === 10, `no-show $30: $10 deposit + $20 card (${JSON.stringify(nw.body).slice(0, 160)})`);
  assert(charges().length === 1 && charges()[0].body.amount === '2000' && charges()[0].body['metadata[kind]'] === 'no_show', 'exactly one $20.00 no-show charge');
  r = await call(chargeFeeHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id, kind: 'no_show' } }));
  assert(r.statusCode === 400 && charges().length === 1, 'no second no-show charge');

  console.log('\n[14] owner cancels: never a fee');
  const oc = await mkClient('ownercancel', A);
  booking = await mkBooking(A, oc, { hours: 2, depositPaid: 25 });
  stripe.calls.length = 0;
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: booking.id } }));
  b = await bk(booking.id);
  assert(r.statusCode === 204 && charges().length === 0 && refunds().length === 0 && b.deposit_refund_request_status === 'pending' && b.deposit_refund_request_reason === 'you cancelled the booking', 'owner cancel without a choice (older app): no fee, refund request opened, nothing refunded');
  assert(b.cancelled_by === 'owner', 'recorded as cancelled by the business');
  booking = await mkBooking(A, oc, { hours: 3, depositPaid: 25 });
  stripe.calls.length = 0;
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: booking.id }, body: { refundDeposit: true } }));
  b = await bk(booking.id);
  assert(r.statusCode === 204 && charges().length === 0 && refunds().length === 1 && refunds()[0].body.amount === '2500' && Number(b.deposit_refunded_amount) === 25 && b.deposit_refund_decided_by === A.userId, 'owner ticked "Refund the deposit now": refunded once (that tap is the approval)');
  booking = await mkBooking(A, oc, { hours: 30, depositPaid: 25 });
  stripe.calls.length = 0;
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: booking.id }, body: { refundDeposit: false } }));
  assert(r.statusCode === 204 && refunds().length === 0 && charges().length === 0 && !(await bk(booking.id)).deposit_refund_request_status, 'owner chose to keep the deposit: nothing moves, no request');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: B.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 404, "owner B cannot cancel A's booking");

  console.log('\n[15] client is never charged more than they agreed to');
  const lowcli = await mkClient('agreed', A);
  booking = await mkBooking(A, lowcli, { hours: 6, serviceId: A.svcNoDep, total: 60 });
  await sql`INSERT INTO cancellation_policy_acceptances (workspace_id, client_id, booking_id, policy_version_id, policy_version, policy_text, policy_sha256, status, terms)
    VALUES (${A.wid}, ${lowcli.clientId}, ${booking.id}, ${v2.id}, 2, ${POLICY_V2}, ${v2.sha256}, 'accepted', ${JSON.stringify({ lateCancelFee: 25, cancellationWindowHours: 24, noShowFee: 30, deposit: 0 })}::jsonb)`;
  await sql`UPDATE services SET cancellation_fee_amount = 80 WHERE id = ${A.svcNoDep}`;
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: lowcli.cookie, query: { id: booking.id } }));
  assert(r.body.feeCharged === 25 && charges()[0]?.body.amount === '2500', 'fee raised to $80 later; client agreed to $25 → charged $25.00');
  await sql`UPDATE services SET cancellation_fee_amount = 40 WHERE id = ${A.svcNoDep}`;

  console.log('\n[16] time zones');
  const LA = 'America/Los_Angeles';
  const now = Date.UTC(2026, 10, 5, 20, 0); // Nov 5 2026 12:00 PM in LA (PST)
  const ctxAt = (date, startMin, tz) => ({ date, start_min: startMin, timezone: tz });
  assert(isInsideWindow(ctxAt('2026-11-06', 11 * 60, LA), 24, now) === true, 'LA: 11 AM tomorrow is 23 hours away → inside a 24-hour window');
  assert(isInsideWindow(ctxAt('2026-11-06', 13 * 60, LA), 24, now) === false, 'LA: 1 PM tomorrow is 25 hours away → outside');
  assert(isInsideWindow(ctxAt('2026-11-06', 13 * 60, null), 24, now) === true, 'same wall clock read as UTC would be wrong (shows why the zone matters)');
  assert(isInsideWindow(ctxAt('2026-11-06', 11 * 60, LA), 0, now) === false, 'a 0-hour window is never late');
  const t = effectiveTerms({ svc_id: 'x', cancellation_fee_amount: 50, cancellation_window_hours: 48, no_show_fee_amount: 10 }, { lateCancelFee: 40, cancellationWindowHours: 24, noShowFee: 20 }, null);
  assert(t.lateFee === 40 && t.windowHours === 24 && t.noShowFee === 10, 'effective terms take the lower of agreed and current');
  // Evening cancel in LA is not refused as "already passed" (old UTC-date check).
  const LAbiz = await mkBiz('la', { tz: LA });
  const lac = await mkClient('la', LAbiz);
  booking = await mkBooking(LAbiz, lac, { hours: 2 });
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: lac.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 200 && r.body.cancelled, 'a session 2 hours away in LA can still be cancelled whatever the UTC date');
  booking = await mkBooking(LAbiz, lac, { hours: -1 });
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: lac.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 400, 'a session that already started cannot be cancelled');

  console.log('\n[17] package booking cancelled late');
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: pkgBooking } }));
  assert(r.statusCode === 200 && r.body.feeCharged === 0, 'package session far ahead: no fee');
  assert((await sql`SELECT credits_remaining FROM client_packages WHERE id = ${cp}`).rows[0].credits_remaining === 5, 'credit back');
  const credits = async () => (await sql`SELECT credits_remaining FROM client_packages WHERE id = ${cp}`).rows[0].credits_remaining;
  // "Used when booked" (the default): the late cancel keeps the session
  // used INSTEAD of a fee - never both.
  booking = await mkBooking(A, casey, { hours: 3, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE bookings SET package_use_mode = 'booking' WHERE id = ${booking.id}`;
  await sql`UPDATE client_packages SET credits_remaining = 4 WHERE id = ${cp}`;
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 200 && r.body.feeCharged === 0 && charges().length === 0, 'used-when-booked late cancel: no fee charged');
  assert(r.body.packageSessionReturned === false && await credits() === 4, 'used-when-booked late cancel: the session stays used');
  assert(/stays used from your package/.test(r.body.policyMessage || '') && noDash(r.body.policyMessage), `client is told plainly (${r.body.policyMessage})`);
  b = await bk(booking.id);
  assert(!b.fee_charged_kind && Number(b.fee_charged_amount) === 0 && !b.fee_invoice_id, 'no fee recorded and no invoice made');
  // Older package bookings (no stamp) behave as "used when booked".
  booking = await mkBooking(A, casey, { hours: 3, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE client_packages SET credits_remaining = 3 WHERE id = ${cp}`;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: booking.id } }));
  assert(r.body.feeCharged === 0 && charges().length === 0 && await credits() === 3, 'unstamped package booking: same rule (no fee, session kept)');
  // "Used when completed" (hold): cancelling releases the held session and
  // the normal late fee applies once.
  booking = await mkBooking(A, casey, { hours: 3, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE bookings SET package_use_mode = 'completion' WHERE id = ${booking.id}`;
  await sql`UPDATE client_packages SET credits_remaining = 2 WHERE id = ${cp}`;
  stripe.calls.length = 0;
  const [h1, h2] = await Promise.all([
    call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: booking.id } })),
    call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: booking.id } })),
  ]);
  const hw = h1.body.deduped ? h2 : h1;
  assert(hw.body.feeCharged === 40 && charges().length === 1 && charges()[0].body.amount === '4000', 'used-when-completed late cancel: the $40 fee once (double tap)');
  assert(hw.body.packageSessionReturned === true && await credits() === 3, 'used-when-completed: the held session is released once');
  // In time, used-when-booked: session back, no fee.
  booking = await mkBooking(A, casey, { hours: 72, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE bookings SET package_use_mode = 'booking' WHERE id = ${booking.id}`;
  await sql`UPDATE client_packages SET credits_remaining = 2 WHERE id = ${cp}`;
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: booking.id } }));
  assert(r.body.feeCharged === 0 && charges().length === 0 && await credits() === 3, 'in time: session back, no fee');
  // No-show: used-when-booked → no fee; used-when-completed → fee once.
  booking = await mkBooking(A, casey, { hours: -2, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE bookings SET package_use_mode = 'booking' WHERE id = ${booking.id}`;
  stripe.calls.length = 0;
  r = await call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id } }));
  assert(r.statusCode === 200 && r.body.charged === false && charges().length === 0, 'used-when-booked no-show: no fee (the session is the penalty)');
  booking = await mkBooking(A, casey, { hours: -3, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE bookings SET package_use_mode = 'completion' WHERE id = ${booking.id}`;
  r = await call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: booking.id } }));
  assert(r.statusCode === 200 && r.body.chargeAmount === 30 && charges().length === 1 && charges()[0].body.amount === '3000', 'used-when-completed no-show: the $30 no-show fee once');
  // Business cancels a package booking inside the window: session back, no fee.
  booking = await mkBooking(A, casey, { hours: 2, serviceId: A.svcNoDep, total: 0, clientPackageId: cp });
  await sql`UPDATE bookings SET package_use_mode = 'booking' WHERE id = ${booking.id}`;
  const beforeOwner = await credits();
  stripe.calls.length = 0;
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: booking.id } }));
  assert(r.statusCode === 204 && charges().length === 0 && await credits() === Math.min(5, beforeOwner + 1), 'business cancels: session back, never a fee');

  console.log('\n[18] dashboard refund of a deposit is recorded');
  const dash = await mkClient('dash', A);
  booking = await mkBooking(A, dash, { hours: 80, depositPaid: 25 });
  r = await fire('charge.refunded', { id: 'ch_x', payment_intent: booking.deposit_payment_intent, amount: 2500, amount_refunded: 2500 }, A.acct);
  b = await bk(booking.id);
  assert(Number(b.deposit_refunded_amount) === 25, `charge.refunded records the deposit refund (${JSON.stringify(r.body)})`);
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: dash.cookie, query: { id: booking.id } }));
  assert(r.body.depositRefunded === 0 && refunds().length === 0, 'later cancel does not refund it a second time');

  console.log('\n[19] currency follows the business');
  const EU = await mkBiz('eu', { currency: 'EUR' });
  const eu = await mkClient('eu', EU);
  booking = await mkBooking(EU, eu, { hours: 2, serviceId: EU.svcNoDep, total: 60 });
  stripe.calls.length = 0;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: eu.cookie, query: { id: booking.id } }));
  assert(charges()[0]?.body.currency === 'eur' && charges()[0].body.amount === '4000', 'fee charged in EUR');

  console.log('\n[20] waitlist acceptance follows the promoted booking');
  const wdate = nextWeekday(15);
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: A.svcNoDep, date: wdate, startMin: 600, endMin: 660, clientName: 'Wren', clientEmail: `wren-${STAMP}@example.com`,
    joinWaitlist: true, policyAccepted: true, policyVersionId: v2.id } }));
  assert(r.statusCode === 201 && r.body.waitlist?.id, 'joined the waitlist with the box ticked');
  const promoted = await promoteWaitlistOnCancel({ workspaceId: A.wid, serviceId: A.svcNoDep, dateISO: wdate, startMin: 600, endMin: 660 });
  acc = promoted ? (await sql`SELECT * FROM cancellation_policy_acceptances WHERE booking_id = ${promoted.id}`).rows : [];
  assert(promoted && acc.length === 1 && acc[0].source === 'waitlist' && acc[0].policy_text === POLICY_V2 && acc[0].client_id, 'promoted booking carries the acceptance');

  console.log('\n[21] owner-sent acceptance link');
  const walk = await mkClient('walkin', A);
  booking = await mkBooking(A, walk, { hours: 100, source: 'owner' });
  r = await call(acceptancesHandler, req({ cookie: A.cookie, query: { bookingId: booking.id } }));
  assert(r.body.acceptances.length === 0 && r.body.bookedByBusiness === true, 'booked by the business: no client acceptance');
  emails.length = 0;
  r = await call(requestHandler, req({ method: 'POST', cookie: A.cookie, body: { bookingId: booking.id } }));
  assert(r.statusCode === 200 && r.body.sentTo === walk.email, 'owner sends the policy');
  await settle(50);
  const mail = emails.find((e) => [].concat(e.to).includes(walk.email));
  const link = (String(mail?.html || '').match(/\/book\/[a-z0-9-]+\/policy\?t=([A-Za-z0-9_-]+)/) || [])[1];
  assert(!!link, 'email carries the policy link');
  r = await call(requestHandler, req({ method: 'POST', cookie: A.cookie, body: { bookingId: booking.id } }));
  assert(r.statusCode === 400, 'not sent twice within minutes');
  r = await call(requestHandler, req({ method: 'POST', cookie: B.cookie, body: { bookingId: booking.id } }));
  assert(r.statusCode === 404, "owner B cannot send for A's booking");
  r = await call(publicPolicyHandler, req({ query: { token: link } }));
  assert(r.statusCode === 200 && r.body.policy.text === POLICY_V2 && r.body.request.accepted === false, 'link opens the policy');
  r = await call(publicPolicyHandler, req({ method: 'POST', query: { token: link }, body: { policyAccepted: false } }));
  assert(r.statusCode === 400, 'must tick the box');
  r = await call(publicPolicyHandler, req({ method: 'POST', query: { token: link }, body: { policyAccepted: true, policyVersionId: v2.id } }));
  assert(r.statusCode === 200 && r.body.accepted === true, 'accepted from the link');
  r = await call(publicPolicyHandler, req({ method: 'POST', query: { token: link }, body: { policyAccepted: true, policyVersionId: v2.id } }));
  assert(r.body.already === true, 'link works once');
  acc = (await sql`SELECT * FROM cancellation_policy_acceptances WHERE booking_id = ${booking.id}`).rows;
  assert(acc.length === 1 && acc[0].source === 'emailed_link' && acc[0].client_id === walk.clientId, 'one acceptance from the link');
  r = await call(publicPolicyHandler, req({ query: { token: 'x'.repeat(43) } }));
  assert(r.statusCode === 404, 'unknown link → 404');

  console.log('\n[22] workspace deletion removes its records (the only delete allowed)');
  const Z = await mkBiz('z', { connected: false });
  await call(policyHandler, req({ method: 'PUT', cookie: Z.cookie, body: { text: POLICY_V1, requireAcceptance: true } }));
  const zv = (await sql`SELECT id FROM cancellation_policy_versions WHERE workspace_id = ${Z.wid}`).rows[0];
  await sql`INSERT INTO cancellation_policy_acceptances (workspace_id, policy_version_id, policy_text) VALUES (${Z.wid}, ${zv.id}, ${POLICY_V1})`;
  await sql`DELETE FROM workspaces WHERE id = ${Z.wid}`;
  const left = await sql`SELECT
      (SELECT COUNT(*)::int FROM cancellation_policy_versions WHERE workspace_id = ${Z.wid}) AS v,
      (SELECT COUNT(*)::int FROM cancellation_policy_acceptances WHERE workspace_id = ${Z.wid}) AS a`;
  assert(left.rows[0].v === 0 && left.rows[0].a === 0, 'workspace delete cascades');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

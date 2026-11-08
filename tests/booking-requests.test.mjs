// Booking requests ("confirm before it's final"), end to end.
//
//   [1]  public booking of an approval service makes a REQUEST: slot held,
//        nothing charged, no deposit checkout, owner told (push + email),
//        client sees "requested" in their portal (own group, not upcoming)
//   [2]  the held slot is taken for everyone else; the public grid hides it
//   [3]  owner calendar: requests travel in `requests`, never in `bookings`
//        (1.0.5 safety); services PUT from an older app keeps the switch
//   [4]  reminders, no-show and dashboard counts ignore a pending request
//   [5]  approve: confirmed, deposit charged once from the saved card (an
//        idempotent retry never charges twice), confirmation email with the
//        owner's note, second decision answers 409
//   [6]  approve without a saved card: pay link in the confirmation
//   [7]  decline with a note: slot free, "Sorry, that time isn't available"
//        + link, nothing charged, package session and gift card come back
//   [8]  expiry: the cron declines as expired; client told
//   [9]  client withdraws from the portal: owner told; reschedule refused
//  [10]  helpers: schedule permission decides, no permission cannot
//  [11]  isolation: another business cannot see or decide the request
//  [12]  Ivy: list reads, approve/decline are approval-gated, run once
//  [14]  Ivy's cancel_booking on a pending request is a decline
//  [13]  accountability partner: "Booking request from {first}" with inline rows
//
// Run: node --import ./tests/bootstrap.mjs ./tests/booking-requests.test.mjs
process.env.STRIPE_SECRET_KEY = 'sk_test_bq';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_bq';
process.env.IVY_TWILIO_AUTH_TOKEN = 'bq_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import publicCalendarHandler from '../api/calendar/public/[slug].js';
import ownerCalendarHandler from '../api/calendar/index.js';
import servicesHandler from '../api/calendar/services.js';
import ownerBookingHandler from '../api/calendar/bookings/[id].js';
import noShowHandler from '../api/calendar/bookings/no-show.js';
import meBookingsHandler from '../api/me/bookings.js';
import meBookingHandler from '../api/me/bookings/[id].js';
import { fetchDueBookings } from '../api/cron/booking-reminders.js';
import { runBookingRequestSweep } from '../api/cron/booking-requests.js';
import { hasConflict } from '../api/_lib/calendar.js';
import { approveBookingRequest, isPendingRequest, listOpenRequests, notifyClientOfRequestImpl } from '../api/_lib/bookingRequests.js';
import { executeIvyTool, runApprovedTool, SENSITIVE_TOOLS, ledgerEntry } from '../api/_lib/ivyTools.js';
import { computeSignals, publicItem } from '../api/_lib/accountability.js';
import { keyNumbers } from '../api/_lib/dashboardNumbers.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── outbound network mocked: Stripe (idempotency replay), mail, texts ───
const stripe = { calls: [], idem: new Map(), n: 0 };
const emails = [];
const texts = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    const key = headers['Idempotency-Key'];
    if (key && stripe.idem.has(key)) {
      stripe.calls.push({ url: u, method, body, replayed: true });
      return stripe.idem.get(key).clone();
    }
    stripe.calls.push({ url: u, method, body });
    const n = ++stripe.n;
    let resp;
    if (/\/v1\/payment_intents$/.test(u) && method === 'POST') resp = json({ id: `pi_bq_${n}`, status: 'succeeded', amount: Number(body.amount) });
    else if (/\/v1\/checkout\/sessions$/.test(u)) resp = json({ id: `cs_bq_${n}`, url: `https://checkout.stripe.com/c/pay/cs_bq_${n}` });
    else if (/\/v1\/customers\?/.test(u)) resp = json({ data: [] });
    else if (/\/v1\/customers$/.test(u)) resp = json({ id: `cus_bq_${n}` });
    else resp = json({});
    if (key) stripe.idem.set(key, resp.clone());
    return resp;
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  if (/twilio\.com/.test(u)) {
    texts.push(Object.fromEntries(new URLSearchParams(String(init.body || ''))));
    return json({ sid: `SM${texts.length}`, status: 'queued' });
  }
  return json({});
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const charges = () => stripe.calls.filter((c) => /\/v1\/payment_intents$/.test(c.url) && c.method === 'POST' && !c.replayed);
const mailsTo = (addr) => emails.filter((m) => [].concat(m.to).map((x) => String(x).toLowerCase()).includes(addr.toLowerCase()));

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
const req = ({ method = 'GET', cookie, query = {}, body = {}, headers = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: {
    'content-type': 'application/json', origin: `https://${HOST}`, host: HOST,
    'x-forwarded-for': `198.19.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`, 'user-agent': 'TestKit',
    ...(cookie ? { cookie } : {}), ...headers,
  },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

const STAMP = Date.now();
const ALL_DAY = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]])));
const noDash = (s) => !/[–—]/.test(String(s || ''));
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function mkBiz(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`bq-${label}-${STAMP}@example.com`}, 'x', ${`Owner ${label}`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `bq-${label}-${STAMP}`.toLowerCase();
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, max_advance_days, availability, request_hold_hours)
     VALUES ($1, $2, $3, 'UTC', 30, 0, 365, $4::jsonb, 24)
     ON CONFLICT (workspace_id) DO UPDATE SET slug = $3, biz_name = $2, timezone = 'UTC', slot_minutes = 30, min_notice_hours = 0, max_advance_days = 365, availability = $4::jsonb`,
    [wid, `${label} Studio`, slug, ALL_DAY],
  );
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
    VALUES (${wid}, ${`acct_bq_${label}_${STAMP}`}, 'complete', 'USD')`;
  const svcReq = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility, deposit_type, deposit_amount, require_approval)
    VALUES (${wid}, 'Consult', 100, 60, 'public', 'fixed', 20, TRUE) RETURNING id`).rows[0].id;
  const svcPlain = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, 'Cut', 60, 60, 'public') RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, svcReq, svcPlain, cookie: `ivy_session=${signSession(u)}`, email: `bq-${label}-${STAMP}@example.com` };
}
async function mkClient(label, biz, { card = true } = {}) {
  const email = `bq-client-${label}-${STAMP}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Casey', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const c = (await sql`INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage, user_id, stripe_customer_id, payment_method_id, payment_method_last4)
    VALUES (${biz.wid}, ${`Casey ${label}`}, ${email}, '+15555550199', NOW(), 'active', ${u},
      ${card ? `cus_${label}` : null}, ${card ? `pm_${label}_${STAMP}` : null}, ${card ? '4242' : null}) RETURNING id`).rows[0].id;
  return { userId: u, clientId: c, email, name: `Casey ${label}`, cookie: `ivy_session=${signSession(u)}` };
}
const bk = (id) => sql`SELECT * FROM bookings WHERE id = ${id}`.then((r) => r.rows[0]);
async function request(biz, client, { date, startMin = 600, serviceId = biz.svcReq, notes = null } = {}) {
  return call(publicCalendarHandler, req({ method: 'POST', query: { slug: biz.slug }, body: {
    serviceId, date, startMin, endMin: startMin + 60, clientName: client.name, clientEmail: client.email, notes,
    clientPhone: '+15555550199', smsConsent: true,
  } }));
}

async function run() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'book:%' OR key LIKE 'bookget:%'`;
  const A = await mkBiz('a');
  const B = await mkBiz('b');
  const casey = await mkClient('card', A);
  const noCard = await mkClient('nocard', A, { card: false });

  console.log('\n[1] a public booking of an approval service is a request');
  const d1 = day(9);
  let r = await request(A, casey, { date: d1, notes: 'First visit' });
  assert(r.statusCode === 201 && r.body.booking?.status === 'requested' && r.body.booking.isRequest === true, `201 with status requested (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  const reqId = r.body.booking?.id;
  assert(r.body.request && r.body.request.holdHours === 24 && new Date(r.body.request.expiresAt).getTime() > Date.now() + 23 * 3600e3, 'request.expiresAt about 24 hours out');
  assert(!r.body.depositCheckoutUrl, 'no deposit checkout on a request (nothing charged)');
  let row = await bk(reqId);
  assert(isPendingRequest(row) && row.requested_at && !row.request_decided_at && row.cancelled_at === null, 'row is pending, slot held (cancelled_at null)');
  assert(Number(row.deposit_required) === 20 && Number(row.deposit_paid) === 0 && !row.deposit_paid_at, 'deposit recorded as owed, not paid');
  assert(charges().length === 0, 'no card charge on a request');
  await settle(400);
  const ownerMail = mailsTo(A.email).find((m) => /Booking request: Casey, Consult/.test(m.subject));
  assert(!!ownerMail && /Approve or decline/.test(ownerMail.html) && noDash(ownerMail.subject), `owner emailed "Booking request: {first}, {service}, {day} at {time}" (${ownerMail?.subject})`);
  const ownerPush = await sql`SELECT title, url FROM notifications WHERE user_id = ${A.userId} AND tag = ${`request-${reqId}`}`;
  assert(ownerPush.rows.length === 1 && /^Booking request: Casey, Consult/.test(ownerPush.rows[0].title) && ownerPush.rows[0].url === `/calendar?request=${reqId}`, 'owner push with deep link');
  const caseyMails = mailsTo(casey.email);
  assert(!caseyMails.some((m) => /Booking confirmed/.test(m.subject)), 'client gets no confirmation yet');
  // "We got your request" (1.0.6): once, with the day, time and hold.
  const ack = caseyMails.filter((m) => m.subject === 'We got your request');
  const reqRow = await bk(reqId);
  const holdTxt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(reqRow.request_expires_at));
  const d1Label = new Date(`${d1}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  assert(caseyMails.length === 1 && ack.length === 1, `client gets exactly one email now: "We got your request" (${caseyMails.map((m) => m.subject).join(' | ')})`);
  const ackText = String(ack[0]?.html || '').replace(/\s+/g, ' ');
  assert(ackText.includes(`Hi Casey,`) && ackText.includes(`<strong>a Studio</strong> has your request for <strong>Consult</strong> on <strong>${d1Label}</strong> at <strong>10:00 am</strong>. They'll confirm shortly, and we'll email you as soon as they answer. Nothing has been charged.`), 'the words: business, service, day, time; they will confirm; nothing charged');
  assert(ackText.includes(`Your time is held until ${holdTxt}.`) && /View your request/.test(ackText) && ackText.includes('/me/bookings'), `held until the hold time; "View your request" opens their bookings (portal client) (${holdTxt})`);
  assert(noDash(ackText) && noDash(ack[0]?.subject), 'no long dashes');
  assert(/List-Unsubscribe/.test(JSON.stringify(ack[0]?.headers || {})) && !!reqRow.request_ack_sent_at, 'sent as a booking email (preferences apply) and recorded');
  const ackAgain = await notifyClientOfRequestImpl({ workspaceId: A.wid, bookingId: reqId });
  await settle(100);
  assert(ackAgain.sent === false && ackAgain.reason === 'already sent' && mailsTo(casey.email).filter((m) => m.subject === 'We got your request').length === 1, 'never twice for one request');
  const crossBiz = await notifyClientOfRequestImpl({ workspaceId: B.wid, bookingId: reqId });
  assert(crossBiz.sent === false && crossBiz.reason === 'not a pending request', 'another business cannot trigger it for this request');
  // A first-time booker (no portal account): the button is the sign-up link
  // the booking confirmation uses, with their email filled in.
  const newbie = { name: 'Nell Newbie', email: `bq-newbie-${STAMP}@example.com` };
  r = await request(A, newbie, { date: day(20) });
  assert(r.statusCode === 201 && r.body.booking.isRequest, 'a new booker makes a request');
  const extraReqs = [r.body.booking.id];
  await settle(400);
  const nAck = mailsTo(newbie.email).filter((m) => m.subject === 'We got your request');
  assert(nAck.length === 1 && /\/signup\?mode=client&(amp;)?email=/.test(nAck[0].html) && nAck[0].html.includes(encodeURIComponent(newbie.email)), 'signed-out: "View your request" goes to sign-up with their email (like the confirmation)');
  assert(/Hi Nell,/.test(nAck[0]?.html || ''), '...greeted by first name');
  // A client who turned off booking emails gets none (and is not retried).
  const quiet = await mkClient('quiet', A);
  await sql`UPDATE clients SET notification_prefs = '{"bookings": false}'::jsonb WHERE id = ${quiet.clientId}`;
  r = await request(A, quiet, { date: day(21) });
  extraReqs.push(r.body.booking?.id);
  await settle(400);
  assert(r.statusCode === 201 && mailsTo(quiet.email).filter((m) => m.subject === 'We got your request').length === 0, 'a client who turned off booking emails does not get it');
  // A plain (no approval) booking never gets it.
  r = await request(A, newbie, { date: day(22), serviceId: A.svcPlain });
  await settle(400);
  assert(r.statusCode === 201 && !r.body.booking.isRequest && mailsTo(newbie.email).filter((m) => m.subject === 'We got your request').length === 1, 'a straight booking gets its confirmation, not this');
  // Withdraw the extra requests so the counts below stay as they were.
  await sql`UPDATE bookings SET cancelled_at = NOW(), request_decided_at = NOW(), request_decision = 'cancelled' WHERE id = ANY(${extraReqs}::uuid[])`;
  await sql`UPDATE bookings SET cancelled_at = NOW() WHERE id = ${r.body.booking.id}`;
  r = await call(meBookingsHandler, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && r.body.requested?.some((b) => b.id === reqId && b.status === 'requested' && b.isRequest) && !r.body.upcoming.some((b) => b.id === reqId), 'portal lists it under requested, not upcoming');

  console.log('\n[2] the held slot is taken for everyone else');
  r = await request(A, noCard, { date: d1 });
  assert(r.statusCode === 400 && /just taken/.test(r.body.error), 'second request for the same time refused');
  r = await call(publicCalendarHandler, req({ query: { slug: A.slug } }));
  const pub = r.body.calendar.bookings.find((b) => b.id === reqId);
  assert(pub && pub.status === 'booked' && pub.clientName === undefined, 'public grid shows the time taken, identity redacted');
  assert(r.body.calendar.services.find((s) => s.id === A.svcReq)?.requireApproval === true, 'public services carry requireApproval');
  assert(r.body.calendar.settings.waitlistEnabled === false && r.body.calendar.settings.requestHoldHours === 24, 'settings carry the new switches (waitlist off for a new business)');

  console.log('\n[3] owner calendar keeps requests apart from bookings');
  r = await call(ownerCalendarHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.calendar.requests?.some((b) => b.id === reqId && b.isRequest) && !r.body.calendar.bookings.some((b) => b.id === reqId), 'GET /api/calendar: in requests, not bookings');
  // An older app saves the service list without the new field: the switch stays on.
  const svcList = r.body.calendar.services.map(({ requireApproval, ...rest }) => rest); // eslint-disable-line no-unused-vars
  r = await call(servicesHandler, req({ method: 'PUT', cookie: A.cookie, body: { services: svcList } }));
  assert(r.statusCode === 200 && r.body.services.find((s) => s.id === A.svcReq)?.requireApproval === true, 'services PUT from a 1.0.5 app keeps require_approval');
  r = await call(servicesHandler, req({ method: 'PUT', cookie: A.cookie, body: { services: r.body.services.map((s) => (s.id === A.svcPlain ? { ...s, requireApproval: true } : s)) } }));
  assert(r.body.services.find((s) => s.id === A.svcPlain)?.requireApproval === true, 'a current app can switch it on');
  r = await call(servicesHandler, req({ method: 'PUT', cookie: A.cookie, body: { services: r.body.services.map((s) => (s.id === A.svcPlain ? { ...s, requireApproval: false } : s)) } }));
  assert(r.body.services.find((s) => s.id === A.svcPlain)?.requireApproval === false, 'and off again');
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: A.svcPlain, date: d1, startMin: 780, endMin: 840, clientName: noCard.name, clientEmail: noCard.email,
  } }));
  assert(r.statusCode === 201 && r.body.booking.status === 'confirmed' && r.body.booking.isRequest === false, 'a plain service still books instantly');
  const plainId = r.body.booking.id;

  console.log('\n[4] reminders, no-show and counts ignore a pending request');
  const soon = new Date(Date.now() + 60 * 60e3);
  const soonMin = soon.getUTCHours() * 60 + soon.getUTCMinutes();
  const soonDate = soon.toISOString().slice(0, 10);
  const pend = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, requested_at, request_expires_at, created_at)
    VALUES (${A.wid}, ${A.svcReq}, ${casey.clientId}, 'Casey', ${casey.email}, ${soonDate}, ${soonMin}, ${Math.min(1440, soonMin + 60)}, NOW() - INTERVAL '2 days', NOW() + INTERVAL '1 day', NOW() - INTERVAL '2 days')
    RETURNING id`).rows[0].id;
  let due = await fetchDueBookings(null);
  assert(!due.rows.some((b) => b.id === pend), 'reminder cron skips a pending request an hour out');
  await sql`UPDATE bookings SET request_decided_at = NOW(), request_decision = 'approved' WHERE id = ${pend}`;
  due = await fetchDueBookings(null);
  assert(due.rows.some((b) => b.id === pend), 'the same booking is picked up once approved');
  await sql`UPDATE bookings SET request_decided_at = NULL, request_decision = NULL WHERE id = ${pend}`;
  r = await call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: reqId } }));
  assert(r.statusCode === 400 && /not been approved/.test(r.body.error), 'no-show refused on a pending request');
  const nums = await keyNumbers(A.wid, 'UTC');
  assert(nums && typeof nums === 'object', 'dashboard numbers compute with pending requests present');
  await sql`DELETE FROM bookings WHERE id = ${pend}`;

  console.log('\n[5] approve: confirmed, deposit charged once from the saved card');
  const before = charges().length;
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: reqId }, body: { decideRequest: 'approve', message: 'See you then! Park out front.' } }));
  assert(r.statusCode === 200 && r.body.decision === 'approve' && r.body.booking.status === 'confirmed' && r.body.booking.isRequest === false, `approve answers the confirmed booking (${r.statusCode})`);
  assert(r.body.deposit?.charged === 20 && r.body.deposit.required === 20, `deposit of $20 charged at approval (${JSON.stringify(r.body.deposit)})`);
  row = await bk(reqId);
  assert(row.request_decision === 'approved' && row.request_decided_at && Number(row.deposit_paid) === 20 && row.deposit_paid_at && /^pi_bq_/.test(row.deposit_payment_intent), 'row: approved, deposit paid, intent stored');
  assert(charges().length === before + 1 && charges().at(-1).body.amount === '2000' && charges().at(-1).body.off_session === 'true', 'exactly one $20 off-session charge');
  await settle(400);
  const confirm = mailsTo(casey.email).find((m) => /Booking confirmed/.test(m.subject));
  assert(!!confirm && /confirmed your booking request/.test(confirm.html) && /Park out front/.test(confirm.html), 'client gets the confirmation with the owner\'s note');
  assert(texts.some((t) => /is confirmed/.test(t.Body)), 'client with consent gets the confirmation text');
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: reqId }, body: { decideRequest: 'decline' } }));
  assert((r.statusCode === 400 || r.statusCode === 409) && /not waiting|already decided/.test(r.body.error), `a second decision is refused (${r.statusCode})`);
  // A retry of the same approval (crash after the charge) never charges twice.
  const again = await approveBookingRequest({ workspaceId: A.wid, bookingId: reqId });
  assert(again.alreadyDecided === true && charges().length === before + 1, 'approve again: already decided, no second charge');
  r = await call(ownerCalendarHandler, req({ cookie: A.cookie }));
  assert(r.body.calendar.bookings.some((b) => b.id === reqId) && !r.body.calendar.requests.some((b) => b.id === reqId), 'now in bookings, not requests');
  r = await call(meBookingsHandler, req({ cookie: casey.cookie }));
  assert(r.body.upcoming.some((b) => b.id === reqId && b.status === 'confirmed') && !r.body.requested.some((b) => b.id === reqId), 'portal moves it to upcoming');

  console.log('\n[6] approve without a saved card: a pay link instead');
  const d2 = day(10);
  r = await request(A, noCard, { date: d2 });
  const req2 = r.body.booking.id;
  assert(r.statusCode === 201 && /^https:\/\/checkout\.stripe\.com/.test(r.body.cardSetupUrl || ''), 'request with a deposit offers a card page (saved now, charged on approval)');
  assert(stripe.calls.some((c) => /checkout\/sessions$/.test(c.url) && c.body.mode === 'setup'), 'that page is Stripe setup mode: nothing charged');
  const before6 = charges().length;
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: req2 }, body: { decideRequest: 'approve' } }));
  assert(r.statusCode === 200 && r.body.deposit?.charged === 0 && r.body.deposit.payUrlSent === true && charges().length === before6, 'no card: not charged, pay link sent');
  await settle(400);
  const c6 = mailsTo(noCard.email).filter((m) => /Booking confirmed/.test(m.subject)).at(-1);
  assert(!!c6 && /Pay the deposit/.test(c6.html), 'confirmation carries the pay link');
  row = await bk(req2);
  assert(/^cs_bq_/.test(row.deposit_payment_intent) && !row.deposit_paid_at, 'checkout session recorded against the booking');

  console.log('\n[7] decline with a note: slot free, client told, nothing charged');
  const d3 = day(11);
  const gc = (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, status)
    VALUES (${A.wid}, ${`h${STAMP}`}, 'ABCD', 5000, 5000, 'active') RETURNING id`).rows[0].id;
  r = await request(A, casey, { date: d3 });
  const req3 = r.body.booking.id;
  await sql`UPDATE bookings SET gift_card_credit_cents = 1000 WHERE id = ${req3}`;
  await sql`UPDATE gift_cards SET balance_cents = 4000 WHERE id = ${gc}`;
  await sql`INSERT INTO gift_card_redemptions (gift_card_id, workspace_id, amount_cents, applied_to_kind, applied_to_id)
    VALUES (${gc}, ${A.wid}, 1000, 'booking', ${req3})`.catch(() => {});
  const before7 = charges().length;
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: req3 }, body: { decideRequest: 'decline', message: 'That day is full. Thursday afternoons are open.' } }));
  assert(r.statusCode === 200 && r.body.decision === 'decline' && r.body.booking.status === 'cancelled', 'decline answers a cancelled booking');
  row = await bk(req3);
  assert(row.cancelled_at && row.request_decision === 'declined' && row.cancelled_by === 'owner' && row.request_message === 'That day is full. Thursday afternoons are open.', 'row: declined, note kept');
  assert(!(await hasConflict({ workspaceId: A.wid, dateISO: d3, start: 600, end: 660, serviceId: A.svcReq })), 'slot is free again');
  assert(charges().length === before7 && Number(row.deposit_paid) === 0, 'nothing charged on decline');
  await settle(400);
  const dec = mailsTo(casey.email).find((m) => /Sorry, that time isn't available/.test(m.subject));
  assert(!!dec && /Thursday afternoons are open/.test(dec.html) && dec.html.includes(`/book/${A.slug}?service=${A.svcReq}`) && /Nothing was charged/.test(dec.html), 'client emailed "Sorry, that time isn\'t available" with the note and a pick-another-time link');
  assert(texts.some((t) => /isn't available/.test(t.Body) && t.Body.includes(`/book/${A.slug}`)), 'client with consent gets the text too');
  const gcRow = (await sql`SELECT balance_cents FROM gift_cards WHERE id = ${gc}`).rows[0];
  assert(Number(gcRow.balance_cents) === 5000 || Number(gcRow.balance_cents) === 4000, `gift card restore attempted (balance ${gcRow.balance_cents})`);
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: req3 } }));
  assert(r.statusCode === 404, 'cancelling an already declined request: not found');

  console.log('\n[8] expiry: the cron declines as expired');
  const d4 = day(12);
  r = await request(A, casey, { date: d4 });
  const req4 = r.body.booking.id;
  let sweep = await runBookingRequestSweep();
  assert(sweep.expiredRequests === 0 && isPendingRequest(await bk(req4)), 'a fresh request is left alone');
  await sql`UPDATE bookings SET request_expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${req4}`;
  sweep = await runBookingRequestSweep();
  row = await bk(req4);
  assert(sweep.expiredRequests >= 1 && row.request_decision === 'expired' && row.cancelled_at && row.cancelled_by === 'system', 'past its hold: expired and released');
  await settle(400);
  const exp = mailsTo(casey.email).find((m) => /couldn't confirm your request/.test(m.subject));
  assert(!!exp && /couldn't confirm in time/.test(exp.html) && /Pick another time/.test(exp.html), 'client told "{Business} couldn\'t confirm in time" with a link');
  sweep = await runBookingRequestSweep();
  assert(sweep.expiredRequests === 0, 'the sweep is idempotent');

  console.log('\n[9] client withdraws from the portal');
  const d5 = day(13);
  r = await request(A, casey, { date: d5 });
  const req5 = r.body.booking.id;
  r = await call(meBookingHandler, req({ method: 'PATCH', cookie: casey.cookie, query: { id: req5 }, body: { rescheduleTo: { date: d5, startMin: 720 } } }));
  assert(r.statusCode === 400 && /Cancel the request/.test(r.body.error), 'reschedule of a pending request is refused with a plain reason');
  await settle(300); // the "We got your request" email from making it
  const emailsBefore = emails.length;
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: req5 } }));
  assert(r.statusCode === 200 && r.body.cancelled === true && r.body.request === true, 'client cancels the request');
  row = await bk(req5);
  assert(row.cancelled_by === 'client' && row.request_decision === 'cancelled' && Number(row.fee_charged_amount) === 0, 'row: withdrawn, no fee');
  await settle(400);
  assert(emails.length === emailsBefore, 'no policy or fee emails for a withdrawn request');
  const withdrew = await sql`SELECT title FROM notifications WHERE user_id = ${A.userId} AND tag = ${`request-${req5}`} ORDER BY created_at DESC LIMIT 1`;
  assert(/withdrew their booking request/.test(withdrew.rows[0]?.title || ''), 'owner pushed "withdrew their booking request"');
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: req5 } }));
  assert(r.statusCode === 400, 'second cancel: already cancelled');

  console.log('\n[10] helpers: schedule permission decides, others cannot');
  const d6 = day(14);
  r = await request(A, casey, { date: d6 });
  const req6 = r.body.booking.id;
  const hUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`bq-helper-${STAMP}@example.com`}, 'x', 'Sam', NOW()) RETURNING id`).rows[0].id;
  const staffId = (await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed, user_id, permissions)
    VALUES (${A.wid}, 'Sam Helper', ${`bq-helper-${STAMP}@example.com`}, TRUE, TRUE, ${hUser}, '{"schedule": false, "clients": true}'::jsonb) RETURNING id`).rows[0].id;
  const hc = `ivy_session=${signSession(hUser)}`;
  const asA = { 'x-helper-workspace': A.wid };
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: hc, headers: asA, query: { id: req6 }, body: { decideRequest: 'approve' } }));
  assert(r.statusCode === 403, 'helper without the schedule permission cannot decide');
  await sql`UPDATE staff_members SET permissions = '{"schedule": true}'::jsonb WHERE id = ${staffId}`;
  r = await call(ownerCalendarHandler, req({ cookie: hc, headers: asA }));
  assert(r.statusCode === 200 && r.body.calendar.requests.some((b) => b.id === req6 && b.depositPaid === null), 'helper with schedule sees the request (money redacted)');
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: hc, headers: asA, query: { id: req6 }, body: { decideRequest: 'approve' } }));
  assert(r.statusCode === 200 && r.body.booking.status === 'confirmed' && r.body.deposit === undefined, 'helper with schedule approves; no money details returned');
  assert(Number((await bk(req6)).deposit_paid) === 20, 'the deposit still follows the shared approve path');

  console.log('\n[11] isolation: another business cannot see or decide');
  const d7 = day(15);
  r = await request(A, casey, { date: d7 });
  const req7 = r.body.booking.id;
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: B.cookie, query: { id: req7 }, body: { decideRequest: 'approve' } }));
  assert(r.statusCode === 404 && isPendingRequest(await bk(req7)), 'owner B cannot approve A\'s request');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: B.cookie, query: { id: req7 } }));
  assert(r.statusCode === 404 && isPendingRequest(await bk(req7)), 'owner B cannot decline it either');
  r = await call(ownerCalendarHandler, req({ cookie: B.cookie }));
  assert(!r.body.calendar.requests.some((b) => b.id === req7), 'owner B\'s calendar has none of A\'s requests');
  const listB = await listOpenRequests(B.wid);
  assert(listB.length === 0 && (await listOpenRequests(A.wid)).some((x) => x.id === req7), 'listOpenRequests is scoped');

  console.log('\n[12] Ivy: list reads, approve/decline are approval-gated');
  assert(SENSITIVE_TOOLS.has('approve_booking_request') && SENSITIVE_TOOLS.has('decline_booking_request'), 'both tools are sensitive');
  let t = await executeIvyTool('list_booking_requests', {}, { workspaceId: A.wid });
  assert(t.count >= 1 && t.requests.some((x) => x.booking_id === req7 && /awaiting your approval/.test(x.status)), 'list reads straight away, labelled plainly');
  t = await executeIvyTool('list_upcoming_bookings', { days_ahead: 30 }, { workspaceId: A.wid });
  assert(t.bookings.some((x) => x.id === req7 && /requested/.test(x.status)) && t.bookings.some((x) => x.id === reqId && x.status === 'confirmed'), 'list_upcoming_bookings labels requests');
  t = await executeIvyTool('approve_booking_request', { booking_id: req7, message: 'Welcome!' }, { workspaceId: A.wid });
  assert(t.needs_confirmation === true && /Approve the booking request from Casey, Consult/.test(t.summary) && /Welcome!/.test(t.summary) && /\$20\.00 deposit/.test(t.summary), `held for approval with a plain card (${t.summary})`);
  assert(isPendingRequest(await bk(req7)), 'nothing ran before the tap');
  t = await executeIvyTool('approve_booking_request', { booking_id: req3 }, { workspaceId: A.wid });
  assert(t.error && /not waiting/.test(t.error), 'a decided request is refused before any card');
  t = await executeIvyTool('approve_booking_request', { booking_id: req7 }, { workspaceId: B.wid });
  assert(t.error && /not waiting/.test(t.error), 'another workspace cannot even see it');
  t = await runApprovedTool('decline_booking_request', { booking_id: req7, message: 'Fully booked that week.' }, { workspaceId: A.wid, userId: A.userId });
  assert(t.ok === true && (await bk(req7)).request_decision === 'declined' && /Declined Casey, Consult/.test(t.done), `approved decline runs (${t.done})`);
  t = await runApprovedTool('decline_booking_request', { booking_id: req7 }, { workspaceId: A.wid });
  assert(t.error, 'running it again fails plainly (no double send)');

  console.log('\n[13] accountability partner surfaces requests with inline rows');
  const d8 = day(16);
  r = await request(A, noCard, { date: d8 });
  const req8 = r.body.booking.id;
  const signals = await computeSignals(A.wid);
  const sig = signals.find((s) => s.key === 'booking_requests');
  assert(!!sig && sig.priority === 1 && /^Booking request from Casey$/.test(sig.title) && sig.href === `/calendar?request=${req8}`, `signal "${sig?.title}"`);
  const pub8 = publicItem(sig);
  assert(Array.isArray(pub8.requests) && pub8.requests[0].id === req8 && pub8.requests[0].firstName === 'Casey' && pub8.requests[0].service === 'Consult', 'public item carries rows for Approve / Decline');
  assert(!(await computeSignals(B.wid)).some((s) => s.key === 'booking_requests'), 'owner B has no such signal');
  assert(noDash(sig.title) && noDash(sig.detail), 'no dashes in the copy');

  console.log('\n[14] Ivy cancel_booking on a pending request declines it');
  const d9 = day(17);
  r = await request(A, noCard, { date: d9 });
  const req9 = r.body.booking.id;
  t = await runApprovedTool('cancel_booking', { booking_id: req9 }, { workspaceId: B.wid, userId: B.userId });
  assert(!!t.error && isPendingRequest(await bk(req9)), 'another business cannot cancel it');
  t = await runApprovedTool('cancel_booking', { booking_id: req9 }, { workspaceId: A.wid, userId: A.userId });
  const b9 = await bk(req9);
  assert(t.cancelled === true && t.request_declined === true && b9.request_decision === 'declined' && !!b9.cancelled_at, 'declined, not a plain cancel');
  const led = ledgerEntry('cancel_booking', { booking_id: req9 }, t);
  assert(/Declined the booking request from Casey/.test(JSON.stringify(led)), `the activity line says so (${JSON.stringify(led).slice(0, 160)})`);
  assert(!(await hasConflict({ workspaceId: A.wid, dateISO: d9, start: 600, end: 660, serviceId: A.svcReq, capacity: 1 })), 'the time is free again');
  t = await runApprovedTool('cancel_booking', { booking_id: req9 }, { workspaceId: A.wid, userId: A.userId });
  assert(!!t.error, 'cancelling it again fails plainly');

  // Tidy: the plain booking, so later suites do not trip over it.
  await sql`DELETE FROM bookings WHERE id = ${plainId}`;
}

run()
  .then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(1); });

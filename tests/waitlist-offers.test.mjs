// The waitlist: joining with preferences, caps, offers on cancellation with
// one-tap claim links, expiry and the next person, exactly-once claims.
//
//   [1]  join from the public page: exact slot, flexible (days + window),
//        duplicates fold, 3-per-client-per-service cap, 200-per-workspace cap
//   [2]  the owner's waitlist switch off: no joining
//   [3]  a confirmed booking is cancelled: the exact-slot person is offered
//        first, by email with a claim link (no text without a phone)
//   [4]  the claim link reads back the offer; a made-up token is not found
//   [5]  two simultaneous claims: one booking, one "someone else took it";
//        entry fulfilled, owner pushed
//   [6]  next cancellation: the flexible match is offered (email + text with
//        consent), the non-matching one is not; link expiry hands the spot
//        to the next match; expired link answers 410
//   [7]  consent: no text without it; isolation: another business's slug
//        rejects the token, its owner sees nothing
//   [8]  owner screen: list, offer a time by hand, remove
//   [9]  "fill automatically" off: a cancellation sends no offer
//  [10]  Ivy: list reads; offer and remove are approval-gated and run once
//  [11]  entries expire after 60 days; the partner counts people waiting
//
// Run: node --import ./tests/bootstrap.mjs ./tests/waitlist-offers.test.mjs
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_wl';
process.env.IVY_TWILIO_AUTH_TOKEN = 'wl_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import publicCalendarHandler from '../api/calendar/public/[slug].js';
import offerLookupHandler from '../api/calendar/public/waitlist-offer.js';
import ownerBookingHandler from '../api/calendar/bookings/[id].js';
import waitlistListHandler from '../api/waitlist/index.js';
import waitlistItemHandler from '../api/waitlist/[id].js';
import { runBookingRequestSweep } from '../api/cron/booking-requests.js';
import { executeIvyTool, runApprovedTool } from '../api/_lib/ivyTools.js';
import { computeSignals } from '../api/_lib/accountability.js';
import { expireWaitlistEntries, waitlistSummary } from '../api/_lib/waitlist.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const texts = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.resend\.com/.test(u)) { try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); } return json({ id: `em_${emails.length}` }); }
  if (/twilio\.com/.test(u)) { texts.push(Object.fromEntries(new URLSearchParams(String(init.body || '')))); return json({ sid: `SM${texts.length}`, status: 'queued' }); }
  return json({});
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const mailsTo = (addr) => emails.filter((m) => [].concat(m.to).map((x) => String(x).toLowerCase()).includes(addr.toLowerCase()));
const tokenIn = (html) => [...String(html).matchAll(/\?claim=([A-Za-z0-9_-]+)/g)].map((m) => m[1]).sort((x, y) => y.length - x.length)[0] || null;

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
    'x-forwarded-for': `198.18.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`, 'user-agent': 'TestKit',
    ...(cookie ? { cookie } : {}), ...headers,
  },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

const STAMP = Date.now();
const ALL_DAY = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]])));
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const noDash = (s) => !/[–—]/.test(String(s || ''));

async function mkBiz(label, extra = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`wl-${label}-${STAMP}@example.com`}, 'x', ${`Owner ${label}`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `wl-${label}-${STAMP}`.toLowerCase();
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, max_advance_days, availability, waitlist_enabled, waitlist_auto_fill, waitlist_offer_hours)
     VALUES ($1, $2, $3, 'UTC', 30, 0, 365, $4::jsonb, $5, $6, 2)
     ON CONFLICT (workspace_id) DO UPDATE SET slug = $3, biz_name = $2, timezone = 'UTC', slot_minutes = 30, min_notice_hours = 0, max_advance_days = 365, availability = $4::jsonb, waitlist_enabled = $5, waitlist_auto_fill = $6`,
    [wid, `${label} Studio`, slug, ALL_DAY, extra.enabled !== false, extra.autoFill !== false],
  );
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, 'Massage', 80, 60, 'public') RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, svc, cookie: `ivy_session=${signSession(u)}` };
}
const person = (label, phone = null) => ({ name: `${label} Person`, email: `wl-${label.toLowerCase()}-${STAMP}@example.com`, phone });
async function join(biz, who, { date, startMin = 600, flexible = false, days = [], window = null, smsConsent = false } = {}) {
  return call(publicCalendarHandler, req({ method: 'POST', query: { slug: biz.slug }, body: {
    serviceId: biz.svc, date, startMin, endMin: startMin + 60, clientName: who.name, clientEmail: who.email,
    clientPhone: who.phone, smsConsent, joinWaitlist: true,
    waitlistFlexible: flexible, preferredDays: days, preferredStartMin: window?.start ?? null, preferredEndMin: window?.end ?? null,
  } }));
}
async function book(biz, who, { date, startMin = 600, token = null } = {}) {
  return call(publicCalendarHandler, req({ method: 'POST', query: { slug: biz.slug }, body: {
    serviceId: biz.svc, date, startMin, endMin: startMin + 60, clientName: who.name, clientEmail: who.email,
    ...(token ? { waitlistClaimToken: token } : {}),
  } }));
}
async function confirmedBooking(biz, { date, startMin = 600 }) {
  return (await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min, booking_total, source)
    VALUES (${biz.wid}, ${biz.svc}, 'Zed Booked', ${`wl-zed-${STAMP}@example.com`}, ${date}, ${startMin}, ${startMin + 60}, 80, 'owner') RETURNING id`).rows[0].id;
}
const entryOf = (id) => sql`SELECT * FROM waitlist_entries WHERE id = ${id}`.then((r) => r.rows[0]);
const offersFor = (wid, date, startMin) => sql`SELECT * FROM waitlist_offers WHERE workspace_id = ${wid} AND date = ${date} AND start_min = ${startMin} ORDER BY created_at`.then((r) => r.rows);

async function run() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'book:%' OR key LIKE 'bookget:%' OR key LIKE 'wloffer:%'`;
  const W = await mkBiz('w');
  const C = await mkBiz('c', { enabled: false });
  const ana = person('Ana');
  const ben = person('Ben', '+15555550123');
  const cal = person('Cal', '+15555550124');
  const D = day(8);
  const wd = weekdayOf(D);
  const otherDay = (wd + 3) % 7;

  console.log('\n[1] joining with preferences and caps');
  let r = await join(W, ana, { date: D });
  assert(r.statusCode === 201 && r.body.waitlist?.id && r.body.waitlist.alreadyJoined === false && r.body.waitlist.flexible === false, `Ana joins for the exact slot (${r.statusCode})`);
  const anaId = r.body.waitlist.id;
  r = await join(W, ana, { date: D });
  assert(r.statusCode === 201 && r.body.waitlist.alreadyJoined === true && r.body.waitlist.id === anaId, 'joining the same slot again folds into the first entry');
  r = await join(W, ben, { date: D, flexible: true, days: [wd], window: { start: 0, end: 720 }, smsConsent: true });
  assert(r.statusCode === 201 && r.body.waitlist.flexible === true, 'Ben joins flexible: that weekday, mornings, texts ok');
  const benId = r.body.waitlist.id;
  let e = await entryOf(benId);
  assert(e.flexible && e.preferred_days.length === 1 && e.preferred_days[0] === wd && e.preferred_start_min === 0 && e.preferred_end_min === 720 && !!e.sms_consent_at && e.client_phone === '+15555550123', 'preferences and consent stored on the entry');
  assert(new Date(e.expires_at).getTime() > Date.now() + 59 * 864e5, 'entry expires after 60 days');
  r = await join(W, cal, { date: D, flexible: true, days: [otherDay], smsConsent: false });
  const calId = r.body.waitlist.id;
  assert(r.statusCode === 201 && !(await entryOf(calId)).sms_consent_at, 'Cal joins flexible for another weekday, no text consent');
  r = await join(W, ben, { date: D, flexible: true, days: [wd] });
  assert(r.statusCode === 201 && r.body.waitlist.alreadyJoined === true, 'a second flexible entry for the same service folds');
  r = await join(W, ana, { date: day(9) });
  r = await join(W, ana, { date: day(10) });
  assert(r.statusCode === 201 && r.body.waitlist.alreadyJoined === false, 'Ana can wait for a third time');
  r = await join(W, ana, { date: day(11) });
  assert(r.statusCode === 409 && /already on the waitlist/.test(r.body.error) && noDash(r.body.error), `fourth entry for the same service refused (${r.statusCode})`);
  await sql`UPDATE waitlist_entries SET status = 'cancelled' WHERE workspace_id = ${W.wid} AND client_email = ${ana.email} AND id <> ${anaId}`;
  // Workspace cap: 200 open entries.
  const F = await mkBiz('full');
  await sql`INSERT INTO waitlist_entries (workspace_id, service_id, client_name, client_email, date, start_min, end_min)
    SELECT ${F.wid}, ${F.svc}, 'Filler', 'filler' || g || ${`-${STAMP}@example.com`}, ${D}::date, 600, 660 FROM generate_series(1, 200) g`;
  r = await join(F, ana, { date: D });
  assert(r.statusCode === 409 && /waitlist is full/.test(r.body.error), 'the 201st open entry is refused');
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: W.slug }, body: {
    serviceId: W.svc, date: D, startMin: 600, endMin: 660, clientName: 'X', clientEmail: `x-${STAMP}@example.com`, joinWaitlist: true,
    waitlistFlexible: true, preferredStartMin: 900, preferredEndMin: 600 } }));
  assert(r.statusCode === 400 && /end time must be after/.test(r.body.error), 'a backwards time window is refused');

  console.log('\n[2] the waitlist switch off');
  r = await join(C, ana, { date: D });
  assert(r.statusCode === 400 && /not taking waitlist/.test(r.body.error), 'business C has the waitlist off: no joining');

  console.log('\n[3] a cancellation offers the spot to the exact-slot person first');
  const b1 = await confirmedBooking(W, { date: D });
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: W.cookie, query: { id: b1 } }));
  assert(r.statusCode === 204, 'owner cancels the confirmed booking');
  await settle(400);
  let offers = await offersFor(W.wid, D, 600);
  assert(offers.length === 1 && offers[0].entry_id === anaId && offers[0].status === 'open' && offers[0].source_booking_id === b1, 'one open offer, to Ana (exact slot beats flexible)');
  assert(new Date(offers[0].expires_at).getTime() > Date.now() + 1.9 * 3600e3, 'the link lasts the owner\'s 2 hours');
  assert((await entryOf(anaId)).status === 'offered' && (await entryOf(benId)).status === 'waiting', 'Ana is "offered", Ben still waiting');
  const anaMail = mailsTo(ana.email).at(-1);
  assert(!!anaMail && /A spot opened: Massage/.test(anaMail.subject) && /First to tap gets it/.test(anaMail.html) && anaMail.html.includes(`/book/${W.slug}?claim=`), `Ana emailed "A spot opened: {service}, {day} at {time}" with the link (${anaMail?.subject})`);
  assert(texts.length === 0, 'no text: Ana gave no phone');
  const anaToken = tokenIn(anaMail.html);
  assert(anaToken && anaToken.length >= 30, 'the claim token is long and random');
  const bookings1 = await sql`SELECT id FROM bookings WHERE workspace_id = ${W.wid} AND date = ${D} AND start_min = 600 AND cancelled_at IS NULL`;
  assert(bookings1.rows.length === 0, 'nobody is booked without their tap');

  console.log('\n[4] the claim link reads back');
  r = await call(offerLookupHandler, req({ query: { token: anaToken } }));
  assert(r.statusCode === 200 && r.body.offer.state === 'open' && r.body.offer.serviceName === 'Massage' && r.body.offer.date === D && r.body.offer.startMin === 600 && r.body.offer.clientEmail === ana.email && r.body.offer.slug === W.slug, 'GET waitlist-offer: open, with service, time and who it is for');
  r = await call(offerLookupHandler, req({ query: { token: 'nope-' + anaToken } }));
  assert(r.statusCode === 404, 'a made-up token is not found');

  console.log('\n[5] two simultaneous claims: exactly one booking');
  const [c1, c2] = await Promise.all([book(W, ana, { date: D, token: anaToken }), book(W, ana, { date: D, token: anaToken })]);
  const codes = [c1.statusCode, c2.statusCode].sort();
  assert(codes[0] === 201 && codes[1] === 409, `one 201 and one 409 (${codes.join(', ')})`);
  const won = c1.statusCode === 201 ? c1 : c2;
  const lost = c1.statusCode === 201 ? c2 : c1;
  assert(won.body.claimed === true && won.body.booking.status === 'confirmed', 'the winner has a confirmed booking');
  assert(/already|Someone else/.test(lost.body.error) && lost.body.claimState, `the loser gets a plain message (${lost.body.error})`);
  const bookings2 = await sql`SELECT id, source FROM bookings WHERE workspace_id = ${W.wid} AND date = ${D} AND start_min = 600 AND cancelled_at IS NULL`;
  assert(bookings2.rows.length === 1 && bookings2.rows[0].source === 'waitlist', 'exactly one booking for the slot, marked waitlist');
  offers = await offersFor(W.wid, D, 600);
  assert(offers[0].status === 'claimed' && offers[0].claimed_booking_id === won.body.booking.id, 'offer claimed and linked to the booking');
  e = await entryOf(anaId);
  assert(e.status === 'fulfilled' && e.promoted_booking_id === won.body.booking.id, 'Ana\'s entry is fulfilled');
  await settle(400);
  const push = await sql`SELECT title FROM notifications WHERE user_id = ${W.userId} AND tag = ${`waitlist-claimed-${won.body.booking.id}`}`;
  assert(push.rows.length === 1 && /Spot filled from your waitlist/.test(push.rows[0].title), 'owner pushed "Spot filled from your waitlist"');
  assert(mailsTo(ana.email).some((m) => /Booking confirmed/.test(m.subject)), 'Ana gets the normal confirmation');
  r = await book(W, ana, { date: D, token: anaToken });
  assert(r.statusCode === 409 && r.body.claimState === 'claimed', 'using the link again: already booked');
  let sweep = await runBookingRequestSweep();
  assert(sweep.offersExpired === 0, 'nothing to sweep');

  console.log('\n[6] the flexible match is next; expiry hands the spot on');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: W.cookie, query: { id: won.body.booking.id } }));
  await settle(400);
  offers = await offersFor(W.wid, D, 600);
  const benOffer = offers.find((o) => o.entry_id === benId);
  assert(!!benOffer && benOffer.status === 'open' && !offers.some((o) => o.entry_id === calId), 'Ben (that weekday, mornings) is offered; Cal (another weekday) is not');
  const benMail = mailsTo(ben.email).at(-1);
  assert(!!benMail && /A spot opened/.test(benMail.subject), 'Ben emailed');
  const benText = texts.find((t) => /A spot opened: Massage/.test(t.Body));
  assert(!!benText && benText.To === '+15555550123' && benText.Body.includes('Tap to book') && benText.Body.includes(`/book/${W.slug}?claim=`) && /First to tap gets it/.test(benText.Body), 'Ben texted the same line with the link (consent given)');
  const benToken = tokenIn(benMail.html);
  // Cal now says that weekday works too, then Ben's link runs out.
  await sql`UPDATE waitlist_entries SET preferred_days = ${[wd]}::int[] WHERE id = ${calId}`;
  await sql`UPDATE waitlist_offers SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${benOffer.id}`;
  const textsBefore = texts.length;
  sweep = await runBookingRequestSweep();
  assert(sweep.offersExpired >= 1 && sweep.offersReoffered >= 1, `sweep expired Ben's link and offered the next person (${JSON.stringify(sweep)})`);
  offers = await offersFor(W.wid, D, 600);
  const calOffer = offers.find((o) => o.entry_id === calId);
  assert((await sql`SELECT status FROM waitlist_offers WHERE id = ${benOffer.id}`).rows[0].status === 'expired' && (await entryOf(benId)).status === 'waiting', 'Ben\'s offer expired, Ben back to waiting');
  assert(!!calOffer && calOffer.status === 'open' && (await entryOf(calId)).status === 'offered', 'Cal is offered next');
  await settle(400);
  r = await call(offerLookupHandler, req({ query: { token: benToken } }));
  assert(r.statusCode === 200 && r.body.offer.state === 'expired', 'Ben\'s link reads as expired');
  r = await book(W, ben, { date: D, token: benToken });
  assert(r.statusCode === 410 && /expired/.test(r.body.error), 'and cannot book (410)');
  assert(texts.length === textsBefore, 'Cal gave no text consent: no text');
  const calMail = mailsTo(cal.email).at(-1);
  const calToken = tokenIn(calMail?.html || '');
  assert(!!calToken, 'Cal emailed the link');

  console.log('\n[7] isolation');
  r = await book(C, cal, { date: D, token: calToken });
  assert(r.statusCode === 400 && /not valid/.test(r.body.error), 'another business\'s slug rejects the token');
  assert((await offersFor(W.wid, D, 600)).find((o) => o.id === calOffer.id).status === 'open', 'the offer is untouched');
  r = await call(waitlistListHandler, req({ cookie: C.cookie }));
  assert(r.statusCode === 200 && r.body.entries.length === 0 && r.body.summary.length === 0, 'owner C sees none of W\'s waitlist');
  r = await call(waitlistItemHandler, req({ method: 'DELETE', cookie: C.cookie, query: { id: calId } }));
  assert(r.statusCode === 404 && (await entryOf(calId)).status === 'offered', 'owner C cannot remove W\'s entry');
  r = await call(waitlistItemHandler, req({ method: 'POST', cookie: C.cookie, query: { id: calId }, body: { offer: { date: day(9), startMin: 600, endMin: 660 } } }));
  assert(r.statusCode === 404, 'owner C cannot offer W\'s person a time');

  console.log('\n[8] the owner screen');
  r = await call(waitlistListHandler, req({ cookie: W.cookie }));
  assert(r.statusCode === 200 && r.body.entries.some((x) => x.id === benId && x.status === 'waiting' && /12:00 am to 12:00 pm/.test(x.preferenceLabel) && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/.test(x.preferenceLabel)), `entries listed with a plain preference line (${r.body.entries.find((x) => x.id === benId)?.preferenceLabel})`);
  const calRow = r.body.entries.find((x) => x.id === calId);
  assert(calRow && calRow.status === 'offered' && calRow.lastOffer?.status === 'open' && calRow.serviceName === 'Massage', 'Cal shows "offered" with the open offer');
  assert(r.body.summary.some((s) => s.serviceId === W.svc && s.waiting === 2), `summary: 2 people waiting for Massage (${JSON.stringify(r.body.summary)})`);
  r = await call(waitlistItemHandler, req({ method: 'POST', cookie: W.cookie, query: { id: benId }, body: { offer: { date: day(9), startMin: 600, endMin: 630 } } }));
  assert(r.statusCode === 400 && /length of the service/.test(r.body.error), 'an offer must match the service length');
  r = await call(waitlistItemHandler, req({ method: 'POST', cookie: W.cookie, query: { id: benId }, body: { offer: { date: day(9), startMin: 600, endMin: 660 } } }));
  assert(r.statusCode === 200 && r.body.offer.status === 'open' && r.body.offer.offeredBy === 'owner', 'owner offers Ben a time by hand');
  await settle(300);
  assert(texts.filter((t) => t.To === '+15555550123').length === 2, 'Ben texted again (with consent)');
  r = await call(waitlistItemHandler, req({ method: 'DELETE', cookie: W.cookie, query: { id: calId } }));
  assert(r.statusCode === 204 && (await entryOf(calId)).status === 'cancelled', 'owner removes Cal');
  assert((await sql`SELECT status FROM waitlist_offers WHERE id = ${calOffer.id}`).rows[0].status === 'withdrawn', 'Cal\'s open offer is withdrawn');
  r = await book(W, cal, { date: D, token: calToken });
  assert(r.statusCode === 410, 'a withdrawn link no longer books');

  console.log('\n[9] fill automatically off');
  const Q = await mkBiz('quiet', { autoFill: false });
  await join(Q, ana, { date: D });
  const bq = await confirmedBooking(Q, { date: D });
  await call(ownerBookingHandler, req({ method: 'DELETE', cookie: Q.cookie, query: { id: bq } }));
  await settle(300);
  assert((await offersFor(Q.wid, D, 600)).length === 0, 'no offer goes out when the switch is off; the owner offers by hand');

  console.log('\n[10] Ivy');
  let t = await executeIvyTool('waitlist', { action: 'list' }, { workspaceId: W.wid });
  assert(!t.needs_confirmation && t.entries.some((x) => x.entry_id === benId) && t.waiting.some((x) => x.people >= 1), 'list reads straight away');
  t = await executeIvyTool('waitlist', { action: 'offer', entry_id: benId, date: day(10), start_min: 600, end_min: 660 }, { workspaceId: W.wid });
  assert(t.needs_confirmation === true && /Offer Ben Person/.test(t.summary) && /one-tap link/.test(t.summary), `offer is held for approval (${t.summary})`);
  t = await executeIvyTool('waitlist', { action: 'offer', entry_id: benId, date: day(10), start_min: 600, end_min: 660 }, { workspaceId: C.wid });
  assert(t.error && /not on the waitlist/.test(t.error), 'another workspace cannot see the entry');
  t = await runApprovedTool('waitlist', { action: 'offer', entry_id: benId, date: day(10), start_min: 600, end_min: 660 }, { workspaceId: W.wid });
  assert(t.ok === true && t.offer_id && /Offered Ben Person/.test(t.done), `approved offer runs (${t.done})`);
  t = await executeIvyTool('waitlist', { action: 'remove', entry_id: benId }, { workspaceId: W.wid });
  assert(t.needs_confirmation === true && /Take Ben Person off/.test(t.summary), 'remove is held for approval');
  t = await executeIvyTool('waitlist', { action: 'bogus' }, { workspaceId: W.wid });
  assert(t.error && /action must be/.test(t.error), 'an unknown action is refused before any card');

  console.log('\n[11] expiry and the partner');
  const sig = (await computeSignals(W.wid)).find((s) => s.key === 'waitlist_waiting');
  assert(!!sig && /waiting for Massage/.test(sig.title) && sig.href === '/calendar?waitlist=1', `partner: "${sig?.title}"`);
  await sql`UPDATE waitlist_entries SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${benId}`;
  await sql`UPDATE waitlist_offers SET status = 'withdrawn' WHERE entry_id = ${benId} AND status IN ('open', 'claiming')`;
  await sql`UPDATE waitlist_entries SET status = 'waiting' WHERE id = ${benId}`;
  const n = await expireWaitlistEntries();
  assert(n >= 1 && (await entryOf(benId)).status === 'expired', 'an entry past 60 days expires');
  const sum = await waitlistSummary(W.wid);
  assert(!sum.some((s) => s.serviceId === W.svc), 'expired entries no longer count');
}

run()
  .then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(1); });

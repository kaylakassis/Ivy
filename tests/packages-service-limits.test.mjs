// Packages limited to certain services, the remaining count on every
// booking path, the used-up state, cancellation rules, and the business
// setting "Use package sessions when: booked / completed".
//
//   [1] owner creates a package for one service, edits it to two; bad /
//       foreign service ids are refused
//   [2] service restriction on every path (portal, public page signed in,
//       owner booking, owner "use a session" on an existing booking):
//       refused with package_service_not_covered, nothing used
//   [3] each path uses exactly one session; counts + "booked" are right
//   [4] race for the last session: exactly one booking wins on each path
//   [5] at 0: package_used_up with Buy again / See all services links,
//       portal list shows it as used up (old default list unchanged),
//       last-session confirmation email line
//   [6] expired: package_expired everywhere
//   [7] cancellation rules (booking mode): in time returns, late under the
//       business's fee policy keeps it (no card charge), no policy returns,
//       owner cancel returns, no-show stays used even if cancelled later
//   [8] owner forgot the package: "use a session" afterwards, exactly once
//       even when two taps race; recurring + package refused
//   [9] completion mode: booking holds, completing uses (count unchanged,
//       booked -> used), cancel always releases, no-show uses, completed
//       visit cancelled by the owner stays used; switching modes leaves
//       existing bookings on their own rule
//  [10] isolation: another client / workspace can't use or apply a package
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/packages-service-limits.test.mjs
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import packagesHandler from '../api/packages/index.js';
import packageHandler from '../api/packages/[id].js';
import publicCalendarHandler from '../api/calendar/public/[slug].js';
import mePackagesHandler from '../api/me/packages.js';
import meBookHandler from '../api/me/packages/[id]/book.js';
import meBookingHandler from '../api/me/bookings/[id].js';
import meBookingsHandler from '../api/me/bookings.js';
import ownerBookingsHandler from '../api/calendar/bookings.js';
import ownerBookingHandler from '../api/calendar/bookings/[id].js';
import completeHandler from '../api/calendar/bookings/complete.js';
import noShowHandler from '../api/calendar/bookings/no-show.js';
import calendarHandler from '../api/calendar/index.js';
import clientPackagesHandler from '../api/clients/[id]/packages.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const stripeCalls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  if (/api\.stripe\.com/.test(u)) { stripeCalls.push(u); return json({ id: 'pi_x' }); }
  return json({});
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

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
const req = ({ method = 'GET', cookie, query = {}, body = {}, ip } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST,
    'x-forwarded-for': ip || `198.18.9.${(ipN++ % 250) + 1}`, ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

const STAMP = Date.now();
const noDash = (s) => !/[–—]/.test(String(s || ''));

async function mkBiz(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`sl-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  const slug = `sl-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const svc = async (name) => (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, ${name}, 50, 60, 'public') RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, cut: await svc('Signature Cut'), color: await svc('Color'), massage: await svc('Massage'),
    cookie: `ivy_session=${signSession(u)}` };
}
async function mkClient(label, biz) {
  const email = `sl-client-${label}-${STAMP}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${biz.wid}, ${`${label} Client`}, ${email}, 'active', ${u}) RETURNING id`).rows[0].id;
  return { userId: u, clientId: c, email, cookie: `ivy_session=${signSession(u)}` };
}
// Tuesdays well past the 24h notice. n picks the week.
function tue(n) {
  const d = new Date(Date.now() + (7 + n * 7) * 864e5);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const cpRow = (id) => sql`SELECT * FROM client_packages WHERE id = ${id}`.then((r) => r.rows[0]);
const left = async (id) => Number((await cpRow(id)).credits_remaining);

async function sell(biz, client, body) {
  const r = await call(clientPackagesHandler, req({ method: 'POST', cookie: biz.cookie, query: { id: client.clientId }, body }));
  if (r.statusCode !== 201) throw new Error(`sell failed ${r.statusCode} ${JSON.stringify(r.body)}`);
  return r.body.package;
}

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('A');
  const B = await mkBiz('B');
  const ana = await mkClient('ana', A);
  const ben = await mkClient('ben', A);   // another client at the same business
  const bob = await mkClient('bob', B);   // a client of another business

  // Portal / public / owner booking helpers.
  const portalBook = (cp, serviceId, date, startMin = 600, who = ana) => call(meBookHandler, req({
    method: 'POST', cookie: who.cookie, query: { id: cp.id }, body: { serviceId, slots: [{ date, startMin, endMin: startMin + 60 }] } }));
  const publicBook = (cp, serviceId, date, startMin = 600, who = ana, biz = A) => call(publicCalendarHandler, req({
    method: 'POST', cookie: who.cookie, query: { slug: biz.slug },
    body: { serviceId, date, startMin, endMin: startMin + 60, clientPackageId: cp.id } }));
  const ownerBook = (cp, serviceId, date, startMin = 600, extra = {}, biz = A, who = ana) => call(ownerBookingsHandler, req({
    method: 'POST', cookie: biz.cookie, body: { serviceId, clientId: who.clientId, clientName: 'Ana Client', clientEmail: who.email,
      date, startMin, endMin: startMin + 60, clientPackageId: cp ? cp.id : null, skipConflictCheck: true, ...extra } }));
  const apply = (bookingId, cp, biz = A) => call(ownerBookingHandler, req({
    method: 'PATCH', cookie: biz.cookie, query: { id: bookingId }, body: { applyClientPackageId: cp.id } }));
  const ownerCancel = (id) => call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id } }));
  const clientCancel = (id, who = ana) => call(meBookingHandler, req({ method: 'DELETE', cookie: who.cookie, query: { id } }));
  const complete = (id, date) => call(completeHandler, req({ method: 'POST', cookie: A.cookie, body: { id, occurrenceDate: date } }));
  const ownerPkgs = async () => (await call(clientPackagesHandler, req({ cookie: A.cookie, query: { id: ana.clientId } }))).body.packages;

  console.log('\n[1] owner limits a package to certain services');
  let r = await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: 'Cut Pack', sessionCount: 3, price: 120, serviceIds: [A.cut] } }));
  assert(r.statusCode === 201 && r.body.package.serviceIds.join() === A.cut, 'template limited to Signature Cut');
  const tpl = r.body.package;
  r = await call(packageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: tpl.id }, body: { serviceIds: [A.cut, A.color, A.cut] } }));
  assert(r.statusCode === 200 && r.body.package.serviceIds.length === 2, 'edited to Cut + Color (duplicates collapsed)');
  r = await call(packageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: tpl.id }, body: { serviceIds: ['not-a-uuid'] } }));
  assert(r.statusCode === 400, 'garbage service id refused (no 500)');
  r = await call(packageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: tpl.id }, body: { serviceIds: [B.cut] } }));
  assert(r.statusCode === 400, "another business's service refused");
  r = await call(packageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: tpl.id }, body: { serviceIds: [] } }));
  assert(r.statusCode === 200 && r.body.package.serviceIds.length === 0, 'back to Any service');
  await call(packageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: tpl.id }, body: { serviceIds: [A.cut, A.color] } }));
  r = await call(publicCalendarHandler, req({ query: { slug: A.slug } }));
  assert(r.body.calendar.packages.find((p) => p.id === tpl.id)?.serviceIds.length === 2, 'public page lists which services it covers');

  console.log('\n[2] service restriction on every path');
  const pk = await sell(A, ana, { packageId: tpl.id });
  assert(pk.creditsRemaining === 3 && pk.serviceIds.length === 2, 'Ana has 3 sessions, Cut or Color');
  r = await portalBook(pk, A.massage, tue(0));
  assert(r.statusCode === 400 && r.body.code === 'package_service_not_covered' && noDash(r.body.error), 'portal: Massage refused with a code');
  r = await publicBook(pk, A.massage, tue(0));
  assert(r.statusCode === 400 && r.body.code === 'package_service_not_covered', 'public page: Massage refused');
  r = await ownerBook(pk, A.massage, tue(0));
  assert(r.statusCode === 400 && r.body.code === 'package_service_not_covered', 'owner booking: Massage refused');
  const plain = await ownerBook(null, A.massage, tue(0), 900);
  r = await apply(plain.body.booking.id, pk);
  assert(r.statusCode === 400 && r.body.code === 'package_service_not_covered', 'owner "use a session" on a Massage booking refused');
  assert(await left(pk.id) === 3, 'nothing used by any refusal');

  console.log('\n[3] each path uses exactly one session');
  emails.length = 0;
  r = await portalBook(pk, A.cut, tue(0), 600);
  assert(r.statusCode === 200 && r.body.creditsRemaining === 2, 'portal booking: 3 -> 2');
  r = await publicBook(pk, A.color, tue(1), 600);
  assert(r.statusCode === 201 && r.body.package?.creditsRemaining === 1 && r.body.booking.clientPackageId === pk.id, `public page signed in: 2 -> 1 (${r.statusCode} ${JSON.stringify(r.body).slice(0, 140)})`);
  const pubBookingId = r.body.booking.id;
  const pubRow = (await sql`SELECT client_id, booking_total, deposit_required, package_use_mode FROM bookings WHERE id = ${pubBookingId}`).rows[0];
  assert(pubRow.client_id === ana.clientId && Number(pubRow.booking_total) === 0 && Number(pubRow.deposit_required) === 0 && pubRow.package_use_mode === 'booking',
    'public package booking: on Ana, nothing to pay, stamped booking mode');
  assert(await left(pk.id) === 1, 'database agrees: 1 left');
  let list = await ownerPkgs();
  let mine = list.find((p) => p.id === pk.id);
  assert(mine.creditsRemaining === 1 && mine.sessionsBooked === 2 && mine.sessionsUsed === 0 && mine.serviceNames.join() === 'Color,Signature Cut',
    `owner sees "1 left, 2 booked" and the covered services (${JSON.stringify({ l: mine.creditsRemaining, b: mine.sessionsBooked, u: mine.sessionsUsed })})`);
  r = await call(mePackagesHandler, req({ cookie: ana.cookie }));
  mine = r.body.packages.find((p) => p.id === pk.id);
  assert(mine.creditsRemaining === 1 && mine.lastSession === true && mine.state === 'active' && mine.canBook === true, 'portal: 1 session left, flagged as the last one');

  console.log('\n[4] race for the last session');
  const results = await Promise.all([
    portalBook(pk, A.cut, tue(2), 600),
    publicBook(pk, A.cut, tue(2), 720),
    ownerBook(pk, A.cut, tue(2), 840),
    portalBook(pk, A.color, tue(2), 960),
  ]);
  const wins = results.filter((x) => x.statusCode === 200 || x.statusCode === 201);
  const losses = results.filter((x) => x.statusCode === 400);
  assert(wins.length === 1 && losses.length === 3, `exactly one of four simultaneous bookings wins (${results.map((x) => x.statusCode).join(',')})`);
  assert(losses.every((x) => x.body.code === 'package_used_up'), 'the others are told the package is used up');
  assert(await left(pk.id) === 0, 'count is 0, never below');
  const liveBookings = (await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE client_package_id = ${pk.id} AND cancelled_at IS NULL`).rows[0].n;
  assert(liveBookings === 3, 'three bookings hold the three sessions');

  console.log('\n[5] at 0: used up, with repurchase links');
  r = await portalBook(pk, A.cut, tue(3));
  assert(r.statusCode === 400 && r.body.code === 'package_used_up' && /used all your sessions/.test(r.body.error), 'portal: package_used_up');
  assert(r.body.package.creditsRemaining === 0 && r.body.package.state === 'used_up', 'refusal carries the live count');
  assert(r.body.repurchase.buyAgainUrl === `/book/${A.slug}?buy=${tpl.id}` && r.body.repurchase.bookingUrl === `/book/${A.slug}`, 'Buy again + See all services links');
  r = await publicBook(pk, A.cut, tue(3));
  assert(r.statusCode === 400 && r.body.code === 'package_used_up' && !!r.body.repurchase, 'public page: package_used_up');
  r = await ownerBook(pk, A.cut, tue(3));
  assert(r.statusCode === 400 && r.body.code === 'package_used_up' && /Offer the client a new one/.test(r.body.error), 'owner: used up, offer a new one');
  r = await call(mePackagesHandler, req({ cookie: ana.cookie }));
  assert(!r.body.packages.some((p) => p.id === pk.id), 'old default list (iPhone 1.0.4) still hides used-up packages');
  r = await call(mePackagesHandler, req({ cookie: ana.cookie, query: { include: 'recent' } }));
  mine = r.body.packages.find((p) => p.id === pk.id);
  assert(mine && mine.state === 'used_up' && mine.creditsRemaining === 0 && mine.canBook === false && mine.buyAgainPackageId === tpl.id,
    'recent list shows it as used up with Buy again');
  await settle(700);
  const lastMail = emails.find((e) => /That was your last session in/.test(e.html || ''));
  assert(!!lastMail && lastMail.html.includes(`/book/${A.slug}?buy=${tpl.id}`), 'the confirmation for the last session says so, with a Buy again link');
  const midMail = emails.find((e) => /Paid with your/.test(e.html || '') && /1 session left/.test(e.html || ''));
  assert(!!midMail, 'an earlier confirmation said how many were left');
  // The client buys again (owner sells it here): the old used-up card drops off.
  const pk2 = await sell(A, ana, { packageId: tpl.id });
  r = await call(mePackagesHandler, req({ cookie: ana.cookie, query: { include: 'recent' } }));
  assert(r.body.packages.some((p) => p.id === pk2.id) && !r.body.packages.some((p) => p.id === pk.id), 'after buying again only the new package shows');

  console.log('\n[6] expired');
  await sql`UPDATE client_packages SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${pk2.id}`;
  r = await portalBook(pk2, A.cut, tue(3));
  assert(r.statusCode === 400 && r.body.code === 'package_expired', 'portal: package_expired');
  r = await publicBook(pk2, A.cut, tue(3));
  assert(r.statusCode === 400 && r.body.code === 'package_expired', 'public: package_expired');
  r = await ownerBook(pk2, A.cut, tue(3));
  assert(r.statusCode === 400 && r.body.code === 'package_expired', 'owner: package_expired');
  assert(await left(pk2.id) === 3, 'nothing used');
  await sql`UPDATE client_packages SET expires_at = NULL WHERE id = ${pk2.id}`;

  console.log('\n[7] cancellation rules (sessions used when booked)');
  // No late-cancel policy on Cut: a cancel always gives the session back.
  r = await portalBook(pk2, A.cut, tue(4), 600);
  const c1 = r.body.bookings[0].id;
  r = await clientCancel(c1);
  assert(r.statusCode === 200 && r.body.packageSessionReturned === true && await left(pk2.id) === 3, 'no policy: cancel returns the session');
  // Policy with a 24h window, booking a week out: in time.
  await sql`UPDATE services SET cancellation_fee_amount = 20, cancellation_window_hours = 24 WHERE id = ${A.cut}`;
  r = await portalBook(pk2, A.cut, tue(4), 600);
  r = await clientCancel(r.body.bookings[0].id);
  assert(r.body.packageSessionReturned === true && await left(pk2.id) === 3, 'in time under the policy: returned');
  // 720h window: a booking a week or two out is "late".
  await sql`UPDATE services SET cancellation_window_hours = 720 WHERE id = ${A.cut}`;
  await sql`UPDATE clients SET stripe_customer_id = 'cus_x', payment_method_id = 'pm_x' WHERE id = ${ana.clientId}`;
  stripeCalls.length = 0;
  // (720h = 30 days: a booking two weeks out is inside the window.)
  r = await portalBook(pk2, A.cut, tue(1), 720);
  const lateId = r.body.bookings[0].id;
  r = await call(meBookingsHandler, req({ cookie: ana.cookie }));
  const lateItem = r.body.upcoming.find((b) => b.id === lateId);
  assert(lateItem.fromPackage && lateItem.packageName === 'Cut Pack' && lateItem.packageUseMode === 'booking', 'portal booking list says which package paid');
  r = await clientCancel(lateId);
  assert(r.statusCode === 200 && r.body.packageSessionReturned === false && r.body.feeCharged === 0, 'late cancel: session kept, no card charge');
  assert(await left(pk2.id) === 2 && stripeCalls.length === 0, 'count stays 2 and the card was not touched');
  r = await clientCancel(lateId);
  assert(r.statusCode === 400 && await left(pk2.id) === 2, 'cancelling again changes nothing');
  await sql`UPDATE services SET cancellation_fee_amount = 0, cancellation_window_hours = 24 WHERE id = ${A.cut}`;
  // Owner cancel: returns.
  r = await ownerBook(pk2, A.cut, tue(5), 600);
  const ob = r.body.booking.id;
  assert(await left(pk2.id) === 1, 'owner booking used one (1 left)');
  r = await ownerCancel(ob);
  assert(r.statusCode === 204 && await left(pk2.id) === 2, 'owner cancel gives it back');
  // No-show then cancel: stays used.
  r = await ownerBook(pk2, A.cut, tue(5), 720);
  const ns = r.body.booking.id;
  r = await call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: ns, chargeFee: false } }));
  assert(r.statusCode === 200 && await left(pk2.id) === 1, 'no-show: session stays used');
  r = await ownerCancel(ns);
  assert(r.statusCode === 204 && await left(pk2.id) === 1, 'cancelling a no-show afterwards does not give it back');

  console.log('\n[8] owner forgot the package');
  r = await ownerBook(null, A.cut, tue(6), 600);
  const forgot = r.body.booking.id;
  assert(r.body.booking.clientPackageId === null && await left(pk2.id) === 1, 'booked without the package: nothing used');
  r = await complete(forgot, tue(6));
  assert(r.statusCode === 200, 'owner marks it complete');
  const taps = await Promise.all([apply(forgot, pk2), apply(forgot, pk2), apply(forgot, pk2)]);
  assert(taps.every((t) => t.statusCode === 200) && await left(pk2.id) === 0, `"Use a session?" Yes, tapped three times at once: one session used (${taps.map((t) => t.statusCode).join(',')})`);
  assert(taps.filter((t) => t.body.alreadyApplied).length === 2, 'two of the taps were no-ops');
  r = await apply(forgot, pk2);
  assert(r.statusCode === 200 && r.body.alreadyApplied === true && await left(pk2.id) === 0, 'applying again is a no-op');
  // Recurring + package refused (one session covers one visit).
  const pk3 = await sell(A, ana, { name: 'Comp 4', sessionCount: 4, price: 0 });
  r = await ownerBook(pk3, A.massage, tue(6), 720, { recurrenceRule: 'weekly' });
  assert(r.statusCode === 400 && r.body.code === 'package_recurring_unsupported' && await left(pk3.id) === 4, 'repeating booking with a package refused, nothing used');
  r = await ownerBook(pk3, A.massage, tue(6), 720);
  const single = r.body.booking.id;
  r = await call(ownerBookingHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: single }, body: { recurrenceRule: 'weekly' } }));
  assert(r.statusCode === 400 && r.body.code === 'package_recurring_unsupported', 'a package booking cannot be turned into a repeating one');
  r = await ownerBook(null, A.massage, tue(7), 600, { recurrenceRule: 'weekly' });
  const series = r.body.booking.id;
  r = await apply(series, pk3);
  assert(r.statusCode === 400 && r.body.code === 'package_recurring_unsupported' && await left(pk3.id) === 3, 'cannot apply a package to a repeating series');
  await ownerCancel(series);

  console.log('\n[9] "Use package sessions when: the session is completed"');
  r = await call(calendarHandler, req({ method: 'PATCH', cookie: A.cookie, body: { packageUseOn: 'completion' } }));
  assert(r.statusCode === 200 && r.body.settings?.packageUseOn === 'completion', `setting saved (${r.statusCode})`);
  r = await call(calendarHandler, req({ method: 'PATCH', cookie: A.cookie, body: { packageUseOn: 'whenever' } }));
  assert(r.statusCode === 400, 'unknown value refused');
  const pk4 = await sell(A, ana, { name: 'Attend 3', sessionCount: 3, price: 0 });
  r = await portalBook(pk4, A.massage, tue(8), 600);
  const h1 = r.body.bookings[0].id;
  assert(r.statusCode === 200 && r.body.creditsRemaining === 2, 'booking holds a session: 2 left to book');
  mine = (await ownerPkgs()).find((p) => p.id === pk4.id);
  assert(mine.creditsRemaining === 2 && mine.sessionsBooked === 1 && mine.sessionsUsed === 0 && mine.sessionsHeld === 1, '"2 left, 1 booked (held), 0 used"');
  assert((await sql`SELECT package_use_mode FROM bookings WHERE id = ${h1}`).rows[0].package_use_mode === 'completion', 'booking stamped with completion mode');
  r = await complete(h1, tue(8));
  assert(r.statusCode === 200 && await left(pk4.id) === 2, 'marking complete does not take a second session');
  mine = (await ownerPkgs()).find((p) => p.id === pk4.id);
  assert(mine.sessionsBooked === 0 && mine.sessionsUsed === 1, 'completed: booked -> used (exactly one)');
  r = await call(completeHandler, req({ method: 'DELETE', cookie: A.cookie, body: { id: h1, occurrenceDate: tue(8) } }));
  mine = (await ownerPkgs()).find((p) => p.id === pk4.id);
  assert(mine.creditsRemaining === 2 && mine.sessionsBooked === 1 && mine.sessionsUsed === 0, 'un-marking complete puts it back to booked');
  await complete(h1, tue(8));
  r = await ownerCancel(h1);
  assert(r.statusCode === 204 && await left(pk4.id) === 2, 'owner cancelling a completed visit: stays used');
  // Late cancel under a fee policy still releases the hold in this mode.
  await sql`UPDATE services SET cancellation_fee_amount = 20, cancellation_window_hours = 720 WHERE id = ${A.massage}`;
  r = await portalBook(pk4, A.massage, tue(1), 840);
  const h2 = r.body.bookings[0].id;
  assert(await left(pk4.id) === 1, 'second booking holds: 1 left');
  r = await clientCancel(h2);
  assert(r.statusCode === 200 && r.body.packageSessionReturned === true && await left(pk4.id) === 2, 'cancel (even late) releases the held session');
  // No-show uses it.
  r = await ownerBook(pk4, A.massage, tue(9), 600);
  const h3 = r.body.booking.id;
  await call(noShowHandler, req({ method: 'POST', cookie: A.cookie, body: { id: h3, chargeFee: false } }));
  mine = (await ownerPkgs()).find((p) => p.id === pk4.id);
  assert(mine.creditsRemaining === 1 && mine.sessionsBooked === 0 && mine.sessionsUsed === 2, 'no-show counts as used');
  r = await ownerCancel(h3);
  assert(await left(pk4.id) === 1, 'cancelling the no-show later keeps it used');
  // Switch back: an existing completion-mode booking keeps its rule.
  r = await portalBook(pk4, A.massage, tue(0), 720);
  const h4 = r.body.bookings[0].id;
  assert(await left(pk4.id) === 0, 'last session held: 0 left');
  r = await portalBook(pk4, A.massage, tue(9), 840);
  assert(r.statusCode === 400 && r.body.code === 'package_used_up', 'nothing left to book while it is held');
  await call(calendarHandler, req({ method: 'PATCH', cookie: A.cookie, body: { packageUseOn: 'booking' } }));
  r = await clientCancel(h4);
  assert(r.body.packageSessionReturned === true && await left(pk4.id) === 1, 'after switching back, the old booking still follows its own rule (late cancel releases)');
  r = await portalBook(pk4, A.massage, tue(0), 840);
  const h5 = r.body.bookings[0].id;
  assert((await sql`SELECT package_use_mode FROM bookings WHERE id = ${h5}`).rows[0].package_use_mode === 'booking', 'new bookings use the new rule');
  r = await clientCancel(h5);
  assert(r.body.packageSessionReturned === false && await left(pk4.id) === 0, 'and a late cancel under the policy keeps it, as in booking mode');
  await sql`UPDATE services SET cancellation_fee_amount = 0, cancellation_window_hours = 24 WHERE id = ${A.massage}`;

  console.log('\n[10] isolation');
  const pk5 = await sell(A, ana, { name: 'Iso 2', sessionCount: 2, price: 0 });
  r = await portalBook(pk5, A.cut, tue(10), 600, ben);
  assert(r.statusCode === 404 && await left(pk5.id) === 2, "Ben (same business) cannot book with Ana's package in the portal");
  r = await publicBook(pk5, A.cut, tue(10), 600, ben);
  assert(r.statusCode === 404 && r.body.code === 'package_not_found' && await left(pk5.id) === 2, '...nor on the public page');
  r = await publicBook(pk5, B.cut, tue(10), 600, bob, B);
  assert(r.statusCode === 404 && await left(pk5.id) === 2, "Bob at another business cannot use it on his business's page");
  r = await publicBook(pk5, A.cut, tue(10), 600, bob, A);
  assert(r.statusCode === 404 && await left(pk5.id) === 2, "...nor on Ana's business page");
  r = await call(publicCalendarHandler, req({ method: 'POST', query: { slug: A.slug },
    body: { serviceId: A.cut, date: tue(10), startMin: 600, endMin: 660, clientPackageId: pk5.id, clientName: 'X', clientEmail: ana.email } }));
  assert(r.statusCode === 401 && await left(pk5.id) === 2, 'signed out: refused, even with her email typed in');
  r = await ownerBook(pk5, A.cut, tue(10), 600, {}, A, ben);
  assert(r.statusCode === 400 && r.body.code === 'package_not_found' && await left(pk5.id) === 2, "owner cannot book Ben on Ana's package");
  const benBooking = (await ownerBook(null, A.cut, tue(10), 900, {}, A, ben)).body.booking.id;
  r = await apply(benBooking, pk5);
  assert(r.statusCode === 400 && await left(pk5.id) === 2, "owner cannot apply Ana's package to Ben's booking");
  r = await apply(benBooking, pk5, B);
  assert(r.statusCode === 404 && await left(pk5.id) === 2, 'another business cannot touch the booking or package');

  // Cleanup
  for (const w of [A, B]) {
    await sql`DELETE FROM bookings WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM client_packages WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM packages WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${w.wid}`;
    await sql`DELETE FROM users WHERE id = ${w.userId}`;
  }
  for (const u of [ana, ben, bob]) await sql`DELETE FROM users WHERE id = ${u.userId}`;
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});

// The first win (api/_lib/firstWin.js + api/onboarding/first-win.js):
//   • prepareFirstWin drafts a service + booking link + UNPUBLISHED website
//     + a client-less first invoice from real onboarding answers, creates
//     nothing when the answers are missing, and never duplicates.
//   • The website draft carries no placeholder reviews, numbers or logos.
//   • recordFirstRealBooking / recordFirstRealPayment set the celebration
//     flags exactly once, only for client-made bookings and real payments,
//     never for sample data or owner-added rows; the dashboard moment is
//     shown once.
//   • The dashboard to-dos (/api/me/setup-status) clear when the booking
//     link is shared, the website is published and the first invoice is
//     sent, and sample data never completes them.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/first-win.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  prepareFirstWin, firstWinStatus, buildFirstWebsitePages,
  recordFirstRealBooking, recordFirstRealPayment,
  pendingCelebrations, markCelebrationShown, markBookingLinkShared, markFirstWinSeen,
} from '../api/_lib/firstWin.js';
const { default: setupStatus } = await import('../api/me/setup-status.js');
const { default: dashboard } = await import('../api/dashboard.js');
const { default: firstWinApi } = await import('../api/onboarding/first-win.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

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
const reqFor = (uid, { method = 'GET', body } = {}) => ({
  method, url: '/test', query: {}, body,
  headers: {
    host: 'localhost:3001', origin: 'http://localhost:3001', 'user-agent': 'test/1.0',
    'content-type': 'application/json', cookie: `ivy_session=${signSession(uid)}`,
  },
  on() {},
});

async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`firstwin-${tag}-${S}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}
const countNotif = async (uid, tag) =>
  Number((await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${uid} AND tag = ${tag}`).rows[0].n);
const items = (res) => Object.fromEntries((res.body?.items || []).map((i) => [i.id, i]));

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] missing answers create nothing');
  const a = await owner('a');
  let st = await prepareFirstWin(a.workspaceId);
  assert(st.missing.includes('businessName') && st.missing.includes('service'), `reports what is missing (${st.missing.join(', ')})`);
  assert(st.booking.ready === false && st.booking.slug === null, 'no booking link without a real business name');
  assert(st.website.ready === false, 'no website draft');
  assert(st.invoice.ready === false, 'no invoice draft');
  let n = await sql`SELECT (SELECT COUNT(*)::int FROM services WHERE workspace_id = ${a.workspaceId}) AS s,
                           (SELECT COUNT(*)::int FROM websites WHERE workspace_id = ${a.workspaceId}) AS w,
                           (SELECT COUNT(*)::int FROM invoices WHERE workspace_id = ${a.workspaceId}) AS i`;
  assert(n.rows[0].s === 0 && n.rows[0].w === 0 && n.rows[0].i === 0, 'no service, website or invoice rows were written');

  console.log('\n[2] real answers → service + booking link + unpublished website + invoice draft');
  const biz = `Rita Ross Coaching ${S}`;
  st = await prepareFirstWin(a.workspaceId, {
    bizName: biz, tagline: 'Calm, practical coaching.',
    service: { name: 'Coaching session', durationMinutes: 60, price: 120 },
    availability: { 1: [{ start: 540, end: 1020 }], 3: [{ start: 600, end: 900 }] },
    timezone: 'America/Chicago',
  });
  assert(st.missing.length === 0, 'nothing missing');
  assert(st.booking.ready && st.booking.services.length === 1 && st.booking.services[0].name === 'Coaching session', 'one bookable service created from the answer');
  assert(st.booking.slug === `rita-ross-coaching-${S}` && /\/book\/rita-ross-coaching-/.test(st.booking.url), `booking link derived from the name (${st.booking.url})`);
  const web = (await sql`SELECT * FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0];
  assert(!!web && web.launched === false && web.published_at === null, 'website draft exists and is NOT published');
  assert(web.handle === `rita-ross-coaching-${S}` && web.business_name === biz, 'draft carries the real name and handle');
  const types = (web.pages[0]?.sections || []).map((s) => s.type);
  assert(types.includes('hero') && types.includes('services') && types.includes('hours') && types.includes('booking') && types.includes('contact') && types.includes('footer'),
    `sections from real answers (${types.join(', ')})`);
  assert(!types.some((t) => ['testimonials', 'stats', 'logos', 'pricing', 'pricing_table'].includes(t)), 'no placeholder reviews, numbers or logos');
  const hero = web.pages[0].sections.find((s) => s.type === 'hero');
  const svcSec = web.pages[0].sections.find((s) => s.type === 'services');
  const hoursSec = web.pages[0].sections.find((s) => s.type === 'hours');
  assert(hero.data.headline === biz && hero.data.sub === 'Calm, practical coaching.', 'hero uses the real name and tagline');
  assert(svcSec.data.items.length === 1 && svcSec.data.items[0].name === 'Coaching session' && svcSec.data.items[0].price === '$120.00' && svcSec.data.items[0].duration === '60 min',
    'services section lists only the real service');
  const mon = hoursSec.data.days.find((d) => d.label === 'Mon'), tue = hoursSec.data.days.find((d) => d.label === 'Tue');
  assert(mon.hours === '9:00 AM to 5:00 PM' && tue.hours === 'Closed' && hoursSec.data.timezone === 'America/Chicago', 'hours mirror the real availability');
  assert(st.website.ready && st.website.launched === false && st.website.sectionCount === types.length, 'status reports the draft');
  const inv = (await sql`SELECT * FROM invoices WHERE workspace_id = ${a.workspaceId}`).rows;
  assert(inv.length === 1 && inv[0].status === 'draft' && inv[0].client_id === null && inv[0].client_name === null, 'one draft invoice with no client attached');
  assert(inv[0].items[0].description === 'Coaching session' && Number(inv[0].items[0].rate) === 120, 'priced from the first service');
  assert(st.invoice.ready && st.invoice.id === inv[0].id && Number(st.invoice.amount) === 120, 'status points at the draft');
  const ws1 = (await sql`SELECT first_win_prepared_at, first_win_invoice_id FROM workspaces WHERE id = ${a.workspaceId}`).rows[0];
  assert(!!ws1.first_win_prepared_at && ws1.first_win_invoice_id === inv[0].id, 'workspace stamped as prepared');

  console.log('\n[3] re-running never duplicates');
  await prepareFirstWin(a.workspaceId, { service: { name: 'Another thing', durationMinutes: 30, price: 10 } });
  n = await sql`SELECT (SELECT COUNT(*)::int FROM services WHERE workspace_id = ${a.workspaceId}) AS s,
                       (SELECT COUNT(*)::int FROM invoices WHERE workspace_id = ${a.workspaceId}) AS i`;
  const web2 = (await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0];
  assert(n.rows[0].s === 1 && n.rows[0].i === 1, 'still one service and one invoice');
  assert(web2.pages[0].id === web.pages[0].id, 'website draft untouched');
  // An owner's own website content is never overwritten either.
  await sql`UPDATE websites SET pages = ${JSON.stringify([{ id: 'mine', slug: '', title: 'Home', sections: [{ id: 'x', type: 'hero', data: { headline: 'Mine' } }] }])}::jsonb WHERE workspace_id = ${a.workspaceId}`;
  await prepareFirstWin(a.workspaceId);
  assert((await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0].pages[0].id === 'mine', 'owner-built pages are kept');

  console.log('\n[4] pure builder: no services or hours → no services/hours sections');
  const pages = buildFirstWebsitePages({ bizName: 'Solo', services: [], availability: {}, slug: 'solo' });
  const t2 = pages[0].sections.map((s) => s.type);
  assert(t2.join(',') === 'hero,booking,contact,footer', `only sections with real content (${t2.join(',')})`);
  assert(pages[0].sections.find((s) => s.type === 'booking').data.handle === 'solo', 'booking section points at the booking slug');

  console.log('\n[5] first booking celebration: once, client-made, never sample data');
  const demoCli = (await sql`INSERT INTO clients (workspace_id, name, source, stage) VALUES (${a.workspaceId}, 'John Doe', 'demo', 'active') RETURNING id`).rows[0].id;
  const demoBk = (await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, notes)
    VALUES (${a.workspaceId}, ${demoCli}, 'John Doe', 'john.doe@example.com', CURRENT_DATE + 1, 600, 660, '[Sample] Example appointment') RETURNING id`).rows[0].id;
  assert((await recordFirstRealBooking({ workspaceId: a.workspaceId, bookingId: demoBk, source: 'public' })) === false, 'sample booking does not celebrate');
  const cli = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${a.workspaceId}, 'Rita Patel', 'rita@example.com', 'active') RETURNING id`).rows[0].id;
  const svcId = (await sql`SELECT id FROM services WHERE workspace_id = ${a.workspaceId}`).rows[0].id;
  const ownerBk = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${a.workspaceId}, ${svcId}, ${cli}, 'Rita Patel', 'rita@example.com', CURRENT_DATE + 2, 540, 600) RETURNING id`).rows[0].id;
  assert((await recordFirstRealBooking({ workspaceId: a.workspaceId, bookingId: ownerBk, source: 'owner' })) === false, 'owner-added booking does not celebrate');
  let flags = (await sql`SELECT first_booking_celebrated_at FROM workspaces WHERE id = ${a.workspaceId}`).rows[0];
  assert(flags.first_booking_celebrated_at === null, 'flag still unset');
  const realBk = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${a.workspaceId}, ${svcId}, ${cli}, 'Rita Patel', 'rita@example.com', CURRENT_DATE + 3, 870, 930) RETURNING id`).rows[0].id;
  assert((await recordFirstRealBooking({ workspaceId: a.workspaceId, bookingId: realBk, source: 'public' })) === true, 'first client booking celebrates');
  flags = (await sql`SELECT first_booking_celebrated_at, first_booking_celebration FROM workspaces WHERE id = ${a.workspaceId}`).rows[0];
  assert(!!flags.first_booking_celebrated_at, 'first_booking_celebrated_at set');
  assert(flags.first_booking_celebration.clientFirstName === 'Rita' && flags.first_booking_celebration.timeLabel === '2:30 PM' && flags.first_booking_celebration.serviceName === 'Coaching session',
    'celebration carries the first name, time and service');
  const bkNotif = (await sql`SELECT type, title FROM notifications WHERE user_id = ${a.userId} AND tag = 'first-win-booking'`).rows;
  assert(bkNotif.length === 1 && bkNotif[0].type === 'bookings' && bkNotif[0].title === 'Your first booking is in.', 'one in-app notification of type bookings');
  const realBk2 = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${a.workspaceId}, ${svcId}, ${cli}, 'Rita Patel', 'rita@example.com', CURRENT_DATE + 4, 870, 930) RETURNING id`).rows[0].id;
  assert((await recordFirstRealBooking({ workspaceId: a.workspaceId, bookingId: realBk2, source: 'public' })) === false, 'second booking does not re-fire');
  const flags2 = (await sql`SELECT first_booking_celebrated_at FROM workspaces WHERE id = ${a.workspaceId}`).rows[0];
  assert(String(flags2.first_booking_celebrated_at) === String(flags.first_booking_celebrated_at), 'timestamp unchanged');
  assert(await countNotif(a.userId, 'first-win-booking') === 1, 'still one notification');

  console.log('\n[6] first payment celebration: once, real invoices only');
  const demoInv = (await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at, paid_amount)
    VALUES (${a.workspaceId}, 'SAMPLE-ABCD', ${demoCli}, 'John Doe', ${JSON.stringify([{ description: 'Sample service', quantity: 1, rate: 100 }])}::jsonb, 'paid', NOW(), 100) RETURNING id`).rows[0].id;
  assert((await recordFirstRealPayment({ workspaceId: a.workspaceId, invoiceId: demoInv })) === false, 'sample invoice paid does not celebrate');
  const unpaid = (await sql`SELECT id FROM invoices WHERE workspace_id = ${a.workspaceId} AND status = 'draft'`).rows[0].id;
  assert((await recordFirstRealPayment({ workspaceId: a.workspaceId, invoiceId: unpaid })) === false, 'an unpaid invoice does not celebrate');
  await sql`UPDATE invoices SET client_id = ${cli}, client_name = 'Rita Patel', status = 'paid', paid_at = NOW(), paid_amount = 120 WHERE id = ${unpaid}`;
  assert((await recordFirstRealPayment({ workspaceId: a.workspaceId, invoiceId: unpaid })) === true, 'first real payment celebrates');
  const pay = (await sql`SELECT first_payment_celebrated_at, first_payment_celebration FROM workspaces WHERE id = ${a.workspaceId}`).rows[0];
  assert(!!pay.first_payment_celebrated_at && pay.first_payment_celebration.amountLabel === '$120.00' && pay.first_payment_celebration.clientFirstName === 'Rita', 'flag + amount recorded');
  const payNotif = (await sql`SELECT type, title FROM notifications WHERE user_id = ${a.userId} AND tag = 'first-win-payment'`).rows;
  assert(payNotif.length === 1 && payNotif[0].type === 'payments' && payNotif[0].title === 'Your first payment is in.', 'one notification of type payments');
  assert((await recordFirstRealPayment({ workspaceId: a.workspaceId, invoiceId: unpaid })) === false, 'does not re-fire');

  console.log('\n[7] the dashboard shows each moment once');
  let pending = await pendingCelebrations(a.workspaceId);
  assert(pending.length === 2 && pending.map((c) => c.kind).sort().join(',') === 'booking,payment', 'both moments pending');
  let res = mkRes();
  await dashboard(reqFor(a.userId), res);
  assert(res.statusCode === 200 && res.body?.firstWin?.celebrations?.length === 2, 'dashboard payload carries them');
  res = mkRes();
  await firstWinApi(reqFor(a.userId, { method: 'POST', body: { action: 'celebration_seen', kind: 'booking' } }), res);
  assert(res.statusCode === 200 && res.body.celebrations.length === 1 && res.body.celebrations[0].kind === 'payment', 'marking the booking moment shown removes it');
  await markCelebrationShown(a.workspaceId, 'payment');
  pending = await pendingCelebrations(a.workspaceId);
  assert(pending.length === 0, 'nothing pending after both shown');
  res = mkRes();
  await dashboard(reqFor(a.userId), res);
  assert(res.body?.firstWin?.celebrations?.length === 0, 'dashboard never replays them');
  const stillSet = (await sql`SELECT first_booking_celebrated_at, first_payment_celebrated_at FROM workspaces WHERE id = ${a.workspaceId}`).rows[0];
  assert(!!stillSet.first_booking_celebrated_at && !!stillSet.first_payment_celebrated_at, 'celebrated flags stay set');

  console.log('\n[8] ready cards show on the first dashboard visit, then never again');
  const b = await owner('b');
  res = mkRes();
  await dashboard(reqFor(b.userId), res);
  assert(res.body?.firstWin?.showReady === true, 'fresh onboarded workspace: show the ready cards');
  res = mkRes();
  await firstWinApi(reqFor(b.userId, { method: 'POST', body: { action: 'prepare', answers: { bizName: `Bea Builds ${S}`, service: { name: 'Consult', durationMinutes: 45, price: 80 } } } }), res);
  assert(res.statusCode === 200 && res.body.status.booking.ready && res.body.status.website.ready && res.body.status.invoice.ready, 'POST prepare drafts everything via the API');
  res = mkRes();
  await firstWinApi(reqFor(b.userId, { method: 'POST', body: { action: 'seen' } }), res);
  res = mkRes();
  await dashboard(reqFor(b.userId), res);
  assert(res.body?.firstWin?.showReady === false, 'after continuing, the cards are gone for good');
  const c = await owner('c');
  await sql`UPDATE workspaces SET created_at = NOW() - INTERVAL '90 days' WHERE id = ${c.workspaceId}`;
  res = mkRes();
  await dashboard(reqFor(c.userId), res);
  assert(res.body?.firstWin?.showReady === false, 'an established workspace never sees the ready cards');
  const d = await owner('d');
  await sql`UPDATE workspaces SET business_type = 'product' WHERE id = ${d.workspaceId}`;
  res = mkRes();
  await dashboard(reqFor(d.userId), res);
  assert(res.body?.firstWin?.showReady === false, 'a product-only business skips the ready cards');

  console.log('\n[9] dashboard to-dos clear when the thing is actually done');
  res = mkRes();
  await setupStatus(reqFor(b.userId), res);
  let it = items(res);
  assert(it.firstBooking && it.firstBooking.done === false && it.website.done === false && it.firstInvoice.done === false, 'link not shared, site not live, nothing sent: three open to-dos');
  assert(it.firstBooking.label === 'Share your booking link', 'booking to-do is about sharing the link');
  // Sample data completes nothing.
  const bDemo = (await sql`INSERT INTO clients (workspace_id, name, source, stage) VALUES (${b.workspaceId}, 'John Doe', 'demo', 'active') RETURNING id`).rows[0].id;
  await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, notes)
    VALUES (${b.workspaceId}, ${bDemo}, 'John Doe', 'john.doe@example.com', CURRENT_DATE + 1, 600, 660, '[Sample] Example appointment')`;
  await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, sent_at)
    VALUES (${b.workspaceId}, 'SAMPLE-ZZZZ', ${bDemo}, 'John Doe', '[]'::jsonb, 'sent', NOW())`;
  res = mkRes();
  await setupStatus(reqFor(b.userId), res);
  it = items(res);
  assert(it.firstClient.done === false && it.firstBooking.done === false && it.firstInvoice.done === false, 'sample client, booking and invoice complete nothing');
  // Share the link via the API → done.
  res = mkRes();
  await firstWinApi(reqFor(b.userId, { method: 'POST', body: { action: 'shared' } }), res);
  assert(res.statusCode === 200 && !!res.body.status.booking.sharedAt, 'shared is recorded');
  // Publish the website + send the invoice.
  await sql`UPDATE websites SET launched = TRUE, published_at = NOW(), published_pages = pages WHERE workspace_id = ${b.workspaceId}`;
  const draftId = res.body.status.invoice.id;
  await sql`UPDATE invoices SET client_name = 'Ana Lee', status = 'sent', sent_at = NOW() WHERE id = ${draftId}`;
  res = mkRes();
  await setupStatus(reqFor(b.userId), res);
  it = items(res);
  assert(it.firstBooking.done === true && it.website.done === true && it.firstInvoice.done === true, 'all three to-dos cleared');
  assert(!res.body.items.some((i) => i.id === 'firstBooking' && i.done === false), 'no duplicate open booking to-do');
  // The status endpoint reflects the sent invoice, and a shared link stays done.
  st = await firstWinStatus(b.workspaceId);
  assert(st.invoice.sentCount === 1 && st.invoice.ready === false && !!st.booking.sharedAt, 'status: invoice sent, link shared');
  await markBookingLinkShared(b.workspaceId); await markFirstWinSeen(b.workspaceId);
  res = mkRes();
  await setupStatus(reqFor(b.userId), res);
  assert(items(res).firstBooking.done === true, 'stays done');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

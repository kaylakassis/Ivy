// Tests the public-booking fixes:
//   • slotsForDate hides past times + honors minimum advance notice
//   • the booking POST validates START alignment (not duration) — so a
//     45-min service on a 30-min grid books at a valid start (the bug in
//     the screenshot), and enforces past + lead-time server-side.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/booking-notice.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { slotsForDate } from '../src/features/calendar/utils.js';
import slugHandler from '../api/calendar/public/[slug].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    setHeader() {}, getHeader() {}, end(s) { this.body = s; return this; },
  };
}
const fullWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]]));
const cal = (minNoticeHours) => ({ settings: { availability: fullWeek, slotMinutes: 30, minNoticeHours }, blocks: [], bookings: [] });
const svc = { id: 'svc', durationMinutes: 45, capacity: 1 };
const iso = (d) => d.toISOString().slice(0, 10);

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] slotsForDate hides past + too-soon slots (the displayed grid)');
  const today = new Date();
  const past = slotsForDate(cal(0), today, svc).find((s) => s.start === 0); // 00:00 today
  assert(past && !past.available && past.reason === 'Past', 'a midnight-today slot is Past/unavailable even with 0 notice');

  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  assert(slotsForDate(cal(0), tomorrow, svc).some((s) => s.available), 'tomorrow has bookable slots with no notice');
  const blocked = slotsForDate(cal(720), tomorrow, svc); // 30-day notice
  assert(blocked.length > 0 && blocked.every((s) => !s.available && s.reason === 'Too soon'), 'a 30-day notice blocks all of tomorrow as Too soon');
  const weekOut = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  assert(slotsForDate(cal(24), weekOut, svc).some((s) => s.available), 'a week out is bookable under a 24h notice');

  console.log('\n[2] booking POST — start alignment (the screenshot bug) + notice/past enforcement');
  const tag = `bn-${Date.now()}`;
  const slug = `bn-${Date.now()}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, slug, slot_minutes, min_notice_hours, availability)
     VALUES ($1,$2,30,0,$3::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET slug=$2, slot_minutes=30, min_notice_hours=0, availability=$3::jsonb`,
    [wid, slug, JSON.stringify(fullWeek)],
  );
  const sid = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price)
    VALUES (${wid}, 'Free Consultation', 45, 1, 0) RETURNING id`).rows[0].id;

  const post = async (body) => {
    const r = mockRes();
    await slugHandler({ method: 'POST', query: { slug }, headers: { origin: 'http://localhost:3000', host: 'localhost:3000' }, body }, r);
    return r;
  };
  const base = { serviceId: sid, clientName: 'Kayla', clientEmail: 'kayla@example.com', smsConsent: false };
  const future = iso(new Date(Date.now() + 5 * 24 * 3600 * 1000));

  // 45-min service, aligned 10:00 start on a 30-min grid — used to 400 with
  // "Slot must align to 30-minute increments". Should now succeed.
  let r = await post({ ...base, date: future, startMin: 600, endMin: 645 });
  assert([200,201].includes(r.statusCode), `45-min service books at an aligned 10:00 start (got ${r.statusCode}: ${r.body?.error || 'ok'})`);

  // Misaligned start (10:15) is rejected.
  r = await post({ ...base, date: future, startMin: 615, endMin: 660 });
  assert(r.statusCode === 400 && /align/i.test(r.body?.error || ''), 'a 10:15 start on a 30-min grid is rejected (start alignment)');

  // Past date is rejected.
  r = await post({ ...base, date: '2020-01-06', startMin: 600, endMin: 645 });
  assert(r.statusCode === 400 && /passed/i.test(r.body?.error || ''), 'a past date is rejected');

  // Lead-time: require 48h, then a ~24h-out slot is too soon; 96h-out is fine.
  await sql`UPDATE calendar_settings SET min_notice_hours = 48 WHERE workspace_id = ${wid}`;
  const tdate = iso(new Date(Date.now() + 24 * 3600 * 1000));
  r = await post({ ...base, date: tdate, startMin: 600, endMin: 645 });
  assert(r.statusCode === 400 && /in advance/i.test(r.body?.error || ''), 'within the 48h notice window is rejected');
  const fdate = iso(new Date(Date.now() + 4 * 24 * 3600 * 1000));
  r = await post({ ...base, date: fdate, startMin: 600, endMin: 645 });
  assert([200,201].includes(r.statusCode), `beyond the notice window books fine (got ${r.statusCode}: ${r.body?.error || 'ok'})`);

  console.log('\n[3] start-time spacing — fixed grid vs fit-to-service');
  const calX = (extra) => ({ settings: { availability: fullWeek, slotMinutes: 30, minNoticeHours: 0, ...extra }, blocks: [], bookings: [] });
  const future2 = new Date(Date.now() + 10 * 24 * 3600 * 1000);
  const topHour = slotsForDate(calX({ slotMinutes: 60 }), future2, svc);
  assert(topHour.length > 0 && topHour.every((s) => s.start % 60 === 0), 'top-of-hour grid: every start is on the hour');
  const fit = slotsForDate(calX({ slotFitService: true }), future2, svc); // 45-min service
  assert(fit.length > 1 && (fit[1].start - fit[0].start) === 45, 'fit-to-service: starts step by the 45-min service length');

  // Server enforces the owner's grid: top-of-the-hour rejects a 1:45 start.
  await sql`UPDATE calendar_settings SET min_notice_hours = 0, slot_minutes = 60, slot_fit_service = FALSE WHERE workspace_id = ${wid}`;
  r = await post({ ...base, date: future, startMin: 825, endMin: 870 }); // 1:45–2:30
  assert(r.statusCode === 400 && /align/i.test(r.body?.error || ''), 'top-of-hour: a 1:45 start is rejected');
  r = await post({ ...base, date: future, startMin: 900, endMin: 945 }); // 3:00–3:45
  assert([200,201].includes(r.statusCode), `top-of-hour: a 3:00 start is allowed (got ${r.statusCode}: ${r.body?.error || 'ok'})`);

  // Fit-to-service: a duration-stepped 10:45 start (off the hour grid) is allowed.
  await sql`UPDATE calendar_settings SET slot_fit_service = TRUE WHERE workspace_id = ${wid}`;
  r = await post({ ...base, date: future, startMin: 645, endMin: 690 }); // 10:45–11:30 (back-to-back after the 10:00 booking)
  assert([200,201].includes(r.statusCode), `fit-to-service: a duration-stepped 10:45 start is allowed (got ${r.statusCode}: ${r.body?.error || 'ok'})`);

  console.log('\n[4] buffer between appointments bars booking too close');
  // slotsForDate: a 30-min buffer greys a slot too near an existing booking.
  const calBuf = (b) => ({ settings: { availability: fullWeek, slotMinutes: 30, minNoticeHours: 0, bufferMinutes: b }, blocks: [], bookings: [{ date: iso(future2), startMin: 600, endMin: 645, serviceId: 'other' }] });
  const slot11 = (b) => slotsForDate(calBuf(b), future2, svc).find((s) => s.start === 660); // 11:00
  assert(slot11(30) && slot11(30).available === false, '30-min buffer: 11:00 (15 min after a 10:45 end) is NOT bookable');
  assert(slot11(0) && slot11(0).available === true, 'no buffer: that same 11:00 slot IS bookable');

  // Server enforces the buffer on the public POST.
  await sql`UPDATE calendar_settings SET slot_fit_service = FALSE, slot_minutes = 30, buffer_minutes = 30, min_notice_hours = 0 WHERE workspace_id = ${wid}`;
  const bufDate = iso(new Date(Date.now() + 12 * 24 * 3600 * 1000));
  await sql.query(
    `INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min)
     VALUES ($1,$2,'Existing','e@example.com',$3,600,645)`,
    [wid, sid, bufDate],
  );
  r = await post({ ...base, date: bufDate, startMin: 660, endMin: 705 }); // 11:00, only 15 min after the 10:45 end
  assert(r.statusCode === 400 && /taken|filled/i.test(r.body?.error || ''), 'server: a slot within the 30-min buffer is rejected');
  r = await post({ ...base, date: bufDate, startMin: 720, endMin: 765 }); // 12:00, 75 min gap
  assert([200,201].includes(r.statusCode), `server: a slot beyond the buffer books fine (got ${r.statusCode}: ${r.body?.error || 'ok'})`);

  console.log('\n[5] booking horizon — how far ahead clients can book');
  // slotsForDate: days beyond the horizon are 'Too far'; within stays open;
  // 0 = no limit.
  const calAdv = (days) => ({ settings: { availability: fullWeek, slotMinutes: 30, minNoticeHours: 0, maxAdvanceDays: days }, blocks: [], bookings: [] });
  const wayOut = new Date(Date.now() + 40 * 24 * 3600 * 1000); // 40 days out
  const within = new Date(Date.now() + 10 * 24 * 3600 * 1000); // 10 days out
  const farSlots = slotsForDate(calAdv(14), wayOut, svc);
  assert(farSlots.length > 0 && farSlots.every((s) => !s.available && s.reason === 'Too far'), '14-day horizon: a 40-day-out day is all Too far');
  assert(slotsForDate(calAdv(14), within, svc).some((s) => s.available), '14-day horizon: a 10-day-out day still bookable');
  assert(slotsForDate(calAdv(0), wayOut, svc).some((s) => s.available), 'no-limit (0): a 40-day-out day is bookable');

  // Server enforces the horizon on the public POST. Reset the rate limiter
  // first — the earlier sections have already spent this IP's hourly quota.
  await sql`TRUNCATE rate_limits`;
  await sql`UPDATE calendar_settings SET min_notice_hours = 0, slot_minutes = 30, slot_fit_service = FALSE, buffer_minutes = 0, max_advance_days = 14 WHERE workspace_id = ${wid}`;
  const farDate = iso(new Date(Date.now() + 30 * 24 * 3600 * 1000)); // 30 days > 14-day horizon
  r = await post({ ...base, date: farDate, startMin: 600, endMin: 645 });
  assert(r.statusCode === 400 && /up to/i.test(r.body?.error || ''), 'server: a booking beyond the 14-day horizon is rejected');
  const nearDate = iso(new Date(Date.now() + 7 * 24 * 3600 * 1000)); // 7 days < 14-day horizon
  r = await post({ ...base, date: nearDate, startMin: 660, endMin: 705 });
  assert([200,201].includes(r.statusCode), `server: a booking within the horizon is allowed (got ${r.statusCode}: ${r.body?.error || 'ok'})`);

  // Cleanup.
  await sql`DELETE FROM bookings WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM services WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM calendar_settings WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

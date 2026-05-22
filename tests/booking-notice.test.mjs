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

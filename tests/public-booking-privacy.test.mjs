// Public booking page privacy.
//   • GET /api/calendar/public/:slug bookings carry only the slot-grid
//     fields (no client id, meeting link, revenue, notes, no-show state)
//   • only current rows: past one-off bookings are not served; a recurring
//     series that is still running is
//   • POST with an existing client's email never overwrites their phone,
//     address or consent; it only fills blanks. The submitted phone stays
//     on the booking row.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/public-booking-privacy.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import slugHandler from '../api/calendar/public/[slug].js';
import bizHandler from '../api/businesses/[slug]/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Swallow outbound mail (confirmation / claim invites).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'em' }), text: async () => '{}' });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
const STAMP = Date.now();
let ipN = Math.floor(Math.random() * 200);
function req({ method = 'GET', body = {}, query = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `192.0.2.${(ipN % 200) + 20}` } };
}
const call = async (o) => { const r = mockRes(); await slugHandler(req(o), r); return r; };

const SLUG = `pbp-${STAMP}`;
const em = (t) => `pbp-${t}-${STAMP}@example.com`;
const fullWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]]));
const iso = (d) => d.toISOString().slice(0, 10);
const ALLOWED = ['cancelledOccurrences', 'date', 'endMin', 'id', 'recurrenceRule', 'recurrenceUntil', 'serviceId', 'staffId', 'startMin', 'status'];
let userId, wsId;

async function run() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${em('owner')}, 'x', 'Pia Owner', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  wsId = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${userId}, 'Privacy WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, availability)
     VALUES ($1, 'Privacy Studio', $2, 'UTC', 30, 0, $3::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET slug = $2, timezone = 'UTC', slot_minutes = 30, min_notice_hours = 0, availability = $3::jsonb`,
    [wsId, SLUG, JSON.stringify(fullWeek)],
  );
  const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price, location_type)
    VALUES (${wsId}, 'Video Session', 60, 1, 120, 'virtual') RETURNING id`).rows[0].id;
  const staffId = (await sql`INSERT INTO staff_members (workspace_id, name, active, owner_managed) VALUES (${wsId}, 'Sky', TRUE, TRUE) RETURNING id`).rows[0].id;
  const cl = (await sql`INSERT INTO clients (workspace_id, name, email, phone, address, stage)
    VALUES (${wsId}, 'Quinn Known', ${em('quinn')}, '+15555550100', '1 Known St', 'active') RETURNING id`).rows[0].id;

  const future = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min,
      notes, staff_id, booking_total, deposit_paid, tip_amount, video_room_url, no_show_at, completion_log, location_address)
    VALUES (${wsId}, ${svc}, ${cl}, 'Quinn Known', ${em('quinn')}, CURRENT_DATE + 3, 600, 660,
      'private note', ${staffId}, 120, 40, 15, 'https://meet.jit.si/ivy-secretroom', NULL, '{}'::jsonb, '9 Hidden Ln') RETURNING id`).rows[0].id;
  const past = (await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min)
    VALUES (${wsId}, ${svc}, 'Old Timer', ${em('old')}, CURRENT_DATE - 30, 600, 660) RETURNING id`).rows[0].id;
  const series = (await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min, recurrence_rule)
    VALUES (${wsId}, ${svc}, 'Weekly Wanda', ${em('wanda')}, CURRENT_DATE - 28, 720, 780, 'weekly') RETURNING id`).rows[0].id;
  const endedSeries = (await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min, recurrence_rule, recurrence_until)
    VALUES (${wsId}, ${svc}, 'Done Dora', ${em('dora')}, CURRENT_DATE - 60, 780, 840, 'weekly', CURRENT_DATE - 20) RETURNING id`).rows[0].id;

  console.log('\n[1] public GET serves only slot-grid fields');
  let r = await call({ query: { slug: SLUG } });
  assert(r.statusCode === 200, `GET 200 (${r.statusCode})`);
  const bookings = r.body?.calendar?.bookings || [];
  const fb = bookings.find((b) => b.id === future);
  assert(!!fb, 'the upcoming booking is listed');
  assert(bookings.every((b) => JSON.stringify(Object.keys(b).sort()) === JSON.stringify(ALLOWED)), `every booking has exactly ${ALLOWED.join(', ')}`);
  assert(fb && fb.serviceId === svc && fb.staffId === staffId && fb.startMin === 600 && fb.endMin === 660 && fb.status === 'booked', 'grid fields present (service, staff, window, status)');
  const raw = JSON.stringify(r.body.calendar.bookings);
  for (const leak of ['videoRoomUrl', 'clientId', 'bookingTotal', 'depositPaid', 'tipAmount', 'noShowAt', 'completionLog', 'payment', 'clientName', 'notes']) {
    assert(!raw.includes(`"${leak}"`), `no ${leak}`);
  }
  for (const secret of ['secretroom', 'private note', '9 Hidden Ln', 'Quinn', cl]) {
    assert(!raw.includes(secret), `value "${String(secret).slice(0, 12)}" not in the payload`);
  }

  console.log('\n[1b] a virtual service never publishes the owner\'s own meeting link');
  const zoom = 'https://zoom.us/j/9998887776?pwd=ownerSecret';
  const vsvc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price, location_type, location_label)
    VALUES (${wsId}, 'Zoom Coaching', 60, 1, 90, 'virtual', ${zoom}) RETURNING id`).rows[0].id;
  const psvc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price, location_type, location_label)
    VALUES (${wsId}, 'Studio Session', 60, 1, 90, 'in_person', '12 Studio Rd') RETURNING id`).rows[0].id;
  await sql`UPDATE calendar_settings SET discoverable = TRUE WHERE workspace_id = ${wsId}`;
  r = await call({ query: { slug: SLUG } });
  const pubSvcs = r.body?.calendar?.services || [];
  assert(!JSON.stringify(r.body).includes('ownerSecret'), 'booking page payload has no meeting link');
  assert(pubSvcs.find((x) => x.id === vsvc)?.locationType === 'virtual', 'virtual service still listed as online');
  assert(pubSvcs.find((x) => x.id === psvc)?.locationLabel === '12 Studio Rd', 'in-person address still shown');
  const br = mockRes();
  await bizHandler(req({ query: { slug: SLUG } }), br);
  assert(br.statusCode === 200, `business profile 200 (${br.statusCode})`);
  assert(!JSON.stringify(br.body).includes('ownerSecret'), 'business profile has no meeting link');
  assert((br.body?.services || []).find((x) => x.id === psvc)?.locationLabel === '12 Studio Rd', 'business profile keeps the in-person address');

  console.log('\n[2] only current rows');
  const ids = bookings.map((b) => b.id);
  assert(!ids.includes(past), 'a month-old one-off booking is not served');
  assert(ids.includes(series), 'a running weekly series (first date long past) is served');
  assert(!ids.includes(endedSeries), 'a series that ended weeks ago is not served');

  console.log('\n[3] booking with an existing email fills blanks, never overwrites');
  const day = iso(new Date(Date.now() + 6 * 86400e3));
  r = await call({ method: 'POST', query: { slug: SLUG }, body: {
    serviceId: svc, date: day, startMin: 600, endMin: 660, clientName: 'Quinn Imposter', clientEmail: em('quinn'),
    clientPhone: '+15555550199', smsConsent: true,
  } });
  assert(r.statusCode === 201, `booking created (${r.statusCode}: ${r.body?.error || 'ok'})`);
  let row = (await sql`SELECT phone, sms_consent_at, address FROM clients WHERE id = ${cl}`).rows[0];
  assert(row.phone === '+15555550100', `stored phone unchanged (${row.phone})`);
  assert(row.sms_consent_at === null, 'SMS consent NOT stamped for a different number');
  assert(row.address === '1 Known St', 'address unchanged');
  const newB = (await sql`SELECT client_phone, client_id FROM bookings WHERE workspace_id = ${wsId} AND date = ${day} AND start_min = 600`).rows[0];
  assert(newB?.client_phone === '+15555550199' && newB.client_id === cl, 'submitted phone kept on the booking row, booking attached to the client');

  // Same number as on file: consent may be recorded.
  r = await call({ method: 'POST', query: { slug: SLUG }, body: {
    serviceId: svc, date: day, startMin: 720, endMin: 780, clientName: 'Quinn Known', clientEmail: em('quinn'),
    clientPhone: '+15555550100', smsConsent: true,
  } });
  row = (await sql`SELECT phone, sms_consent_at FROM clients WHERE id = ${cl}`).rows[0];
  assert(r.statusCode === 201 && row.phone === '+15555550100' && row.sms_consent_at !== null, 'consent recorded when the phone matches the one on file');

  // A client with no phone yet: the booking fills it.
  const bare = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wsId}, 'Ria Bare', ${em('ria')}, 'lead') RETURNING id`).rows[0].id;
  r = await call({ method: 'POST', query: { slug: SLUG }, body: {
    serviceId: svc, date: day, startMin: 840, endMin: 900, clientName: 'Ria Bare', clientEmail: em('ria'),
    clientPhone: '+15555550177', smsConsent: true,
  } });
  row = (await sql`SELECT phone, sms_consent_at FROM clients WHERE id = ${bare}`).rows[0];
  assert(r.statusCode === 201 && row.phone === '+15555550177' && row.sms_consent_at !== null, 'empty phone + consent filled from the booking');

  // A client who texted STOP is never opted back in by the public form,
  // even with the same number and the box ticked.
  const stopped = (await sql`INSERT INTO clients (workspace_id, name, email, phone, stage, sms_consent_at, sms_stopped_at)
    VALUES (${wsId}, 'Sam Stopped', ${em('sam')}, '+15555550188', 'active', NULL, NOW() - INTERVAL '3 days') RETURNING id`).rows[0].id;
  r = await call({ method: 'POST', query: { slug: SLUG }, body: {
    serviceId: svc, date: day, startMin: 960, endMin: 1020, clientName: 'Sam Stopped', clientEmail: em('sam'),
    clientPhone: '+15555550188', smsConsent: true,
  } });
  row = (await sql`SELECT sms_consent_at, sms_stopped_at FROM clients WHERE id = ${stopped}`).rows[0];
  assert(r.statusCode === 201, `booking still goes through for a STOPped client (${r.statusCode})`);
  assert(row.sms_consent_at === null && row.sms_stopped_at !== null, 'STOP stays in force: no SMS consent re-stamped by the public form');
}

async function cleanup() {
  try {
    if (wsId) await sql`DELETE FROM workspaces WHERE id = ${wsId}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
  } catch (e) { console.error('cleanup:', e.message); }
}

run()
  .catch((e) => { fail++; console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

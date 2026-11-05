// Appointment reminders: business default, per service, per client, the
// client's own opt-out, and the owner's own reminders (api/_lib/
// reminderSettings.js, api/calendar/reminders.js, api/cron/booking-reminders.js).
//
//   [1] resolution precedence in JS and the cron's SQL agree:
//       client > service > business, business off and the client's own
//       portal opt-out always win
//   [2] untouched businesses get 1 day / 8 hours / 1 hour; legacy services
//       holding the old built-in set follow the default, custom arrays are
//       kept; the services PUT keeps old app versions (no flag) working
//   [3] settings API: validation, caps, owner only, workspace isolation
//   [4] per-client override via PATCH /api/clients/:id, isolated
//   [5] portal switch turns every reminder channel off for that business
//   [6] cron: each beat once; owner reminders go to the owner only and are
//       independent of client settings; helper bookings remind the helper
//   [7] SMS: consent required, STOP respected
//   [8] no flood: schedule changes, late bookings, several beats due at once
//   [9] cadence: 1 hour and 30 minute beats fire once, at the right time,
//       with the real 10 minute cron schedule (vercel.json)
//
// Run: node --import ./tests/bootstrap.mjs ./tests/appointment-reminders.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_reminders_test';
process.env.IVY_TWILIO_AUTH_TOKEN = 'reminders_test_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import fs from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  resolveClientSchedule, clientRemindersFrom, describeSchedule, serviceFollowsDefault,
  clientBeatsSql, ownerBeatsSql, CLIENT_DEFAULT_MINUTES, OWNER_DEFAULT_MINUTES,
} from '../api/_lib/reminderSettings.js';
import { fetchDueBookings, remindBooking, pickDueBeat, LOOKAHEAD_MIN, LOOKBACK_MIN, describeLeft } from '../api/cron/booking-reminders.js';
import remindersApi from '../api/calendar/reminders.js';
import servicesApi from '../api/calendar/services.js';
import calendarApi from '../api/calendar/index.js';
import clientApi from '../api/clients/[id].js';
import portalPrefs from '../api/me/notifications-clients.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Capture outbound email (Resend) and texts (Twilio).
const mails = [];
const texts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('resend.com')) {
    mails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.twilio.com')) {
    texts.push(Object.fromEntries(new URLSearchParams(String(init.body || ''))));
    return new Response(JSON.stringify({ sid: 'SM_test', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const to = (m) => (Array.isArray(m.to) ? m.to : [m.to]).map((x) => String(x).toLowerCase());
const mailsTo = (addr) => mails.filter((m) => to(m).includes(addr.toLowerCase()));

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = (b) => { if (b !== undefined) r.body = b; return r; };
  return r;
};
let ipN = 0;
const call = async (handler, { method = 'GET', body, query = {}, cookie, headers = {} }) => {
  const res = mkRes();
  await handler({
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      cookie, 'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 20}`, ...headers,
    },
  }, res);
  return res;
};

const created = { users: [] };
async function mkOwner(name) {
  const email = `rem-${name}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${name}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0];
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, ${name + ' Studio'}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0];
  await sql`INSERT INTO calendar_settings (workspace_id, slug, biz_name, timezone)
            VALUES (${w.id}, ${`rem-${name}-${S}`.toLowerCase()}, ${name + ' Studio'}, 'UTC')
            ON CONFLICT (workspace_id) DO UPDATE SET biz_name = EXCLUDED.biz_name, timezone = 'UTC'`;
  created.users.push(u.id);
  return { id: u.id, email, ws: w.id, cookie: `ivy_session=${signSession(u.id)}` };
}
async function mkClient(ws, name, extra = {}) {
  const email = extra.email === undefined ? `rem-c-${name}-${S}@example.com` : extra.email;
  return (await sql`INSERT INTO clients (workspace_id, name, email, stage, phone, sms_consent_at, sms_stopped_at, user_id, reminder_settings, notification_prefs)
    VALUES (${ws}, ${name}, ${email}, 'active', ${extra.phone || null}, ${extra.smsConsentAt || null}, ${extra.smsStoppedAt || null},
            ${extra.userId || null}, ${extra.reminderSettings ? JSON.stringify(extra.reminderSettings) : null}::jsonb,
            ${JSON.stringify(extra.prefs || {})}::jsonb)
    RETURNING id, email`).rows[0];
}
async function mkService(ws, name, minutes, useDefault = null) {
  return (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, reminder_minutes, reminders_use_default)
    VALUES (${ws}, ${name}, 60, 1, ${minutes}::int[], ${useDefault}) RETURNING *`).rows[0];
}
// A booking starting `minsFromNow` minutes from now (whole minute, UTC).
async function mkBooking({ ws, client = null, serviceId = null, minsFromNow, staffId = null, createdMinsAgo = 0, name = 'Client' }) {
  const startMs = Math.floor((Date.now() + minsFromNow * 60000) / 60000) * 60000;
  const d = new Date(startMs);
  const date = d.toISOString().slice(0, 10);
  const startMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const id = (await sql.query(
    `INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, client_phone, date, start_min, end_min, staff_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() - make_interval(mins => $11))
     RETURNING id`,
    [ws, serviceId, client?.id || null, name, client?.email || '', client?.phone || null, date, startMin, Math.min(1439, startMin + 60), staffId, createdMinsAgo],
  )).rows[0].id;
  return { id, startMs };
}
const BOOKING_COLS = 'reminders_sent, sms_sent, push_sent, owner_reminders_sent';
async function rowFor(bookingId) {
  // The cron's candidate row for one booking, built with the cron's own SQL
  // (the time prefilter is left out so tests can move the clock).
  const { rows } = await sql.query(`
    SELECT b.id, b.workspace_id, b.client_id, b.client_email, b.client_name,
      COALESCE(b.client_phone, c.phone) AS client_phone, c.sms_consent_at, c.user_id AS client_user_id,
      b.date, b.start_min, b.end_min, b.notes, b.staff_id, b.created_at, ${BOOKING_COLS.split(', ').map((x) => 'b.' + x).join(', ')},
      s.name AS service_name, s.prep_instructions,
      cs.biz_name, cs.timezone, cs.client_reminders, cs.owner_reminders,
      ou.id AS owner_user_id, ou.email AS owner_email, hu.id AS helper_user_id,
      rb.client_beats, rb.owner_beats
    FROM bookings b
    JOIN workspaces w ON w.id = b.workspace_id
    LEFT JOIN users ou ON ou.id = w.owner_id AND ou.deleted_at IS NULL
    LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
    LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
    LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
    LEFT JOIN staff_members sm ON sm.id = b.staff_id AND sm.workspace_id = b.workspace_id
          AND sm.active = TRUE AND sm.user_id IS NOT NULL AND sm.user_id <> w.owner_id
    LEFT JOIN users hu ON hu.id = sm.user_id AND hu.deleted_at IS NULL
    CROSS JOIN LATERAL (SELECT ${clientBeatsSql()} AS client_beats, ${ownerBeatsSql()} AS owner_beats) rb
    WHERE b.id = $1`, [bookingId]);
  return rows[0];
}
const sorted = (a) => [...(a || [])].map(Number).sort((x, y) => y - x);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
// Run the cron's per-row work for our own rows only (the real cron walks
// every workspace in the shared test database).
async function tick(bookingIds, now = Date.now()) {
  let sent = 0;
  for (const id of bookingIds) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rowFor(id);
    // eslint-disable-next-line no-await-in-loop
    const out = await remindBooking(r, { now });
    sent += out.sent;
  }
  return sent;
}
const stamps = async (id) => (await sql.query(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1`, [id])).rows[0];

async function main() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const B = await mkOwner('beta');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[1] precedence: client > service > business; business off and portal opt-out win');
  const biz = clientRemindersFrom(null);
  assert(same(biz.minutes, [1440, 480, 60]) && biz.enabled, 'no settings = on, 1 day / 8 hours / 1 hour');
  const legacySvc = { reminder_minutes: [10080, 2880, 1440, 120], reminders_use_default: null };
  const customSvc = { reminder_minutes: [2880, 120], reminders_use_default: null };
  const emptySvc  = { reminder_minutes: [], reminders_use_default: null };
  const flagSvc   = { reminder_minutes: [2880, 120], reminders_use_default: true };
  assert(resolveClientSchedule({ business: biz, service: legacySvc }).source === 'business', 'old built-in service set follows the business default');
  assert(same(resolveClientSchedule({ business: biz, service: customSvc }).minutes, [2880, 120]), 'custom service array is kept');
  assert(resolveClientSchedule({ business: biz, service: emptySvc }).minutes.length === 0, 'a service the owner emptied stays without reminders');
  assert(resolveClientSchedule({ business: biz, service: flagSvc }).source === 'business', 'explicit "use my business default" wins over the stored array');
  const custClient = { reminder_settings: { mode: 'custom', minutes: [60] }, notification_prefs: {} };
  assert(same(resolveClientSchedule({ business: biz, service: customSvc, client: custClient }).minutes, [60]), 'client custom beats the service');
  assert(resolveClientSchedule({ business: biz, service: customSvc, client: { reminder_settings: { mode: 'off' } } }).source === 'client-off', 'client off beats the service');
  assert(resolveClientSchedule({ business: biz, client: { reminder_settings: { mode: 'custom', minutes: [60] }, notification_prefs: { reminders: false } } }).source === 'client-opted-out', 'client portal opt-out beats the owner custom schedule');
  assert(resolveClientSchedule({ business: { ...biz, enabled: false }, client: custClient }).minutes.length === 0, 'business off means no client reminders at all');
  assert(describeSchedule([60, 1440, 480]) === '1 day, 8 hours and 1 hour before', 'preview reads "1 day, 8 hours and 1 hour before"');

  // The same matrix through the cron's SQL.
  const matrix = [
    { svc: null, client: {}, biz: null, want: [1440, 480, 60] },
    { svc: [[10080, 2880, 1440, 120], null], client: {}, biz: null, want: [1440, 480, 60] },
    { svc: [[2880, 120], null], client: {}, biz: null, want: [2880, 120] },
    { svc: [[2880, 120], true], client: {}, biz: { minutes: [1440, 120] }, want: [1440, 120] },
    { svc: [[2880, 120], false], client: { reminderSettings: { mode: 'custom', minutes: [60, 30] } }, biz: null, want: [60, 30] },
    { svc: [[2880, 120], false], client: { reminderSettings: { mode: 'off' } }, biz: null, want: [] },
    { svc: null, client: { prefs: { reminders: false } }, biz: null, want: [] },
    { svc: [[2880, 120], false], client: {}, biz: { enabled: false, minutes: [1440] }, want: [] },
  ];
  let agree = true;
  for (const [i, m] of matrix.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await sql`UPDATE calendar_settings SET client_reminders = ${m.biz ? JSON.stringify(m.biz) : null}::jsonb WHERE workspace_id = ${A.ws}`;
    // eslint-disable-next-line no-await-in-loop
    const svc = m.svc ? await mkService(A.ws, `M${i}`, m.svc[0], m.svc[1]) : null;
    // eslint-disable-next-line no-await-in-loop
    const cl = await mkClient(A.ws, `m${i}`, m.client);
    // eslint-disable-next-line no-await-in-loop
    const b = await mkBooking({ ws: A.ws, client: cl, serviceId: svc?.id, minsFromNow: 3000 });
    // eslint-disable-next-line no-await-in-loop
    const row = await rowFor(b.id);
    // eslint-disable-next-line no-await-in-loop
    const crow = (await sql`SELECT * FROM clients WHERE id = ${cl.id}`).rows[0];
    const js = resolveClientSchedule({ business: clientRemindersFrom(m.biz), service: svc, client: crow }).minutes;
    if (!same(row.client_beats, m.want) || !same(js, m.want)) {
      agree = false;
      console.log('    mismatch', i, row.client_beats, js, m.want);
    }
  }
  assert(agree, `SQL and JS resolve all ${matrix.length} cases the same, as expected`);
  await sql`UPDATE calendar_settings SET client_reminders = NULL WHERE workspace_id = ${A.ws}`;

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[2] untouched businesses + services: defaults, legacy arrays, old app compat');
  let res = await call(remindersApi, { cookie: A.cookie });
  assert(res.statusCode === 200 && same(res.body.clients.minutes, CLIENT_DEFAULT_MINUTES) && res.body.clients.enabled === true,
    'GET: untouched business sends clients 1 day / 8 hours / 1 hour');
  assert(same(res.body.owner.minutes, OWNER_DEFAULT_MINUTES) && res.body.owner.enabled && res.body.owner.channels.email && res.body.owner.channels.push,
    'GET: owner reminders default on, 1 day and 1 hour, email and app');
  const ws2 = await mkOwner('svc');
  const sLegacy = await mkService(ws2.ws, 'Legacy', [10080, 2880, 1440, 120]);
  const sCustom = await mkService(ws2.ws, 'Custom', [2880, 120]);
  res = await call(calendarApi, { cookie: ws2.cookie });
  const svcs = res.body?.calendar?.services || [];
  const gLegacy = svcs.find((s) => s.id === sLegacy.id);
  const gCustom = svcs.find((s) => s.id === sCustom.id);
  assert(gLegacy?.reminderUseDefault === true && same(gLegacy.reminderMinutes, [1440, 480, 60]),
    'calendar GET: legacy service reports the business default (old apps show what clients really get)');
  assert(gCustom?.reminderUseDefault === false && same(gCustom.reminderMinutes, [2880, 120]), 'calendar GET: custom service keeps its array');
  // Old app (no reminderUseDefault) saves back what it was served.
  const oldAppBody = { services: svcs.map((s) => ({ id: s.id, name: s.name, durationMinutes: 60, price: 0, reminderMinutes: s.reminderMinutes })) };
  res = await call(servicesApi, { method: 'PUT', cookie: ws2.cookie, body: oldAppBody });
  const after = (await sql`SELECT id, reminders_use_default, reminder_minutes FROM services WHERE workspace_id = ${ws2.ws}`).rows;
  assert(res.statusCode === 200 && after.find((s) => s.id === sLegacy.id)?.reminders_use_default === true,
    'old app save: the default-following service keeps following the default');
  assert(after.find((s) => s.id === sCustom.id)?.reminders_use_default === false
    && same(after.find((s) => s.id === sCustom.id)?.reminder_minutes, [2880, 120]), 'old app save: custom service stays custom');
  // Old app changes a default service's reminders → it becomes custom.
  res = await call(servicesApi, { method: 'PUT', cookie: ws2.cookie, body: { services: [
    { id: sLegacy.id, name: 'Legacy', durationMinutes: 60, price: 0, reminderMinutes: [60] },
    { id: sCustom.id, name: 'Custom', durationMinutes: 60, price: 0, reminderMinutes: [2880, 120] },
    { name: 'Brand new from old app', durationMinutes: 30, price: 0, reminderMinutes: [10080, 2880, 1440, 120] },
  ] } });
  const after2 = (await sql`SELECT name, reminders_use_default, reminder_minutes FROM services WHERE workspace_id = ${ws2.ws}`).rows;
  assert(after2.find((s) => s.name === 'Legacy')?.reminders_use_default === false, 'old app edit of the schedule makes it the service\'s own');
  assert(after2.find((s) => s.name === 'Brand new from old app')?.reminders_use_default === true, 'new service from an old app follows the default');
  // New app: explicit flag.
  const legacyId = sLegacy.id;
  res = await call(servicesApi, { method: 'PUT', cookie: ws2.cookie, body: { services: [
    { id: legacyId, name: 'Legacy', durationMinutes: 60, price: 0, reminderMinutes: [60], reminderUseDefault: true },
  ] } });
  assert(res.body?.services?.[0]?.reminderUseDefault === true && same(res.body.services[0].reminderMinutes, [1440, 480, 60]),
    'new app: "Use my business default" saves and reports the default');
  assert(serviceFollowsDefault({ reminder_minutes: null }), 'a service row with no array follows the default');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[3] settings API: validation, caps, owner only, isolation');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { clients: { minutes: [45] } } });
  assert(res.statusCode === 400, 'a time that is not one of the choices is refused');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { clients: { minutes: [10080, 4320, 2880, 1440, 720, 480, 240] } } });
  assert(res.statusCode === 400, 'more than 6 reminders is refused');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { clients: { minutes: [] } } });
  assert(res.statusCode === 400, 'an empty schedule is refused (turn it off instead)');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { clients: 'nope' } });
  assert(res.statusCode === 400, 'a malformed body is refused');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { clients: { minutes: [1440, 120], channels: { sms: false } } } });
  assert(res.statusCode === 200 && same(res.body.clients.minutes, [1440, 120]) && res.body.clients.channels.sms === false && res.body.clients.channels.email === true,
    'PATCH saves the clients block (partial channels merge)');
  assert(same(res.body.owner.minutes, OWNER_DEFAULT_MINUTES), 'saving the clients block leaves the owner block alone');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { owner: { enabled: false } } });
  assert(res.statusCode === 200 && res.body.owner.enabled === false && same(res.body.clients.minutes, [1440, 120]), 'owner block saves without touching the clients block');
  res = await call(remindersApi, { cookie: B.cookie });
  assert(same(res.body.clients.minutes, CLIENT_DEFAULT_MINUTES) && res.body.owner.enabled === true, 'another business is unaffected');
  res = await call(remindersApi, { method: 'PATCH', body: { owner: { enabled: false } }, cookie: undefined });
  assert(res.statusCode === 401, 'signed out: refused');
  res = await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { owner: { enabled: true } }, headers: { origin: 'https://evil.example' } });
  assert(res.statusCode === 403, 'cross-site PATCH refused');
  await sql`UPDATE calendar_settings SET client_reminders = NULL, owner_reminders = NULL WHERE workspace_id = ${A.ws}`;

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[4] per-client override via the client drawer');
  const cA = await mkClient(A.ws, 'drawer');
  const cB = await mkClient(B.ws, 'other');
  res = await call(clientApi, { method: 'PATCH', cookie: A.cookie, query: { id: cA.id }, body: { reminderSettings: { mode: 'custom', minutes: [1440, 60] } } });
  assert(res.statusCode === 200 && res.body.client.reminderSettings.mode === 'custom' && same(res.body.client.reminderSettings.minutes, [1440, 60]),
    'owner sets a custom schedule for one client');
  res = await call(clientApi, { method: 'PATCH', cookie: A.cookie, query: { id: cA.id }, body: { reminderSettings: { mode: 'custom', minutes: [17] } } });
  assert(res.statusCode === 400, 'invalid client schedule refused');
  res = await call(clientApi, { method: 'PATCH', cookie: A.cookie, query: { id: cA.id }, body: { reminderSettings: { mode: 'off' } } });
  assert(res.body?.client?.reminderSettings?.mode === 'off', 'owner turns reminders off for one client');
  res = await call(clientApi, { method: 'PATCH', cookie: A.cookie, query: { id: cA.id }, body: { reminderSettings: { mode: 'default' } } });
  assert(res.body?.client?.reminderSettings?.mode === 'default'
    && (await sql`SELECT reminder_settings FROM clients WHERE id = ${cA.id}`).rows[0].reminder_settings === null, 'back to the business default clears the override');
  res = await call(clientApi, { method: 'PATCH', cookie: A.cookie, query: { id: cB.id }, body: { reminderSettings: { mode: 'off' } } });
  assert(res.statusCode === 404 && (await sql`SELECT reminder_settings FROM clients WHERE id = ${cB.id}`).rows[0].reminder_settings === null,
    'another business\'s client cannot be changed');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[5] the client\'s own portal switch');
  const portalEmail = `rem-portal-${S}@example.com`;
  const pu = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${portalEmail}, 'x', 'Paz', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  created.users.push(pu);
  const pc = await mkClient(A.ws, 'paz', { email: portalEmail, userId: pu, reminderSettings: { mode: 'custom', minutes: [60] } });
  const pCookie = `ivy_session=${signSession(pu)}`;
  res = await call(portalPrefs, { cookie: pCookie });
  assert(res.statusCode === 200 && res.body.memberships.find((m) => m.clientId === pc.id)?.reminders === true, 'portal shows reminders on by default');
  res = await call(portalPrefs, { method: 'PATCH', cookie: pCookie, body: { clientId: pc.id, reminders: false } });
  assert(res.statusCode === 200 && res.body.reminders === false, 'client turns reminders off for that business');
  res = await call(portalPrefs, { method: 'PATCH', cookie: pCookie, body: { clientId: cB.id, reminders: false } });
  assert(res.statusCode === 400, 'cannot change someone else\'s client row');
  const pb = await mkBooking({ ws: A.ws, client: pc, minsFromNow: 61 });
  mails.length = 0;
  await tick([pb.id]);
  assert(mailsTo(portalEmail).length === 0 && Object.keys((await stamps(pb.id)).push_sent).length === 0,
    'opted-out client gets nothing, even with the owner\'s custom schedule');
  assert(mailsTo(A.email).length === 1, '...while the owner still gets their own 1 hour reminder');
  res = await call(clientApi, { cookie: A.cookie, query: { id: pc.id } });
  assert(res.body?.client?.remindersOptedOut === true, 'the owner drawer sees the client opted out');
  await call(portalPrefs, { method: 'PATCH', cookie: pCookie, body: { clientId: pc.id, reminders: true } });
  assert((await sql`SELECT notification_prefs->>'reminders' AS r FROM clients WHERE id = ${pc.id}`).rows[0].r === 'true', 'client can turn them back on');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[6] cron: each beat once, owner reminders separate, helpers');
  const c1 = await mkClient(A.ws, 'jo');
  const b1 = await mkBooking({ ws: A.ws, client: c1, minsFromNow: 62, createdMinsAgo: 2000, name: 'Jo Client' });
  const due = (await fetchDueBookings(null)).rows.some((r) => r.id === b1.id);
  assert(due, 'the real candidate query picks up a booking 62 minutes out (1 hour beat)');
  mails.length = 0;
  await tick([b1.id]);
  const jm = mailsTo(c1.email);
  assert(jm.length === 1 && /in 1 hour/.test(jm[0].subject), `client gets one "in 1 hour" reminder (${jm[0]?.subject})`);
  const om = mailsTo(A.email);
  assert(om.length === 1 && /Coming up in 1 hour/.test(om[0].subject) && /Jo Client/.test(om[0].subject), `owner gets their own reminder (${om[0]?.subject})`);
  assert(!/Coming up/.test(jm[0]?.subject || '') && !to(om[0] || { to: [] }).includes(c1.email), 'owner reminder goes to the owner only');
  await tick([b1.id]);
  await tick([b1.id], Date.now() + 5 * 60000);
  assert(mailsTo(c1.email).length === 1 && mailsTo(A.email).length === 1, 'later ticks send nothing again');
  const st = await stamps(b1.id);
  assert(!!st.reminders_sent['60'] && !!st.owner_reminders_sent['60'], 'beats are stamped in reminders_sent and owner_reminders_sent');
  const bell = (await sql`SELECT 1 FROM notifications WHERE user_id = ${A.id} AND tag = ${`owner-reminder-${b1.id}-60`}`).rows;
  assert(bell.length === 1, 'owner also gets the bell / app notification');

  // Owner off → client unaffected; client off → owner unaffected.
  await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { owner: { enabled: false } } });
  const c2 = await mkClient(A.ws, 'kim');
  const b2 = await mkBooking({ ws: A.ws, client: c2, minsFromNow: 62, createdMinsAgo: 2000, name: 'Kim' });
  mails.length = 0;
  await tick([b2.id]);
  assert(mailsTo(c2.email).length === 1 && mailsTo(A.email).length === 0, 'owner reminders off: client still reminded, owner not');
  await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { owner: { enabled: true, channels: { email: true, push: false } }, clients: { enabled: false } } });
  const c3 = await mkClient(A.ws, 'lee');
  const b3 = await mkBooking({ ws: A.ws, client: c3, minsFromNow: 62, createdMinsAgo: 2000, name: 'Lee' });
  mails.length = 0;
  await tick([b3.id]);
  assert(mailsTo(c3.email).length === 0 && mailsTo(A.email).length === 1, 'client reminders off: owner still reminded, client not');
  assert((await sql`SELECT 1 FROM notifications WHERE user_id = ${A.id} AND tag = ${`owner-reminder-${b3.id}-60`}`).rows.length === 0,
    'owner chose email only: no app notification');
  await sql`UPDATE calendar_settings SET client_reminders = NULL, owner_reminders = NULL WHERE workspace_id = ${A.ws}`;

  // Owner's own email preference for booking emails is honoured.
  await sql`UPDATE users SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || '{"email_bookings": false}'::jsonb WHERE id = ${A.id}`;
  const c4 = await mkClient(A.ws, 'max');
  const b4 = await mkBooking({ ws: A.ws, client: c4, minsFromNow: 62, createdMinsAgo: 2000 });
  mails.length = 0;
  await tick([b4.id]);
  assert(mailsTo(A.email).length === 0 && mailsTo(c4.email).length === 1, 'owner who muted booking emails gets no reminder email');
  await sql`UPDATE users SET notification_prefs = notification_prefs - 'email_bookings' WHERE id = ${A.id}`;

  // Booking with no service and no client row: business default applies.
  const loose = await mkBooking({ ws: A.ws, minsFromNow: 62, createdMinsAgo: 2000, name: 'Walk In' });
  await sql`UPDATE bookings SET client_email = ${`rem-walkin-${S}@example.com`} WHERE id = ${loose.id}`;
  mails.length = 0;
  await tick([loose.id]);
  assert(mailsTo(`rem-walkin-${S}@example.com`).length === 1, 'booking with no service still gets the business default reminder');

  // Helper assigned: the helper is reminded, not the owner.
  const hEmail = `rem-helper-${S}@example.com`;
  const hu = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${hEmail}, 'x', 'Hana', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  created.users.push(hu);
  const staff = (await sql`INSERT INTO staff_members (workspace_id, user_id, name, active) VALUES (${A.ws}, ${hu}, 'Hana', TRUE) RETURNING id`).rows[0].id;
  const c5 = await mkClient(A.ws, 'ola');
  const b5 = await mkBooking({ ws: A.ws, client: c5, minsFromNow: 62, createdMinsAgo: 2000, staffId: staff, name: 'Ola' });
  mails.length = 0;
  await tick([b5.id]);
  const hb = (await sql`SELECT 1 FROM notifications WHERE user_id = ${hu} AND tag = ${`helper-reminder-${b5.id}-60`}`).rows;
  assert(hb.length === 1 && mailsTo(A.email).length === 0 && mailsTo(c5.email).length === 1, 'helper booking: helper reminded, owner not, client still reminded');

  // Workspace isolation in the cron: B's settings do not leak into A.
  await call(remindersApi, { method: 'PATCH', cookie: B.cookie, body: { clients: { enabled: false } } });
  const c6 = await mkClient(A.ws, 'pia');
  const b6 = await mkBooking({ ws: A.ws, client: c6, minsFromNow: 62, createdMinsAgo: 2000 });
  const c7 = await mkClient(B.ws, 'quin');
  const b7 = await mkBooking({ ws: B.ws, client: c7, minsFromNow: 62, createdMinsAgo: 2000 });
  mails.length = 0;
  await tick([b6.id, b7.id]);
  assert(mailsTo(c6.email).length === 1 && mailsTo(c7.email).length === 0 && mailsTo(B.email).length === 1,
    'B turned client reminders off: A\'s client is still reminded, B\'s is not, B\'s owner is');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[7] texts: consent required, STOP respected');
  const okPhone = '+15125550101';
  const stopPhone = '+15125550102';
  const cs1 = await mkClient(A.ws, 'tex', { phone: okPhone, smsConsentAt: new Date().toISOString() });
  const cs2 = await mkClient(A.ws, 'stop', { phone: stopPhone, smsStoppedAt: new Date().toISOString() });
  const cs3 = await mkClient(A.ws, 'never', { phone: '+15125550103' });
  const tb1 = await mkBooking({ ws: A.ws, client: { ...cs1, phone: okPhone }, minsFromNow: 62, createdMinsAgo: 2000 });
  const tb2 = await mkBooking({ ws: A.ws, client: { ...cs2, phone: stopPhone }, minsFromNow: 62, createdMinsAgo: 2000 });
  const tb3 = await mkBooking({ ws: A.ws, client: { ...cs3, phone: '+15125550103' }, minsFromNow: 62, createdMinsAgo: 2000 });
  texts.length = 0;
  await tick([tb1.id, tb2.id, tb3.id]);
  assert(texts.filter((t) => t.To === okPhone).length === 1, 'client who said yes to texts gets one text');
  assert(texts.filter((t) => t.To === stopPhone).length === 0, 'client who texted STOP gets no text');
  assert(texts.filter((t) => t.To === '+15125550103').length === 0, 'client who never agreed gets no text');
  assert(/Reply STOP/i.test(texts.find((t) => t.To === okPhone)?.Body || ''), 'text carries the STOP line');
  await call(remindersApi, { method: 'PATCH', cookie: A.cookie, body: { clients: { channels: { sms: false } } } });
  const tb4 = await mkBooking({ ws: A.ws, client: { ...cs1, phone: okPhone }, minsFromNow: 62, createdMinsAgo: 2000 });
  texts.length = 0;
  await tick([tb4.id]);
  assert(texts.length === 0, 'business turned texts off: no text');
  await sql`UPDATE calendar_settings SET client_reminders = NULL WHERE workspace_id = ${A.ws}`;

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[8] no flood');
  // Booking 7 hours out made long ago under a 1-day schedule; the business
  // then adds 8 hours (already 1 hour past) and 1 hour.
  const cf = await mkClient(A.ws, 'flood');
  const fb = await mkBooking({ ws: A.ws, client: cf, minsFromNow: 7 * 60, createdMinsAgo: 5000 });
  mails.length = 0;
  await tick([fb.id]);
  assert(mailsTo(cf.email).length === 0, 'schedule change: the 1 day and 8 hour beats already passed are not sent');
  await tick([fb.id], fb.startMs - 62 * 60000);
  assert(mailsTo(cf.email).length === 1, '...and the 1 hour beat still goes out on time');
  // Late booking: made 50 minutes before the start, 1 hour beat already passed.
  const cl = await mkClient(A.ws, 'late');
  const lb = await mkBooking({ ws: A.ws, client: cl, minsFromNow: 50, createdMinsAgo: 0 });
  mails.length = 0;
  await tick([lb.id]);
  assert(mailsTo(cl.email).length === 0, 'booked after the 1 hour mark: no instant "1 hour" reminder');
  // Two beats due at once (a service with its own 45 and 30 minute beats,
  // 33 minutes out): only the nearer one goes, the other is marked skipped.
  const cm = await mkClient(A.ws, 'multi');
  const svcMulti = await mkService(A.ws, 'Multi', [45, 30], false);
  const mb = await mkBooking({ ws: A.ws, client: cm, serviceId: svcMulti.id, minsFromNow: 33, createdMinsAgo: 3000 });
  mails.length = 0;
  await tick([mb.id]);
  await tick([mb.id], Date.now() + 2 * 60000);
  const ms = await stamps(mb.id);
  assert(mailsTo(cm.email).length === 1 && ms.reminders_sent['45'] === 'skipped' && !!ms.reminders_sent['30'] && ms.reminders_sent['30'] !== 'skipped',
    'two beats due at once: one reminder, the older beat marked skipped');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[9] cadence: real 10 minute schedule');
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const cron = vercel.crons.find((c) => c.path === '/api/cron/booking-reminders');
  assert(cron?.schedule === '*/10 * * * *', 'vercel.json runs the reminders cron every 10 minutes');
  const CADENCE = 10;
  let cadenceOk = true;
  for (const beat of [30, 60, 120, 480, 1440, 10080]) {
    for (let phase = 0; phase < CADENCE; phase++) {
      const start = 1_800_000_000_000 + phase * 60000;
      let fires = 0; let firedAt = null;
      const sent = new Set();
      for (let t = start - (beat + 120) * 60000; t < start; t += CADENCE * 60000) {
        const { send } = pickDueBeat([beat], start, t, start - 30 * 86400000);
        if (send != null && !sent.has(send)) { sent.add(send); fires++; firedAt = (start - t) / 60000; }
      }
      if (fires !== 1 || firedAt > beat + LOOKAHEAD_MIN || firedAt < beat - CADENCE) {
        cadenceOk = false; console.log('    bad', beat, phase, fires, firedAt);
      }
    }
  }
  assert(cadenceOk, `every beat (30 min to 1 week) fires exactly once, between ${LOOKAHEAD_MIN} min early and ${CADENCE} min late, at every phase`);
  assert(LOOKBACK_MIN > CADENCE * 2, 'lookback covers a missed tick');
  // Integration: walk a real booking through 10 minute ticks.
  const cc = await mkClient(A.ws, 'cad', { reminderSettings: { mode: 'custom', minutes: [60, 30] } });
  const cb = await mkBooking({ ws: A.ws, client: cc, minsFromNow: 70, createdMinsAgo: 3000 });
  mails.length = 0;
  const log = [];
  for (let t = Date.now(); t < cb.startMs; t += CADENCE * 60000) {
    const before = mailsTo(cc.email).length;
    // eslint-disable-next-line no-await-in-loop
    await tick([cb.id], t);
    if (mailsTo(cc.email).length > before) log.push(Math.round((cb.startMs - t) / 60000));
  }
  assert(log.length === 2 && log[0] <= 65 && log[0] >= 55 && log[1] <= 35 && log[1] >= 25,
    `1 hour and 30 minute reminders each sent once on time (sent at ${log.join(' and ')} minutes before)`);
  const subj = mailsTo(cc.email).map((m) => m.subject);
  assert(/in 1 hour/.test(subj[0] || '') && /in (25|30|35) minutes/.test(subj[1] || ''), `wording matches the time left (${subj.join(' | ')})`);
  assert(describeLeft(485) === 'in 8 hours' && describeLeft(1445) === 'in 1 day' && describeLeft(10085) === 'in 1 week', 'wording for 8 hours, 1 day, 1 week');

  // ── cleanup ─────────────────────────────────────────────────────────
  for (const id of created.users) {
    // eslint-disable-next-line no-await-in-loop
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

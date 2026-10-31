// Add-to-calendar in one tap.
//   [1] buildBookingInvite emits a parseable REQUEST invitation: ORGANIZER is
//       the business, ATTENDEE the client, UID stable across re-sends,
//       SEQUENCE rises on reschedule, times absolute in the workspace tz,
//       LOCATION carries the video link.
//   [2] buildGoogleCalendarUrl lands the same instant.
//   [3] /api/calendar/invite serves the .ics for a signed link and 404s a
//       forged one.
//   [4] /api/me/bookings exposes { calendar: { google, ics } } for upcoming
//       bookings.
//   [5] Confirmation + owner-reschedule emails to the client carry the
//       booking.ics attachment and both visible links.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/add-to-calendar.test.mjs
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { buildBookingInvite, buildGoogleCalendarUrl } from '../api/_lib/ical.js';
import { calendarLinksFor, signInvite } from '../api/_lib/calendarLinks.js';
import inviteHandler from '../api/calendar/invite.js';
import meBookingsHandler from '../api/me/bookings.js';
import { notifyNewBooking, notifyBookingRescheduled } from '../api/_lib/bookingNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Resend capture: every outbound email body (JSON) is recorded.
const sentEmails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.resend\.com/.test(u)) {
    try { sentEmails.push(JSON.parse(init.body)); } catch { sentEmails.push({ raw: init.body }); }
    return new Response(JSON.stringify({ id: `em_${sentEmails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

// Minimal RFC 5545 reader: unfold continuation lines, map NAME(;params) → value.
function parseIcs(ics) {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const out = {};
  for (const line of unfolded.split('\r\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).split(';')[0];
    out[key] = out[key] ? [].concat(out[key], line.slice(i + 1)) : line.slice(i + 1);
    out[`${key}__full`] = line;
  }
  return out;
}

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const baseHeaders = { origin: 'https://www.joinivy.ai', host: 'www.joinivy.ai', 'user-agent': 'test', 'x-forwarded-for': '198.18.1.1' };

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] single-event invite parses with the fields calendar apps need');
  const base = {
    bizName: 'Bright & Co.', serviceName: 'Deep Tissue Massage',
    date: '2026-08-14', startMin: 9 * 60 + 30, endMin: 10 * 60 + 30,
    bookingId: '11111111-2222-4333-8444-555555555555', timezone: 'America/New_York',
    locationAddress: 'https://meet.example.com/room-1',
    organizerEmail: 'owner@bright.example', attendeeEmail: 'client@example.com', attendeeName: 'Casey Client',
    sequence: 0,
  };
  const ics = buildBookingInvite(base);
  const ev = parseIcs(ics);
  assert(ev.METHOD === 'REQUEST', 'METHOD:REQUEST');
  assert(ev.UID === '11111111-2222-4333-8444-555555555555@joinivy.ai', 'UID derives from the booking id');
  assert(ev.DTSTART === '20260814T133000Z' && ev.DTEND === '20260814T143000Z', 'DTSTART/DTEND are absolute UTC for the workspace timezone (09:30 EDT = 13:30Z)');
  assert(/^ORGANIZER;CN=Bright & Co\.:mailto:owner@bright\.example$/.test(ev.ORGANIZER__full), `ORGANIZER is the business (${ev.ORGANIZER__full})`);
  assert(/^ATTENDEE;CN=Casey Client;.*:mailto:client@example\.com$/.test(ev.ATTENDEE__full), 'ATTENDEE is the client');
  assert(ev.LOCATION === 'https://meet.example.com/room-1', 'LOCATION carries the video link');
  assert(ev.SEQUENCE === '0' && ev.STATUS === 'CONFIRMED', 'SEQUENCE 0 + STATUS CONFIRMED on first send');
  assert(ev.SUMMARY === 'Deep Tissue Massage with Bright & Co.', 'SUMMARY names service + business');
  const resched = parseIcs(buildBookingInvite({ ...base, date: '2026-08-15', sequence: 86400 }));
  assert(resched.UID === ev.UID, 'a reschedule keeps the SAME UID so the saved event is updated');
  assert(Number(resched.SEQUENCE) > Number(ev.SEQUENCE), 'reschedule carries a higher SEQUENCE');
  assert(resched.DTSTART === '20260815T133000Z', 'reschedule carries the new time');
  const noOrg = parseIcs(buildBookingInvite({ ...base, organizerEmail: null }));
  assert(/mailto:no-reply@joinivy\.ai$/.test(noOrg.ORGANIZER__full), 'ORGANIZER falls back to a no-reply mailbox when the owner has none');
  const cancel = parseIcs(buildBookingInvite({ ...base, method: 'CANCEL', status: 'CANCELLED' }));
  assert(cancel.METHOD === 'CANCEL' && cancel.STATUS === 'CANCELLED', 'cancel invite is METHOD:CANCEL + STATUS:CANCELLED');

  console.log('\n[2] Google Calendar deep link');
  const g = new URL(buildGoogleCalendarUrl(base));
  assert(g.hostname === 'calendar.google.com' && g.searchParams.get('action') === 'TEMPLATE', 'render?action=TEMPLATE');
  assert(g.searchParams.get('dates') === '20260814T133000Z/20260814T143000Z', 'dates match the .ics instants');
  assert(g.searchParams.get('ctz') === 'America/New_York', 'ctz carries the workspace timezone');
  assert(g.searchParams.get('location') === 'https://meet.example.com/room-1', 'location carries the video link');

  // ── DB fixtures ──
  const tag = `atc-${Date.now()}`;
  const ownerId = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${tag}-owner@example.com`}, 'x', 'Olive Owner', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${ownerId}, 'ATC', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${wid}, 'Calm Hands', ${`atc-${Date.now()}`}, 'America/Los_Angeles')`;
  const clientEmail = `${tag}-client@example.com`;
  const clientUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${clientEmail}, 'x', 'Casey Client', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const clientId = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${wid}, 'Casey Client', ${clientEmail}, 'active', ${clientUser}) RETURNING id`).rows[0].id;
  const serviceId = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, location_type, location_label)
    VALUES (${wid}, 'Massage', 60, 90, 'in_person', '12 Harbour St') RETURNING id`).rows[0].id;
  const future = new Date(Date.now() + 5 * 86400 * 1000).toISOString().slice(0, 10);
  const bookingId = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${wid}, ${serviceId}, ${clientId}, 'Casey Client', ${clientEmail}, ${future}, 600, 660) RETURNING id`).rows[0].id;

  console.log('\n[3] /api/calendar/invite serves the signed .ics and refuses a forged link');
  const row = (await sql`SELECT b.*, s.name AS service_name, s.location_type, s.location_label, cs.biz_name, cs.timezone
    FROM bookings b JOIN services s ON s.id = b.service_id JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
    WHERE b.id = ${bookingId}`).rows[0];
  const links = calendarLinksFor(row);
  const icsUrl = new URL(links.ics);
  assert(icsUrl.pathname === '/api/calendar/invite' && icsUrl.searchParams.get('b') === bookingId, 'ics link points at the invite endpoint for this booking');
  let res = mkRes();
  await inviteHandler({ method: 'GET', headers: baseHeaders, query: { b: bookingId, s: icsUrl.searchParams.get('s') } }, res);
  assert(res.statusCode === 200, `signed link → 200 (got ${res.statusCode})`);
  assert(/^text\/calendar; method=REQUEST/.test(res.headers['content-type'] || ''), 'text/calendar; method=REQUEST');
  const served = parseIcs(String(res.body || ''));
  assert(served.UID === `${bookingId}@joinivy.ai`, 'served UID matches the booking');
  assert(served.LOCATION === '12 Harbour St', 'served LOCATION is the in-person venue');
  assert(/CN=Calm Hands/.test(served.ORGANIZER__full || ''), 'served ORGANIZER is the business name');
  // 10:00 in Los Angeles is 17:00Z (PDT) or 18:00Z (PST) - either way absolute.
  assert(/Z$/.test(served.DTSTART || ''), 'served DTSTART is absolute (workspace timezone applied)');
  res = mkRes();
  await inviteHandler({ method: 'GET', headers: baseHeaders, query: { b: bookingId, s: signInvite(bookingId).replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) } }, res);
  assert(res.statusCode === 404, `forged signature → 404 (got ${res.statusCode})`);

  console.log('\n[4] /api/me/bookings exposes calendar links for upcoming bookings');
  res = mkRes();
  await meBookingsHandler({
    method: 'GET', url: '/me/bookings', query: {}, on() {},
    headers: { ...baseHeaders, cookie: `ivy_session=${signSession(clientUser)}` },
  }, res);
  assert(res.statusCode === 200, `/me/bookings → 200 (got ${res.statusCode})`);
  const item = (res.body?.upcoming || []).find((b) => b.id === bookingId);
  assert(!!item?.calendar?.google && !!item?.calendar?.ics, 'upcoming booking carries { calendar: { google, ics } }');
  assert(item?.calendar?.ics === links.ics, 'portal ics link is the same signed URL the email uses');

  console.log('\n[5] confirmation + reschedule emails carry the .ics attachment and both links');
  sentEmails.length = 0;
  await notifyNewBooking({ workspaceId: wid, bookingId, source: 'public' });
  const confirm = sentEmails.find((e) => (e.to || []).includes(clientEmail) && /Booking confirmed/.test(e.subject || ''));
  assert(!!confirm, 'client confirmation email was sent');
  const att = confirm?.attachments?.[0];
  assert(att?.filename === 'booking.ics' && /method=REQUEST/.test(att?.content_type || ''), 'confirmation carries booking.ics (method=REQUEST)');
  const attParsed = att ? parseIcs(Buffer.from(att.content, 'base64').toString('utf8')) : {};
  assert(attParsed.UID === `${bookingId}@joinivy.ai`, 'attached invite UID matches the booking');
  assert(/CN=Calm Hands/.test(attParsed.ORGANIZER__full || ''), 'attached invite ORGANIZER is the business');
  assert(/Add to Google Calendar/.test(confirm?.html || '') && /Add to Apple\/Outlook \(\.ics\)/.test(confirm?.html || ''), 'confirmation shows both add-to-calendar links');
  assert((confirm?.html || '').includes(links.google.replace(/&/g, '&amp;')), 'confirmation Google link is the same deep link the portal uses');

  sentEmails.length = 0;
  const newDate = new Date(Date.now() + 6 * 86400 * 1000).toISOString().slice(0, 10);
  await sql`UPDATE bookings SET date = ${newDate}, start_min = 720, end_min = 780, updated_at = NOW() + INTERVAL '1 second' WHERE id = ${bookingId}`;
  await notifyBookingRescheduled({ workspaceId: wid, bookingId, oldDateISO: future, oldStartMin: 600, oldEndMin: 660, source: 'owner' });
  const resch = sentEmails.find((e) => (e.to || []).includes(clientEmail) && /Rescheduled/.test(e.subject || ''));
  assert(!!resch, 'client reschedule email was sent');
  const rAtt = resch?.attachments?.[0];
  const rParsed = rAtt ? parseIcs(Buffer.from(rAtt.content, 'base64').toString('utf8')) : {};
  assert(rAtt?.filename === 'booking.ics', 'reschedule carries booking.ics');
  assert(rParsed.UID === attParsed.UID, 'reschedule invite reuses the confirmation UID');
  assert(Number(rParsed.SEQUENCE) > Number(attParsed.SEQUENCE || 0), `reschedule SEQUENCE (${rParsed.SEQUENCE}) is higher than the confirmation's (${attParsed.SEQUENCE})`);
  assert(rParsed.DTSTART !== attParsed.DTSTART, 'reschedule invite carries the new start');
  assert(/Add to Google Calendar/.test(resch?.html || ''), 'reschedule shows the add-to-calendar links');

  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id IN (${ownerId}, ${clientUser})`;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

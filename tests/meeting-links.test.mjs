// Virtual service meeting links: only https links are saved, and links saved
// before that rule are cleaned up once by the schema migration.
//
//   [1] cleanMeetingLink: https accepted; http, javascript:, data:, a link
//       with a login in it and plain text refused with the plain message.
//   [2] the one-off clean-up in SCHEMA_SQL: http:// becomes https://, any
//       other bad link is removed from the service and kept word for word in
//       meeting_link_removed; booking copies follow; reruns change nothing;
//       in-person addresses are untouched.
//   [3] PUT /api/calendar/services refuses a bad link with the plain message
//       and saves an https one; the removed link shows on the owner's
//       Services screen (never on the public page), stays through an old
//       app's save, and clears on a new link or Dismiss.
//   [4] a booking never copies a bad link from its service.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/meeting-links.test.mjs
import { ensureSchemaApplied, splitStatements } from '../api/_lib/ensureSchema.js';
import { SCHEMA_SQL } from '../api/_lib/schema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { cleanMeetingLink, MEETING_LINK_ERROR, videoRoomUrlForService } from '../api/_lib/calendar.js';
import servicesApi from '../api/calendar/services.js';
import calendarApi from '../api/calendar/index.js';
import publicApi from '../api/calendar/public/[slug].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = (b) => { if (b !== undefined) { try { r.body = JSON.parse(b); } catch { r.body = b; } } return r; };
  return r;
};
let ipN = 0;
const call = async (handler, { method = 'GET', body, query = {}, cookie }) => {
  const res = mkRes();
  await handler({
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      cookie, 'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 20}`,
    },
  }, res);
  return res;
};

const users = [];
async function mkOwner(name) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`ml-${name}-${S}@example.com`}, 'x', ${name}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0];
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, ${`${name} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0];
  const slug = `ml-${name}-${S}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, slug, biz_name, timezone)
            VALUES (${w.id}, ${slug}, ${`${name} Studio`}, 'UTC')
            ON CONFLICT (workspace_id) DO UPDATE SET slug = EXCLUDED.slug`;
  users.push(u.id);
  return { ws: w.id, slug, cookie: `ivy_session=${signSession(u.id)}` };
}
const mkSvc = async (ws, name, type, label) => (await sql`
  INSERT INTO services (workspace_id, name, duration_minutes, price, location_type, location_label)
  VALUES (${ws}, ${name}, 60, 50, ${type}, ${label}) RETURNING id`).rows[0].id;
const mkBooking = async (ws, svc, url) => (await sql`
  INSERT INTO bookings (workspace_id, service_id, date, start_min, end_min, client_name, client_email, video_room_url)
  VALUES (${ws}, ${svc}, CURRENT_DATE + 3, 600, 660, 'Pat', ${`pat-${S}@example.com`}, ${url}) RETURNING id`).rows[0].id;
const svcRow = async (id) => (await sql`SELECT location_label, meeting_link_removed FROM services WHERE id = ${id}`).rows[0];
const bookingUrl = async (id) => (await sql`SELECT video_room_url FROM bookings WHERE id = ${id}`).rows[0].video_room_url;

// The clean-up statements exactly as the deploy migration runs them.
const CLEANUP = splitStatements(SCHEMA_SQL).filter((s) => /^UPDATE (services|bookings)\b/.test(s.trim())
  && s.includes("'^http://'"));
async function runCleanup() {
  for (const stmt of CLEANUP) {
    await sql.query(stmt);
  }
}

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] cleanMeetingLink');
  for (const ok of ['https://zoom.us/j/123?pwd=abc', 'HTTPS://meet.google.com/abc-defg-hij', '  https://example.com  ', 'https://teams.microsoft.com/l/meetup-join/19%3a#x']) {
    assert(cleanMeetingLink(ok).value === ok.trim(), `accepted: ${ok.trim()}`);
  }
  assert(cleanMeetingLink('').value === null && cleanMeetingLink(null).value === null, 'blank is no link (the automatic room is used)');
  for (const bad of ['http://zoom.us/j/1', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'my zoom room 123',
    'https://user:pw@evil.example', 'https://', 'zoom.us/j/1', 'https://zoom us/j/1', 'ftp://x.example']) {
    assert(cleanMeetingLink(bad).error === MEETING_LINK_ERROR, `refused with the plain message: ${bad}`);
  }
  assert(MEETING_LINK_ERROR === 'Use a link that starts with https://', 'message is plain');
  assert(/too long/.test(cleanMeetingLink(`https://x.example/${'a'.repeat(600)}`).error || ''), 'over 500 characters refused');

  console.log('\n[2] one-off clean-up of saved links');
  assert(CLEANUP.length === 4, `the 4 clean-up statements are in SCHEMA_SQL (found ${CLEANUP.length})`);
  const A = await mkOwner('a');
  const sHttp = await mkSvc(A.ws, 'Zoom http', 'virtual', 'http://zoom.us/j/111');
  const sJs = await mkSvc(A.ws, 'Script', 'virtual', 'javascript:alert(document.cookie)');
  const sData = await mkSvc(A.ws, 'Data', 'virtual', 'data:text/html,<b>x</b>');
  const sText = await mkSvc(A.ws, 'Text', 'virtual', 'Zoom: 555 123 4567, passcode 42');
  const sOk = await mkSvc(A.ws, 'Fine', 'virtual', 'https://meet.google.com/abc-defg-hij');
  const sNone = await mkSvc(A.ws, 'Auto room', 'virtual', null);
  const sPlace = await mkSvc(A.ws, 'Studio', 'in_person', '123 Main St, Suite 4');
  const bHttp = await mkBooking(A.ws, sHttp, 'http://zoom.us/j/111');
  const bJs = await mkBooking(A.ws, sJs, 'javascript:alert(document.cookie)');
  const bJitsi = await mkBooking(A.ws, sNone, 'https://meet.jit.si/ivy-AbC_d-123');
  await runCleanup();
  let r = await svcRow(sHttp);
  assert(r.location_label === 'https://zoom.us/j/111' && r.meeting_link_removed === null, 'http:// upgraded to https://, nothing removed');
  r = await svcRow(sJs);
  assert(r.location_label === null && r.meeting_link_removed === 'javascript:alert(document.cookie)', 'javascript: link removed and kept word for word for the owner');
  r = await svcRow(sData);
  assert(r.location_label === null && r.meeting_link_removed === 'data:text/html,<b>x</b>', 'data: link removed and kept');
  r = await svcRow(sText);
  assert(r.location_label === null && r.meeting_link_removed === 'Zoom: 555 123 4567, passcode 42', 'plain text (dial-in details) removed from the link and kept, not lost');
  r = await svcRow(sOk);
  assert(r.location_label === 'https://meet.google.com/abc-defg-hij' && r.meeting_link_removed === null, 'https link untouched');
  r = await svcRow(sNone);
  assert(r.location_label === null && r.meeting_link_removed === null, 'no link stays no link');
  r = await svcRow(sPlace);
  assert(r.location_label === '123 Main St, Suite 4' && r.meeting_link_removed === null, 'in-person address untouched');
  assert(await bookingUrl(bHttp) === 'https://zoom.us/j/111', 'booking copy upgraded to https');
  assert(await bookingUrl(bJs) === null, 'booking copy of a bad link cleared');
  assert(await bookingUrl(bJitsi) === 'https://meet.jit.si/ivy-AbC_d-123', 'automatic room link untouched');
  await runCleanup();
  r = await svcRow(sJs);
  assert(r.meeting_link_removed === 'javascript:alert(document.cookie)' && (await svcRow(sHttp)).location_label === 'https://zoom.us/j/111', 'rerun changes nothing');
  // Every surviving link saves again unchanged.
  for (const id of [sHttp, sOk]) {
    const lbl = (await svcRow(id)).location_label;
    assert(cleanMeetingLink(lbl).value === lbl, `a link kept by the clean-up passes the save check (${lbl})`);
  }

  console.log('\n[3] PUT /api/calendar/services');
  let res = await call(calendarApi, { cookie: A.cookie });
  let svcs = res.body?.calendar?.services || [];
  const gJs = svcs.find((s) => s.id === sJs);
  assert(gJs?.meetingLinkRemoved === 'javascript:alert(document.cookie)' && gJs.locationLabel === '', "owner's Services screen gets the removed link to re-enter");
  assert(svcs.find((s) => s.id === sOk)?.meetingLinkRemoved === null, 'others have none');
  const pub = await call(publicApi, { query: { slug: A.slug } });
  assert(pub.statusCode === 200 && !JSON.stringify(pub.body).includes('javascript:') && !JSON.stringify(pub.body).includes('meetingLinkRemoved'),
    'public booking page never sees it');
  const asSent = (s, patch = {}) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes, price: s.price,
    locationType: s.locationType, locationLabel: s.locationLabel || null, ...patch });
  // An old app (1.0.5) saves everything back as loaded, with no meetingLinkRemoved field.
  res = await call(servicesApi, { method: 'PUT', cookie: A.cookie, body: { services: svcs.map((s) => asSent(s)) } });
  assert(res.statusCode === 200, `old app save of the cleaned list works (${res.statusCode} ${JSON.stringify(res.body).slice(0, 120)})`);
  assert((await svcRow(sJs)).meeting_link_removed === 'javascript:alert(document.cookie)', 'removed link kept through an old app save');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://zoom.us/j/1', 'call me']) {
    res = await call(servicesApi, { method: 'PUT', cookie: A.cookie, body: { services: svcs.map((s) => asSent(s, s.id === sJs ? { locationLabel: bad } : {})) } });
    assert(res.statusCode === 400 && String(res.body?.error || res.body?.message || '').startsWith('Use a link that starts with https://'),
      `refused: ${bad} (${JSON.stringify(res.body)})`);
  }
  assert((await svcRow(sJs)).location_label === null, 'nothing saved by a refused request');
  // The same text is fine as an in-person address.
  res = await call(servicesApi, { method: 'PUT', cookie: A.cookie, body: { services: svcs.map((s) => asSent(s, s.id === sText ? { locationType: 'in_person', locationLabel: 'Back room' } : {})) } });
  assert(res.statusCode === 200 && (await svcRow(sText)).location_label === 'Back room' && (await svcRow(sText)).meeting_link_removed === null,
    'switching to in person saves the address and clears the removed link');
  res = await call(calendarApi, { cookie: A.cookie });
  svcs = res.body?.calendar?.services || [];
  res = await call(servicesApi, { method: 'PUT', cookie: A.cookie, body: { services: svcs.map((s) => asSent(s, s.id === sJs ? { locationLabel: 'https://zoom.us/j/999' } : {})) } });
  r = await svcRow(sJs);
  assert(res.statusCode === 200 && r.location_label === 'https://zoom.us/j/999' && r.meeting_link_removed === null, 'a new https link saves and clears the removed one');
  assert(res.body.services.find((s) => s.id === sJs)?.meetingLinkRemoved === null, 'response says it is cleared');
  res = await call(servicesApi, { method: 'PUT', cookie: A.cookie, body: { services: svcs.map((s) => asSent(s, s.id === sData ? { meetingLinkRemoved: null } : {})) } });
  assert(res.statusCode === 200 && (await svcRow(sData)).meeting_link_removed === null && (await svcRow(sData)).location_label === null,
    'Dismiss clears the removed link (the automatic room is used)');

  console.log('\n[4] bookings never copy a bad link');
  const url = videoRoomUrlForService({ location_type: 'virtual', location_label: 'javascript:alert(1)' });
  assert(/^https:\/\/meet\.jit\.si\/ivy-/.test(url), 'a bad stored link falls back to the automatic room');
  assert(videoRoomUrlForService({ location_type: 'virtual', location_label: 'https://zoom.us/j/1' }) === 'https://zoom.us/j/1', 'an https link is used');

  for (const id of users) {
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

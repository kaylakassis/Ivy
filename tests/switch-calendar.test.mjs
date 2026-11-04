// Switching to Ivy, part 2: appointments from a calendar file (.ics) and from
// Google Calendar become real bookings.
//
//   [1] parser: folded lines, TZID (IANA + Windows names), UTC, floating,
//       all-day, DURATION, RRULE (DAILY/WEEKLY/MONTHLY, INTERVAL, COUNT,
//       UNTIL, BYDAY) + EXDATE + RECURRENCE-ID, CANCELLED, malformed input,
//       2 MB cap, 500 occurrence cap, pathological input finishes fast.
//   [2] client + service guessing.
//   [3] POST /api/import/calendar-file: preview, import, duplicates, quiet,
//       no Google push, caps, malformed, another business untouched.
//   [4] /api/import/google-events: list, import by id with Google's times,
//       no second Google event, no double busy block, never deletes the
//       owner's event, not connected, another business.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/switch-calendar.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.GOOGLE_OAUTH_CLIENT_ID = 'switch-test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'switch-test-secret';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { parseIcs, unfoldLines, parsePropertyLine, resolveTimeZone, nameFromTitle, guessClient, guessService, MAX_OCCURRENCES } from '../api/_lib/icsParse.js';
import { zonedParts } from '../api/_lib/tz.js';
import calendarFile from '../api/import/calendar-file.js';
import googleEvents from '../api/import/google-events.js';
import { syncOnBookingCreated, syncOnBookingUpdated, syncOnBookingDeleted, pullBusyTimes } from '../api/_lib/googleSync.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY = 86_400_000;
const NOW = new Date('2026-11-03T12:00:00Z');

// ── Fake Google + capture of every outbound call ──
const calls = [];
let googleEvents_ = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';
  calls.push({ url: u, method });
  if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-test', expires_in: 3600 });
  const m = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^?]+))?/.exec(u);
  if (m && method === 'GET') {
    if (decodeURIComponent(m[1]) !== 'primary') return json({ items: [] });
    if (m[2]) {
      const ev = googleEvents_.find((e) => e.id === decodeURIComponent(m[2]));
      return ev ? json(ev) : json({ error: { message: 'Not Found' } }, 404);
    }
    return json({ items: googleEvents_ });
  }
  if (u.includes('resend.com')) return json({ id: 'em_test' });
  return json({});
};
const mark = () => calls.length;
const since = (m) => calls.slice(m);
const googleWrites = (m) => since(m).filter((c) => c.url.includes('googleapis.com/calendar') && c.method !== 'GET');

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
async function call(handler, { method = 'POST', body = {}, query = {}, userId }) {
  const res = mockRes();
  await handler({
    method, url: '/', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', host: 'localhost:3001',
      'x-forwarded-for': '203.0.113.91', cookie: `ivy_session=${signSession(userId)}` },
  }, res);
  return res;
}
async function mkOwner(tag, { google = false } = {}) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`switchcal-${tag}-${S}@example.com`}, 'x', 'Kayla Stone', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, google_refresh_token_encrypted, google_calendar_id, google_email, google_block_inbound)
    VALUES (${w.rows[0].id}, ${`Cal ${tag}`}, ${`switchcal-${tag}-${S}`}, 'America/Los_Angeles',
            ${google ? encrypt('refresh-token') : null}, ${google ? 'ivy-cal-id' : null}, ${google ? `kayla-${tag}-${S}@gmail.com` : null}, ${google})`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id, email: `switchcal-${tag}-${S}@example.com` };
}
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const n = async (q) => Number((await q).rows[0].n);

async function run() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'import-ics:%' OR key LIKE 'import-google:%'`.catch(() => {});
  const LA = 'America/Los_Angeles';

  console.log('\n[1] calendar file parser');
  assert(unfoldLines('A:1\r\n  2\r\n\t3\nB:x').join('|') === 'A:1 23|B:x', 'folded lines are joined');
  const pl = parsePropertyLine('ATTENDEE;CN="Doe: Jane";ROLE=REQ-PARTICIPANT:mailto:jane@example.com');
  assert(pl.name === 'ATTENDEE' && pl.params.CN === 'Doe: Jane' && pl.value === 'mailto:jane@example.com', 'quoted parameter with a colon');
  assert(resolveTimeZone('Eastern Standard Time') === 'America/New_York' && resolveTimeZone('/mozilla.org/20050126_1/America/Chicago') === 'America/Chicago' && resolveTimeZone('Mars/Base') === null, 'TZID names resolve (IANA, Windows, prefixed, unknown)');

  let r = parseIcs(ics(
    ...vevent('UID:tz1', 'DTSTART;TZID=America/New_York:20261110T090000', 'DTEND;TZID=America/New_York:20261110T100000', 'SUMMARY:Haircut - Jane Doe'),
    ...vevent('UID:utc1', 'DTSTART:20261111T170000Z', 'DURATION:PT1H30M', 'SUMMARY:Utc one'),
    ...vevent('UID:float1', 'DTSTART:20261112T140000', 'SUMMARY:Floating one'),
    ...vevent('UID:win1', 'DTSTART;TZID="Pacific Standard Time":20261113T080000', 'DTEND;TZID="Pacific Standard Time":20261113T084500', 'SUMMARY:Windows zone'),
    ...vevent('UID:allday1', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121', 'SUMMARY:Day off'),
    ...vevent('UID:cx1', 'STATUS:CANCELLED', 'DTSTART:20261114T170000Z', 'SUMMARY:Gone'),
    ...vevent('UID:past1', 'DTSTART:20250101T170000Z', 'SUMMARY:Long ago'),
    ...vevent('UID:far1', 'DTSTART:20291101T170000Z', 'SUMMARY:Too far ahead'),
    ...vevent('UID:fold1', 'DTSTART:20261115T170000Z', 'SUMMARY:Jane Doe (Co', ' lor)', 'DESCRIPTION:Line one\\nline\\, two'),
    ['BEGIN:VEVENT', 'UID:open1', 'DTSTART:20261116T170000Z'].join('\r\n'),
  ), { timeZone: LA, now: NOW });
  const by = (u) => r.events.find((e) => e.uid === u);
  assert(by('tz1')?.start === '2026-11-10T14:00:00.000Z' && by('tz1').date === '2026-11-10' && by('tz1').startMin === 6 * 60 && by('tz1').endMin === 7 * 60, 'TZID wall-clock converts to the instant and to workspace time');
  assert(by('utc1')?.start === '2026-11-11T17:00:00.000Z' && by('utc1').startMin === 9 * 60 && by('utc1').endMin === 10 * 60 + 30, "UTC 'Z' and DURATION");
  assert(by('float1')?.start === '2026-11-12T22:00:00.000Z' && by('float1').startMin === 14 * 60 && by('float1').endMin === 15 * 60, 'floating time is read in the workspace zone (1 hour default length)');
  assert(by('win1')?.startMin === 8 * 60 && by('win1').endMin === 8 * 60 + 45, 'Windows zone name from Outlook');
  assert(by('allday1')?.allDay === true && by('allday1').date === '2026-11-20' && by('allday1').startMin === 0 && by('allday1').endMin === 1440, 'all-day VALUE=DATE');
  assert(!by('cx1'), 'STATUS:CANCELLED is skipped');
  assert(by('past1')?.past === true, 'past events are listed as past');
  assert(!by('far1'), 'more than 12 months ahead is left out');
  assert(by('fold1')?.title === 'Jane Doe (Color)' && by('fold1').description === 'Line one\nline, two', 'folded title and escaped description');
  assert(!by('open1'), 'an unclosed event is ignored');
  assert(r.totals.upcoming === 6 && r.totals.past === 1 && r.totals.found === 7, `totals (${JSON.stringify(r.totals)})`);

  // DST: weekly series crossing the November change keeps 10:00 New York.
  r = parseIcs(ics(...vevent('UID:dst', 'DTSTART;TZID=America/New_York:20261026T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Weekly'),
  ), { timeZone: 'America/New_York', now: new Date('2026-10-20T00:00:00Z') });
  assert(r.events.map((e) => e.start).join(',') === '2026-10-26T14:00:00.000Z,2026-11-02T15:00:00.000Z,2026-11-09T15:00:00.000Z,2026-11-16T15:00:00.000Z', 'weekly across DST keeps the wall-clock time');
  assert(r.events.every((e) => e.startMin === 600 && e.recurring), 'all at 10:00 local, marked recurring');

  r = parseIcs(ics(
    ...vevent('UID:wk', 'DTSTART;TZID=America/Los_Angeles:20261102T090000', 'DTEND;TZID=America/Los_Angeles:20261102T093000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261204T235959Z',
      'EXDATE;TZID=America/Los_Angeles:20261116T090000,20261119T090000', 'SUMMARY:Biweekly'),
    ...vevent('UID:wk', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261130T090000', 'DTSTART;TZID=America/Los_Angeles:20261130T110000', 'DTEND;TZID=America/Los_Angeles:20261130T113000', 'SUMMARY:Biweekly moved'),
    ...vevent('UID:wk', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261203T090000', 'STATUS:CANCELLED', 'DTSTART;TZID=America/Los_Angeles:20261203T090000', 'SUMMARY:x'),
  ), { timeZone: LA, now: NOW });
  const wk = r.events.filter((e) => !e.past).map((e) => `${e.date}@${e.startMin}`).join(',');
  assert(wk === '2026-11-05@540,2026-11-30@660', `biweekly BYDAY + UNTIL + EXDATE + moved and cancelled occurrences (${wk})`);

  r = parseIcs(ics(
    ...vevent('UID:mo', 'DTSTART:20261231T170000Z', 'RRULE:FREQ=MONTHLY;COUNT=4', 'SUMMARY:Monthly 31st'),
    ...vevent('UID:dl', 'DTSTART;VALUE=DATE:20261104', 'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=3', 'EXDATE;VALUE=DATE:20261107', 'SUMMARY:Every 3 days'),
    ...vevent('UID:nth', 'DTSTART:20261110T170000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3', 'SUMMARY:Second Tuesday'),
  ), { timeZone: 'UTC', now: NOW });
  const dates = (u) => r.events.filter((e) => e.uid.startsWith(`${u}#`)).map((e) => e.date).join(',');
  assert(dates('mo') === '2026-12-31,2027-01-31,2027-03-31,2027-05-31', `monthly on the 31st skips short months, COUNT honored (${dates('mo')})`);
  assert(dates('dl') === '2026-11-04,2026-11-10', `daily INTERVAL + all-day EXDATE (${dates('dl')})`);
  assert(dates('nth') === '2026-11-10,2026-12-08,2027-01-12', `monthly second Tuesday (${dates('nth')})`);

  r = parseIcs(ics(...vevent('UID:many', 'DTSTART:20261104T170000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily forever'),
    ...vevent('UID:many2', 'DTSTART:20261104T180000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Also daily')), { timeZone: 'UTC', now: NOW });
  assert(r.totals.upcoming === MAX_OCCURRENCES && r.events.filter((e) => !e.past).length === 500 && r.truncated === true, 'occurrences capped at 500 in total');
  assert(r.events[0].start < r.events[499].start, 'soonest first');

  r = parseIcs(ics(...vevent('UID:hourly', 'DTSTART:20261104T170000Z', 'RRULE:FREQ=HOURLY;COUNT=50', 'SUMMARY:Hourly')), { timeZone: 'UTC', now: NOW });
  assert(r.events.length === 1 && r.events[0].recurring, 'an unsupported rule imports only its first date');

  for (const [label, input] of [
    ['empty', ''], ['not a string', 42], ['not a calendar', 'hello,world\n1,2'],
    ['garbage dates', ics(...vevent('UID:g', 'DTSTART:2026-13-45', 'SUMMARY:x'), ...vevent('UID:g2', 'DTSTART:20260231T100000Z'))],
    ['half lines', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART\n:::\n;;;\nATTENDEE;CN="unterminated:mailto:x\nEND:VEVENT'],
  ]) {
    let threw = false; let out;
    try { out = parseIcs(input, { timeZone: LA, now: NOW }); } catch { threw = true; }
    assert(!threw && Array.isArray(out.events) && out.events.length === 0, `malformed (${label}) never throws`);
  }
  const big = 'BEGIN:VCALENDAR\n' + 'X'.repeat(2 * 1024 * 1024);
  assert(/too large/.test(parseIcs(big, { timeZone: LA, now: NOW }).error || ''), 'over 2 MB refused');

  let t0 = Date.now();
  const hostile = ['BEGIN:VCALENDAR'];
  for (let i = 0; i < 4000; i++) hostile.push('BEGIN:VEVENT', `UID:h${i}`, 'DTSTART;TZID=America/Chicago:19000105T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;COUNT=999999', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'END:VALARM', 'SUMMARY:x', 'END:VEVENT');
  for (let i = 0; i < 4000; i++) hostile.push('BEGIN:VEVENT', `UID:d${i}`, 'DTSTART:19000101T090000Z', 'RRULE:FREQ=DAILY;COUNT=99999999', 'SUMMARY:' + '\\,'.repeat(50), 'END:VEVENT');
  hostile.push('ATTENDEE;CN="' + '"'.repeat(20000), 'X-LONG:' + 'a;'.repeat(20000), 'END:VCALENDAR');
  r = parseIcs(hostile.join('\n'), { timeZone: LA, now: NOW });
  const took = Date.now() - t0;
  assert(took < 3000 && r.events.length <= 500 + 100, `pathological file finishes fast (${took} ms, ${r.events.length} events)`);
  t0 = Date.now();
  parseIcs('BEGIN:VCALENDAR\n' + 'BEGIN:VEVENT\n'.repeat(60000), { timeZone: LA, now: NOW });
  parseIcs('BEGIN:VCALENDAR\n' + ' x'.repeat(500000), { timeZone: LA, now: NOW });
  assert(Date.now() - t0 < 3000, `deep nesting and huge folds finish fast (${Date.now() - t0} ms)`);

  console.log('\n[2] guessing the client and the service');
  const services = [{ id: 's1', name: 'Haircut' }, { id: 's2', name: 'Color' }, { id: 's3', name: 'Deep Tissue Massage' }];
  assert(nameFromTitle('Haircut - Jane Doe', services) === 'Jane Doe', '"Haircut - Jane Doe"');
  assert(nameFromTitle('Jane Doe (Haircut)', services) === 'Jane Doe', '"Jane Doe (Haircut)"');
  assert(nameFromTitle('Jane Doe: Haircut', services) === 'Jane Doe', '"Jane Doe: Haircut"');
  assert(nameFromTitle('Haircut with Jane Doe', services) === 'Jane Doe', '"Haircut with Jane Doe"');
  assert(nameFromTitle('Deep Tissue Massage - Ana', services) === 'Ana', 'service on one side, name on the other');
  assert(nameFromTitle('Team Meeting', services) === null && nameFromTitle('Lunch', services) === null && nameFromTitle('Dentist appointment 3pm', services) === null, 'ordinary calendar entries are not clients');
  assert(nameFromTitle('Jane Doe', services) === 'Jane Doe', 'a title that is just a name');
  const gc1 = guessClient({ title: 'Haircut', attendees: [{ name: 'Kayla', email: 'kayla@x.com' }, { name: 'Sam Lee', email: 'sam@x.com' }], organizerEmail: 'kayla@x.com', services });
  assert(gc1.clientName === 'Sam Lee' && gc1.clientEmail === 'sam@x.com', 'attendee who is not the organizer');
  const g2 = guessClient({ title: 'Color - Jo Park', attendees: [{ name: null, email: 'jo@x.com' }, { name: 'Room 1', email: 'room@x.com', cutype: 'ROOM' }], ownerEmails: ['me@x.com'], services });
  assert(g2.clientName === 'Jo Park' && g2.clientEmail === 'jo@x.com', 'attendee without a name takes it from the title');
  const sv = guessService('deep tissue massage - Ana', services);
  assert(sv?.serviceId === 's3' && guessService('Walk the dog', services) === null, 'service matched by name inside the title');

  console.log('\n[3] calendar file import endpoint');
  const A = await mkOwner('a', { google: true });
  const B = await mkOwner('b');
  await sql`INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
    VALUES (${A.workspaceId}, 'Welcome', 'client_created', ${JSON.stringify([{ type: 'send_email', config: { subject: 'Hi', body: 'Hi' } }])}::jsonb, TRUE)`;
  const svcId = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${A.workspaceId}, 'Haircut', 60, 50) RETURNING id`).rows[0].id;
  const day = (k, hh) => { const d = new Date(Date.now() + k * DAY); d.setUTCHours(hh, 0, 0, 0); return d; };
  const existing = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.workspaceId}, 'Jane Doe', ${`jane-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
  const file = ics(
    ...vevent(`UID:one-${S}`, `DTSTART:${stamp(day(3, 18))}`, `DTEND:${stamp(day(3, 19))}`, 'SUMMARY:Haircut - Jane Doe', `ATTENDEE;CN=Kayla:mailto:${A.email}`, `ORGANIZER:mailto:${A.email}`),
    ...vevent(`UID:two-${S}`, `DTSTART:${stamp(day(4, 20))}`, 'DURATION:PT45M', 'SUMMARY:Consult', `ATTENDEE;CN="Sam New":mailto:sam-${S}@example.com`),
    ...vevent(`UID:three-${S}`, `DTSTART:${stamp(day(5, 17))}`, 'SUMMARY:Lunch'),
    ...vevent(`UID:rep-${S}`, `DTSTART:${stamp(day(6, 16))}`, 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Pat Weekly'),
    ...vevent(`UID:allday-${S}`, `DTSTART;VALUE=DATE:${stamp(day(7, 0)).slice(0, 8)}`, 'SUMMARY:Holiday'),
    ...vevent(`UID:old-${S}`, 'DTSTART:20200101T170000Z', 'SUMMARY:Old Client'),
  );
  // An existing booking at the same time as "Lunch" (no client known) marks it duplicate.
  const lunch = zonedParts(LA, day(5, 17));
  await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min)
    VALUES (${A.workspaceId}, 'Someone', '', ${`${lunch.y}-${String(lunch.m).padStart(2, '0')}-${String(lunch.d).padStart(2, '0')}`}, ${lunch.minutes}, ${lunch.minutes + 60})`;

  let res = await call(calendarFile, { userId: A.userId, body: { ics: file, mode: 'preview' } });
  assert(res.statusCode === 200, `preview answers 200 (${res.statusCode} ${res.body?.error || ''})`);
  const ev = (prefix) => res.body.events.filter((e) => e.uid.startsWith(prefix));
  const one = ev(`one-${S}`)[0];
  assert(one?.clientName === 'Jane Doe' && one.clientEmail === null && one.serviceId === svcId && one.serviceName === 'Haircut' && one.duplicate === false, 'owner is not the client; name and service read from the title');
  assert(ev(`two-${S}`)[0]?.clientName === 'Sam New' && ev(`two-${S}`)[0]?.clientEmail === `sam-${S}@example.com`, 'attendee becomes the client');
  assert(ev(`three-${S}`)[0]?.duplicate === true, 'same start as an existing booking is a duplicate');
  assert(ev(`rep-${S}`).length === 3 && ev(`rep-${S}`).every((e) => e.recurring), 'weekly series expanded');
  assert(ev(`allday-${S}`)[0]?.allDay === true && ev(`old-${S}`)[0]?.past === true, 'all-day and past flagged');
  const keys = Object.keys(one || {}).sort().join(',');
  assert(keys === 'allDay,clientEmail,clientName,duplicate,end,past,recurring,serviceId,serviceName,start,title,uid', `event shape matches the contract (${keys})`);
  assert(res.body.totals.upcoming === 7 && res.body.totals.past === 1 && res.body.totals.duplicates === 1 && res.body.totals.found === 8, `totals (${JSON.stringify(res.body.totals)})`);

  const bPreview = await call(calendarFile, { userId: B.userId, body: { ics: file, mode: 'preview' } });
  assert(bPreview.body.events.find((e) => e.uid.startsWith(`three-${S}`))?.duplicate === false, "another business's bookings never count as duplicates");

  let m = mark();
  const clientsBefore = await n(sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${A.workspaceId}`);
  res = await call(calendarFile, { userId: A.userId, body: { ics: file, mode: 'import' } });
  assert(res.statusCode === 200 && res.body.created === 5 && res.body.skipped === 1, `default import: 5 created, duplicate skipped, all-day left out (${JSON.stringify(res.body)})`);
  assert(Array.isArray(res.body.missingEmail) && res.body.missingEmail.some((c) => c.name === 'Pat Weekly') && res.body.missingEmail.every((c) => c.clientId && c.name), 'missingEmail lists new clients without an email');
  const rows = (await sql`SELECT client_id, client_name, client_email, service_id, source, import_uid, google_event_id, notes, private_notes FROM bookings WHERE workspace_id = ${A.workspaceId} AND import_uid IS NOT NULL ORDER BY date, start_min`).rows;
  assert(rows.length === 5 && rows.every((b) => b.source === 'import' && /^ics:[0-9a-f]{64}$/.test(b.import_uid) && b.google_event_id === null), 'bookings marked as imported');
  assert(rows[0].client_id === existing && rows[0].service_id === svcId, 'existing client matched by name, service linked');
  assert(rows.every((b) => /Imported from a calendar file/.test(b.private_notes || '') && !b.notes), 'where it came from is a private owner note, never the client-visible note');
  assert(since(m).length === 0, `no email, text, push or Google call (${since(m).map((c) => c.url).join(', ')})`);
  assert(await n(sql`SELECT COUNT(*)::int AS n FROM workflow_runs WHERE workspace_id = ${A.workspaceId}`) === 0, 'no automation fired for new clients');
  assert(await n(sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${A.workspaceId}`) === clientsBefore + 2, 'two new clients (Sam New, Pat Weekly)');

  res = await call(calendarFile, { userId: A.userId, body: { ics: file, mode: 'import' } });
  assert(res.body.created === 0 && res.body.skipped === 6, 'importing the same file again creates nothing');
  res = await call(calendarFile, { userId: A.userId, body: { ics: file, mode: 'import', uids: [`allday-${S}`, `old-${S}`] } });
  assert(res.body.created === 1 && res.body.skipped === 1, 'a chosen all-day event imports; a past one never does');

  res = await call(calendarFile, { userId: B.userId, body: { ics: file, mode: 'import', uids: [`one-${S}`] } });
  assert(res.body.created === 1, 'another business imports its own copy');
  const bRow = (await sql`SELECT client_id FROM bookings WHERE workspace_id = ${B.workspaceId} AND import_uid IS NOT NULL`).rows[0];
  assert(bRow && bRow.client_id !== existing && (await sql`SELECT workspace_id FROM clients WHERE id = ${bRow.client_id}`).rows[0].workspace_id === B.workspaceId, "it never links to the first business's client");

  res = await call(calendarFile, { userId: A.userId, body: { ics: 'nonsense', mode: 'preview' } });
  assert(res.statusCode === 400, 'malformed file → 400');
  res = await call(calendarFile, { userId: A.userId, body: { ics: 'BEGIN:VCALENDAR\n' + 'x'.repeat(2 * 1024 * 1024 + 10), mode: 'preview' } });
  assert(res.statusCode === 413, 'over 2 MB → 413');
  res = await call(calendarFile, { userId: A.userId, body: { ics: file, mode: 'drop tables' } });
  assert(res.statusCode === 400, 'unknown mode → 400');
  res = await call(calendarFile, { userId: A.userId, body: { ics: file, mode: 'import', uids: 'all' } });
  assert(res.statusCode === 400, 'uids must be a list');

  console.log('\n[4] Google Calendar import');
  const G = await mkOwner('g', { google: true });
  const NG = await mkOwner('ng');
  const at = (k, hh, mm = 0) => { const d = new Date(Date.now() + k * DAY); d.setUTCHours(hh, mm, 0, 0); return d.toISOString(); };
  const pushedBooking = (await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min, google_event_id)
    VALUES (${G.workspaceId}, 'Pushed', '', '2031-01-01', 600, 660, ${`pushed-${S}`}) RETURNING id`).rows[0].id;
  googleEvents_ = [
    { id: `g1-${S}`, status: 'confirmed', summary: 'Haircut', start: { dateTime: at(3, 18) }, end: { dateTime: at(3, 19) },
      attendees: [{ email: `kayla-g-${S}@gmail.com`, self: true }, { email: `lia-${S}@example.com`, displayName: 'Lia Moss' }],
      organizer: { email: `kayla-g-${S}@gmail.com`, self: true } },
    { id: `g2-${S}`, status: 'confirmed', summary: 'Retreat', start: { date: at(5, 0).slice(0, 10) }, end: { date: at(6, 0).slice(0, 10) } },
    { id: `g3-${S}`, status: 'confirmed', summary: 'Color - Ivy pushed', start: { dateTime: at(4, 18) }, end: { dateTime: at(4, 19) }, extendedProperties: { private: { ivy_booking_id: 'x' } } },
    { id: `g4-${S}`, status: 'cancelled', summary: 'Gone', start: { dateTime: at(4, 20) }, end: { dateTime: at(4, 21) } },
    { id: `pushed-${S}`, status: 'confirmed', summary: 'Pushed', start: { dateTime: at(4, 22) }, end: { dateTime: at(4, 23) } },
    { id: `g5-${S}`, status: 'confirmed', summary: 'Dentist', start: { dateTime: at(6, 17) }, end: { dateTime: at(6, 18) } },
  ];
  res = await call(googleEvents, { method: 'GET', userId: G.userId, query: { days: '30' } });
  assert(res.statusCode === 200 && res.body.connected === true, 'connected calendar lists events');
  const gids = res.body.events.map((e) => e.id);
  assert(gids.includes(`g1-${S}`) && gids.includes(`g2-${S}`) && gids.includes(`g5-${S}`), 'appointments listed');
  assert(!gids.includes(`g3-${S}`) && !gids.includes(`g4-${S}`) && !gids.includes(`pushed-${S}`), 'events Ivy made and cancelled ones are left out');
  const g1 = res.body.events.find((e) => e.id === `g1-${S}`);
  assert(g1.clientName === 'Lia Moss' && g1.clientEmail === `lia-${S}@example.com` && g1.attendees.length === 1 && g1.alreadyInIvy === false, 'guest is the client, the owner is not');
  assert(res.body.events.find((e) => e.id === `g2-${S}`).allDay === true, 'all-day flagged');
  const gkeys = Object.keys(g1).sort().join(',');
  assert(gkeys === 'allDay,alreadyInIvy,attendees,clientEmail,clientName,end,id,serviceId,serviceName,start,title', `event shape matches the contract (${gkeys})`);

  m = mark();
  res = await call(googleEvents, { userId: G.userId, body: { events: [
    { id: `g1-${S}`, clientName: 'Lia Moss', clientEmail: `lia-${S}@example.com`, start: '2020-01-01T00:00:00Z' },
    { id: `g3-${S}`, clientName: 'Sneaky' },
    { id: `missing-${S}`, clientName: 'Ghost' },
  ] } });
  assert(res.statusCode === 200 && res.body.created === 1 && res.body.skipped === 2, `imports the real one, skips Ivy's own and unknown ids (${JSON.stringify(res.body)})`);
  const gb = (await sql`SELECT id, date, start_min, end_min, google_event_id, import_uid, client_name FROM bookings WHERE workspace_id = ${G.workspaceId} AND import_uid = ${`google:g1-${S}`}`).rows[0];
  const lp = zonedParts(LA, new Date(at(3, 18)));
  assert(gb && gb.start_min === lp.minutes && gb.end_min === lp.minutes + 60, "times come from Google, not from the request");
  assert(gb?.google_event_id === `g1-${S}`, 'booking linked to the Google event');
  assert(googleWrites(m).length === 0, 'nothing written to Google');

  m = mark();
  await syncOnBookingCreated({ workspaceId: G.workspaceId, bookingId: gb.id });
  await syncOnBookingUpdated({ workspaceId: G.workspaceId, bookingId: gb.id });
  await syncOnBookingDeleted({ workspaceId: G.workspaceId, googleEventId: gb.google_event_id });
  assert(googleWrites(m).length === 0, 'calendar sync never creates a second event, edits or deletes the owner event');
  const pushedNew = (await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min)
    VALUES (${G.workspaceId}, 'Normal', '', '2031-02-01', 600, 660) RETURNING id`).rows[0].id;
  m = mark();
  await syncOnBookingCreated({ workspaceId: G.workspaceId, bookingId: pushedNew });
  assert(googleWrites(m).some((c) => c.method === 'POST' && c.url.includes('/calendars/ivy-cal-id/events')), 'a normal booking still syncs to Google');
  m = mark();
  await syncOnBookingCreated({ workspaceId: G.workspaceId, bookingId: pushedBooking });
  assert(googleWrites(m).length === 0, 'a booking already linked to a Google event is not pushed again');

  const busy = await pullBusyTimes({ workspaceId: G.workspaceId });
  const blocks = (await sql`SELECT source_event_id FROM external_busy_blocks WHERE workspace_id = ${G.workspaceId}`).rows.map((b) => b.source_event_id);
  assert(busy.ok && !blocks.includes(`g1-${S}`) && blocks.includes(`g5-${S}`), `imported event is not also a busy block (${blocks.join(',')})`);

  res = await call(googleEvents, { userId: G.userId, body: { events: [{ id: `g1-${S}`, clientName: 'Lia Moss' }] } });
  assert(res.body.created === 0 && res.body.skipped === 1, 'importing the same event twice creates one booking');
  res = await call(googleEvents, { method: 'GET', userId: G.userId, query: {} });
  assert(res.body.events.find((e) => e.id === `g1-${S}`)?.alreadyInIvy === true, 'listed as already in Ivy');

  res = await call(googleEvents, { method: 'GET', userId: NG.userId, query: {} });
  assert(res.statusCode === 200 && res.body.connected === false && res.body.events.length === 0, 'not connected: says so');
  res = await call(googleEvents, { userId: NG.userId, body: { events: [{ id: `g5-${S}`, clientName: 'X' }] } });
  assert(res.statusCode === 409, "a business without Google can't import");
  assert(await n(sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${NG.workspaceId}`) === 0, 'nothing written there');
  res = await call(googleEvents, { userId: G.userId, body: { events: Array.from({ length: 501 }, (_, i) => ({ id: `x${i}`, clientName: 'X' })) } });
  assert(res.statusCode === 400, 'more than 500 events refused');
  res = await call(googleEvents, { userId: G.userId, body: { events: [{ id: `g5-${S}`, clientName: 'Den Tist', serviceId: svcId }] } });
  const g5 = (await sql`SELECT service_id FROM bookings WHERE workspace_id = ${G.workspaceId} AND import_uid = ${`google:g5-${S}`}`).rows[0];
  assert(res.body.created === 1 && g5 && g5.service_id === null, "another business's service id is ignored");

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

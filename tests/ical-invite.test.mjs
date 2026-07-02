// Unit test for buildBookingInvite() — the single-event .ics attached to
// booking-confirmation emails so a client can add the appointment to their
// own calendar. Pure function, no DB.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/ical-invite.test.mjs

import { buildBookingInvite } from '../api/_lib/ical.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const ics = buildBookingInvite({
  bizName: 'Bright & Co.',
  serviceName: 'Deep Tissue Massage',
  date: '2026-08-14',
  startMin: 9 * 60 + 30, // 09:30
  endMin: 10 * 60 + 30,  // 10:30
  bookingId: 'abc123',
  locationAddress: '123 Main St, Suite 4',
  description: 'Booked with Bright & Co. via Ivy OS.',
});

console.log('\n[1] well-formed single VEVENT calendar');
assert(ics.startsWith('BEGIN:VCALENDAR'), 'starts with VCALENDAR');
assert(ics.includes('METHOD:PUBLISH'), 'has PUBLISH method');
assert((ics.match(/BEGIN:VEVENT/g) || []).length === 1, 'exactly one VEVENT');
assert(ics.trimEnd().endsWith('END:VCALENDAR'), 'ends with VCALENDAR');
assert(/\r\n/.test(ics), 'uses CRLF line endings (RFC 5545)');

console.log('\n[2] event fields');
assert(ics.includes('DTSTART:20260814T093000'), 'DTSTART floating local 09:30');
assert(ics.includes('DTEND:20260814T103000'), 'DTEND floating local 10:30');
assert(/SUMMARY:Deep Tissue Massage with Bright/.test(ics), 'SUMMARY names service + business');
assert(ics.includes('UID:abc123@getivyos.com'), 'UID from booking id');
assert(/LOCATION:123 Main St/.test(ics), 'LOCATION carried');
assert(ics.includes('STATUS:CONFIRMED'), 'STATUS confirmed');

console.log('\n[3] graceful fallbacks');
const bare = buildBookingInvite({ date: '2026-01-02', startMin: 600, endMin: 660, bookingId: 'x' });
assert(/SUMMARY:Appointment/.test(bare), 'falls back to "Appointment" with no names');
assert(!/LOCATION:/.test(bare), 'no LOCATION line when none given');

console.log('\n[4] timezone → absolute UTC instant');
// 09:30 on 2026-08-14 in New York (EDT, UTC-4) == 13:30 UTC.
const tzIcs = buildBookingInvite({
  bizName: 'Bright & Co.', serviceName: 'Massage',
  date: '2026-08-14', startMin: 9 * 60 + 30, endMin: 10 * 60 + 30,
  bookingId: 'tz1', timezone: 'America/New_York',
});
assert(tzIcs.includes('DTSTART:20260814T133000Z'), 'DTSTART is absolute UTC (13:30Z) with tz');
assert(tzIcs.includes('DTEND:20260814T143000Z'), 'DTEND is absolute UTC (14:30Z) with tz');
// No tz → floating local (legacy), no Z suffix.
assert(/DTSTART:20260814T093000(?!Z)/.test(ics), 'no-tz stays floating local (no Z)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

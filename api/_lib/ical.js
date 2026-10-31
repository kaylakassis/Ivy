// iCalendar (RFC 5545) serializer. Just enough of the spec to emit a
// subscribable feed of Ivy bookings - VCALENDAR + VEVENT, with RRULE
// for recurring bookings and EXDATE for cancelled occurrences.
import { zonedTimeToUtcMs } from './tz.js';
//
// Privacy: SUMMARY uses the service name + the client's first name only.
// Email / phone / notes never appear in the feed because the URL is
// shared with whatever calendar app the owner chooses, and that app may
// re-share or back up its data outside our control.

// Wrap long lines per RFC 5545 §3.1: hard limit 75 octets, continuation
// lines start with a single space. Most modern calendar clients are lax
// about this but Apple Cal and Outlook still complain.
//
// First line: 75 octets. Continuation lines: 74 octets of content (the
// leading space makes each 75 wide). We count UTF-8 BYTES and split on
// code points so a multibyte char (accents, emoji) is never cut in half -
// strict parsers (Apple Cal, Outlook) reject a line split mid-sequence.
function fold(line) {
  const byteLen = (s) => Buffer.byteLength(s, 'utf8');
  if (byteLen(line) <= 75) return line;
  const out = [];
  let cur = '';
  let limit = 75; // first line; continuations drop to 74 (leading space → 75)
  for (const ch of Array.from(line)) {  // Array.from splits on code points
    if (byteLen(cur) + byteLen(ch) > limit) {
      out.push(cur);
      cur = ch;
      limit = 74;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.map((c, idx) => (idx === 0 ? c : ' ' + c)).join('\r\n');
}

// Escape per RFC 5545 §3.3.11. ICAL TEXT escapes \, ;, , and newlines.
function escText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function pad(n) { return String(n).padStart(2, '0'); }

// Ivy booking times are the workspace's wall-clock time. When we know the
// workspace timezone, emit an absolute UTC instant ("…Z") so the event lands at
// the right moment in whatever zone the recipient's calendar is set to. Without
// a tz we fall back to FLOATING local time (no Z) — the legacy behavior, which
// calendar apps treat as the viewer's own zone.
function fmtDT(dateStr, mins, tz) {
  if (tz) {
    const d = new Date(zonedTimeToUtcMs(dateStr, mins, tz));
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
      + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  const h = Math.floor(mins / 60);
  const mn = mins % 60;
  return `${y}${pad(m)}${pad(d)}T${pad(h)}${pad(mn)}00`;
}

function fmtUtcStamp(dateLike = new Date()) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Map our coarse recurrence strings ('weekly' | 'biweekly' | 'monthly')
// onto an RRULE. Returns null for non-recurring.
function rruleFor(rule, until) {
  if (!rule) return null;
  const parts = [];
  if (rule === 'weekly')   parts.push('FREQ=WEEKLY');
  else if (rule === 'biweekly') parts.push('FREQ=WEEKLY;INTERVAL=2');
  else if (rule === 'monthly')  parts.push('FREQ=MONTHLY');
  else return null;
  if (until) {
    const [y, m, d] = String(until).slice(0, 10).split('-').map(Number);
    // RFC 5545: UNTIL when value-type is DATE-TIME without TZID must be UTC.
    // We add T235959 so the end-of-day is included.
    parts.push(`UNTIL=${y}${pad(m)}${pad(d)}T235959Z`);
  }
  return parts.join(';');
}

function exDates(occurrences = []) {
  return occurrences
    .filter(Boolean)
    .map((iso) => String(iso).slice(0, 10).replace(/-/g, ''));
}

// Strip a client's display name down to a first name only for the
// SUMMARY field. Keeps the feed informative without leaking full names
// to whatever syncs the URL.
function firstName(s) {
  if (!s) return 'client';
  return String(s).trim().split(/\s+/)[0] || 'client';
}

// Compact UTC stamp for a wall-clock booking time: "20260814T133000Z" when the
// workspace timezone is known, floating local ("20260814T093000") otherwise.
// Shared by the .ics builder and the Google Calendar deep link so both land
// the event at the same instant.
export function bookingStamp(dateStr, mins, tz) {
  return fmtDT(dateStr, mins, tz);
}

// Mailbox-safe fragment of an address for ORGANIZER/ATTENDEE mailto: values.
function mailto(addr) {
  const a = String(addr || '').trim();
  if (!a || !/^[^\s@]+@[^\s@]+$/.test(a)) return null;
  return a;
}

// A single-event .ics for a booking confirmation / reschedule email and the
// one-tap "Add to Apple/Outlook" download. Unlike buildICalFeed (a read-only
// mirror of ALL the owner's bookings), this is a client-facing invitation:
//
//   • METHOD:REQUEST + ORGANIZER (the business) + ATTENDEE (the client) so
//     Apple Mail, Outlook and Gmail render it as an invitation to accept
//     rather than an opaque attachment.
//   • A stable UID (<bookingId>@joinivy.ai) and a SEQUENCE that rises on
//     every reschedule, so re-sending after a move UPDATES the calendar
//     entry the client already saved instead of creating a second one.
//   • LOCATION carries the venue address or the video link; when the
//     workspace timezone is known the times are absolute UTC ("…Z") so the
//     event lands correctly in the client's own calendar zone.
export function buildBookingInvite({
  bizName, serviceName, date, startMin, endMin, bookingId,
  locationAddress, description, url, timezone,
  method = 'REQUEST', sequence = 0, status = 'CONFIRMED',
  organizerEmail, attendeeEmail, attendeeName,
}) {
  const stamp = fmtUtcStamp();
  const summary = serviceName
    ? `${serviceName}${bizName ? ` with ${bizName}` : ''}`
    : (bizName ? `Appointment with ${bizName}` : 'Appointment');
  const uid = `${bookingId || 'booking'}@joinivy.ai`;
  const seq = Number.isFinite(Number(sequence)) && Number(sequence) >= 0 ? Math.floor(Number(sequence)) : 0;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ivy//Booking invite//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method === 'PUBLISH' || method === 'CANCEL' ? method : 'REQUEST'}`,
    'BEGIN:VEVENT',
    fold(`UID:${uid}`),
    `SEQUENCE:${seq}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmtDT(date, startMin, timezone)}`,
    `DTEND:${fmtDT(date, endMin, timezone)}`,
    fold(`SUMMARY:${escText(summary)}`),
    `STATUS:${status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  ];
  // ORGANIZER is the business. A mailto: value is mandatory per RFC 5545,
  // so we fall back to a no-reply mailbox when the workspace has no
  // reply-to address; the CN is what calendar apps actually display.
  const orgMail = mailto(organizerEmail) || 'no-reply@joinivy.ai';
  lines.push(fold(`ORGANIZER;CN=${escText(bizName || 'Ivy')}:mailto:${orgMail}`));
  const attMail = mailto(attendeeEmail);
  if (attMail) {
    lines.push(fold(`ATTENDEE;CN=${escText(attendeeName || attMail)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${attMail}`));
  }
  if (locationAddress) lines.push(fold(`LOCATION:${escText(locationAddress)}`));
  if (url) lines.push(fold(`URL:${escText(url)}`));
  lines.push(fold(`DESCRIPTION:${escText(description || 'Booked via Ivy.')}`));
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Google Calendar "add event" deep link for the same booking. Google
// accepts the compact UTC form ("…Z") and the floating form; we pass the
// workspace timezone as ctz so a floating time is read in the right zone.
export function buildGoogleCalendarUrl({
  bizName, serviceName, date, startMin, endMin, timezone, locationAddress, description,
}) {
  const summary = serviceName
    ? `${serviceName}${bizName ? ` with ${bizName}` : ''}`
    : (bizName ? `Appointment with ${bizName}` : 'Appointment');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: summary,
    dates: `${fmtDT(date, startMin, timezone)}/${fmtDT(date, endMin, timezone)}`,
  });
  if (description) params.set('details', description);
  if (locationAddress) params.set('location', locationAddress);
  if (timezone) params.set('ctz', timezone);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function buildICalFeed({ bizName, bookings, services, timezone }) {
  const serviceById = new Map((services || []).map((s) => [s.id, s]));
  const stamp = fmtUtcStamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ivy//Booking feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escText(`Bookings · ${bizName || 'Ivy'}`)}`),
    fold(`X-WR-CALDESC:${escText('Read-only mirror of bookings managed in Ivy. Edits, reschedules, and cancellations happen in the Ivy app - this feed updates automatically.')}`),
    'X-PUBLISHED-TTL:PT15M',
  ];

  for (const b of (bookings || [])) {
    if (b.cancelled_at) continue;
    const svc = serviceById.get(b.service_id);
    const summary = `${svc?.name || 'Appointment'} - ${firstName(b.client_name)}`;
    const dtstart = fmtDT(b.date, b.start_min, timezone);
    const dtend   = fmtDT(b.date, b.end_min, timezone);
    const uid     = `${b.id}@joinivy.ai`;
    const rrule   = rruleFor(b.recurrence_rule, b.recurrence_until);
    const ex      = exDates(b.cancelled_occurrences);

    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${uid}`));
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${dtstart}`);
    lines.push(`DTEND:${dtend}`);
    lines.push(fold(`SUMMARY:${escText(summary)}`));
    lines.push('STATUS:CONFIRMED');
    lines.push('TRANSP:OPAQUE');
    lines.push(fold(`DESCRIPTION:${escText('Manage in Ivy. Edits made in your calendar app will not sync back.')}`));
    if (rrule) lines.push(fold(`RRULE:${rrule}`));
    if (ex.length) lines.push(fold(`EXDATE;VALUE=DATE:${ex.join(',')}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 §3.1: lines separated by CRLF.
  return lines.join('\r\n') + '\r\n';
}

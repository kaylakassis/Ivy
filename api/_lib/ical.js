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

// A single-event .ics for a booking confirmation email attachment, so the
// client can one-tap "add to calendar" (a proven no-show reducer). Unlike
// buildICalFeed (a read-only mirror of ALL the owner's bookings), this is a
// client-facing invite: SUMMARY names the business, and it carries the
// location + a friendly description. When the workspace timezone is known the
// times are absolute UTC ("…Z") so the event lands correctly in the client's
// own calendar zone; without it we fall back to floating local (legacy).
export function buildBookingInvite({
  bizName, serviceName, date, startMin, endMin, bookingId,
  locationAddress, description, url, timezone,
}) {
  const stamp = fmtUtcStamp();
  const summary = serviceName
    ? `${serviceName}${bizName ? ` with ${bizName}` : ''}`
    : (bizName ? `Appointment with ${bizName}` : 'Appointment');
  const uid = `${bookingId || 'booking'}@joinivy.ai`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ivy//Booking invite//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    fold(`UID:${uid}`),
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmtDT(date, startMin, timezone)}`,
    `DTEND:${fmtDT(date, endMin, timezone)}`,
    fold(`SUMMARY:${escText(summary)}`),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
  ];
  if (locationAddress) lines.push(fold(`LOCATION:${escText(locationAddress)}`));
  if (url) lines.push(fold(`URL:${escText(url)}`));
  lines.push(fold(`DESCRIPTION:${escText(description || 'Booked via Ivy.')}`));
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
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

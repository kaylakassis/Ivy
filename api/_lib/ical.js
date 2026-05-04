// iCalendar (RFC 5545) serializer. Just enough of the spec to emit a
// subscribable feed of THRYVE bookings — VCALENDAR + VEVENT, with RRULE
// for recurring bookings and EXDATE for cancelled occurrences.
//
// Privacy: SUMMARY uses the service name + the client's first name only.
// Email / phone / notes never appear in the feed because the URL is
// shared with whatever calendar app the owner chooses, and that app may
// re-share or back up its data outside our control.

// Wrap long lines per RFC 5545 §3.1: hard limit 75 octets, continuation
// lines start with a single space. Most modern calendar clients are lax
// about this but Apple Cal and Outlook still complain.
//
// First chunk: 75 chars. Continuation chunks: 74 chars (the leading space
// in the output makes each continuation line 75 wide).
function fold(line) {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  let i = 75;
  while (i < line.length) {
    const chunk = line.slice(i, i + 74);
    out.push(' ' + chunk);
    i += chunk.length;
  }
  return out.join('\r\n');
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

// "20260101T140000Z" — UTC, basic format. We treat THRYVE booking
// times as the workspace's local time, but since we don't have per-
// workspace tz wired through the schema yet, emit floating local time
// (no Z suffix). Calendar apps will treat that as the user's local
// zone, which matches the owner's mental model.
function fmtLocal(dateStr, mins) {
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

export function buildICalFeed({ bizName, bookings, services }) {
  const serviceById = new Map((services || []).map((s) => [s.id, s]));
  const stamp = fmtUtcStamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//THRYVE//Booking feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escText(`Bookings · ${bizName || 'THRYVE'}`)}`),
    fold(`X-WR-CALDESC:${escText('Read-only mirror of bookings managed in THRYVE. Edits, reschedules, and cancellations happen in the THRYVE app — this feed updates automatically.')}`),
    'X-PUBLISHED-TTL:PT15M',
  ];

  for (const b of (bookings || [])) {
    if (b.cancelled_at) continue;
    const svc = serviceById.get(b.service_id);
    const summary = `${svc?.name || 'Appointment'} — ${firstName(b.client_name)}`;
    const dtstart = fmtLocal(b.date, b.start_min);
    const dtend   = fmtLocal(b.date, b.end_min);
    const uid     = `${b.id}@thryve.app`;
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
    lines.push(fold(`DESCRIPTION:${escText('Manage in THRYVE. Edits made in your calendar app will not sync back.')}`));
    if (rrule) lines.push(fold(`RRULE:${rrule}`));
    if (ex.length) lines.push(fold(`EXDATE;VALUE=DATE:${ex.join(',')}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 §3.1: lines separated by CRLF.
  return lines.join('\r\n') + '\r\n';
}

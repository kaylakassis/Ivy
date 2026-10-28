// One-tap "add to calendar" for a booking, shared by the confirmation /
// reschedule emails, the public booking confirmation screen and the client
// portal's booking list.
//
// Two links per booking:
//   • google - a Google Calendar "add event" deep link (pure URL, no server
//              round-trip). Built from the same fields as the .ics so both
//              land the event at the same instant.
//   • ics    - a signed URL on /api/calendar/invite that streams a single
//              VEVENT (.ics) for Apple Calendar / Outlook / anything else.
//              Signed, not tokenised: the link only reveals what the client
//              already knows (their own appointment) and it has to keep
//              working from an email months later, so it never expires.
//              A bad or forged signature is a 404.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { buildBookingInvite, buildGoogleCalendarUrl } from './ical.js';
import { appUrl } from './tokens.js';

function secret() {
  return process.env.CALENDAR_INVITE_SECRET || process.env.JWT_SECRET || 'ivy-calendar-invite';
}

export function signInvite(bookingId) {
  return crypto.createHmac('sha256', secret()).update(`invite:${bookingId}`).digest('base64url').slice(0, 32);
}

export function verifyInviteSignature(bookingId, sig) {
  if (!bookingId || !sig || typeof sig !== 'string') return false;
  const expected = Buffer.from(signInvite(bookingId));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function inviteUrlFor(bookingId) {
  return `${appUrl()}/api/calendar/invite?b=${encodeURIComponent(bookingId)}&s=${encodeURIComponent(signInvite(bookingId))}`;
}

// Everything the .ics / Google link needs about one booking, in one query.
// Scoped by workspace_id when the caller knows it (defense-in-depth for the
// authenticated callers); the public invite endpoint looks up by id +
// signature only, since the signature is what proves the link was issued.
export async function loadBookingForInvite({ bookingId, workspaceId = null }) {
  const { rows } = await sql`
    SELECT b.id, b.workspace_id, b.client_name, b.client_email,
           b.date, b.start_min, b.end_min, b.cancelled_at,
           b.video_room_url, b.location_address, b.created_at, b.updated_at,
           s.name AS service_name, s.location_type, s.location_label,
           cs.biz_name, cs.timezone,
           u.email AS owner_email
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
     WHERE b.id = ${bookingId}
       AND (${workspaceId}::uuid IS NULL OR b.workspace_id = ${workspaceId}::uuid)
     LIMIT 1
  `;
  return rows[0] || null;
}

// Normalises a raw bookings row (plus the joined service / settings fields
// above) into the arguments the ical builders take. Callers that already
// hold the row (bookingNotify, /me/bookings) pass it straight through so
// there is one place deciding what "location" and "description" mean.
export function inviteFieldsFor(row) {
  const dateISO = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
  const businessName = row.biz_name || 'Your business';
  const serviceName = row.service_name || 'Session';
  const videoUrl = row.location_type === 'virtual' && row.location_label
    ? row.location_label
    : (row.video_room_url || null);
  const venue = row.location_address
    || (row.location_type === 'in_person' ? row.location_label : null)
    || null;
  // Reschedules bump updated_at; the gap from created_at gives a SEQUENCE
  // that only ever grows, so a re-sent invite replaces the saved event.
  const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
  const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : createdMs;
  const sequence = Math.max(0, Math.floor((updatedMs - createdMs) / 1000));
  return {
    bizName: businessName,
    serviceName,
    date: dateISO,
    startMin: row.start_min,
    endMin: row.end_min,
    bookingId: row.id,
    timezone: row.timezone || null,
    locationAddress: videoUrl || venue,
    description: videoUrl
      ? `Booked with ${businessName} via Ivy. Join: ${videoUrl}`
      : `Booked with ${businessName} via Ivy.`,
    sequence,
    organizerEmail: row.owner_email || null,
    attendeeEmail: row.client_email || null,
    attendeeName: row.client_name || null,
    status: row.cancelled_at ? 'CANCELLED' : 'CONFIRMED',
  };
}

export function buildInviteIcs(row) {
  return buildBookingInvite(inviteFieldsFor(row));
}

// { google, ics } for one booking row. Pure (no I/O) so list endpoints can
// call it per row.
export function calendarLinksFor(row) {
  const f = inviteFieldsFor(row);
  return {
    google: buildGoogleCalendarUrl(f),
    ics: inviteUrlFor(row.id),
  };
}

// The email block with the two links. Inline styles only (see emailShell).
export function renderAddToCalendar(links) {
  if (!links?.google || !links?.ics) return '';
  return `<p style="margin:18px 0 6px;font-size:13px;color:#85827B;">Add it to your calendar:</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.7;">
        <a href="${escapeAttr(links.google)}" style="color:#2E3168;font-weight:600;text-decoration:underline;">Add to Google Calendar</a>
        &nbsp;&middot;&nbsp;
        <a href="${escapeAttr(links.ics)}" style="color:#2E3168;font-weight:600;text-decoration:underline;">Add to Apple/Outlook (.ics)</a>
      </p>`;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

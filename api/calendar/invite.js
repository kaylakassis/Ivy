// GET /api/calendar/invite?b=<bookingId>&s=<signature>  (public)
//
// Streams a single-event .ics for one booking so a client can one-tap
// "Add to Apple/Outlook" from the confirmation email, the public booking
// confirmation screen or their portal. The link is HMAC-signed over the
// booking id (api/_lib/calendarLinks.js): a forged or tampered link is a
// 404, and nothing beyond the appointment the client already has is
// disclosed (service, time, venue or video link, business name).
//
// Rate limited per IP like the other public endpoints. Cancelled bookings
// return a METHOD:CANCEL invite so the saved event is removed on import.
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { loadBookingForInvite, verifyInviteSignature, inviteFieldsFor } from '../_lib/calendarLinks.js';
import { buildBookingInvite } from '../_lib/ical.js';
import { methodNotAllowed, notFound, serverError } from '../_lib/json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `calinvite:ip:${ip}`, max: 60, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const bookingId = String(req.query.b || '');
    const sig = String(req.query.s || '');
    if (!UUID_RE.test(bookingId) || !verifyInviteSignature(bookingId, sig)) {
      return notFound(res, 'This calendar link is not valid.');
    }
    const row = await loadBookingForInvite({ bookingId });
    if (!row) return notFound(res, 'This booking no longer exists.');

    const fields = inviteFieldsFor(row);
    const ics = buildBookingInvite({
      ...fields,
      method: row.cancelled_at ? 'CANCEL' : 'REQUEST',
    });
    res.setHeader('Content-Type', `text/calendar; method=${row.cancelled_at ? 'CANCEL' : 'REQUEST'}; charset=utf-8`);
    res.setHeader('Content-Disposition', 'attachment; filename="booking.ics"');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).end(ics);
  } catch (err) {
    return serverError(res, err);
  }
}

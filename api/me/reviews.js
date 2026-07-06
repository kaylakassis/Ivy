// POST /api/me/reviews - body { bookingId, rating, text? }
// Client leaves a review of a business, tied to a specific past booking
// they were the recipient of. UNIQUE (booking_id) at the DB layer
// prevents resubmission; ownership verified through myClientIds().
//
// Booking eligibility: must be in the past (date <= today), not cancelled,
// and the reviewer must own the client_id on it. Future-dated bookings
// can't be reviewed.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { serializeReview } from '../_lib/reviews.js';
import { celebrateFirstReview, celebrateReviewMilestones } from '../_lib/milestones.js';
import { badRequest, created, methodNotAllowed, notFound, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const body = await readBody(req);
    const bookingId = body.bookingId ? String(body.bookingId) : null;
    const rating    = Number(body.rating);
    const text      = body.text == null ? null : String(body.text).trim().slice(0, 2000);

    if (!bookingId) return badRequest(res, 'bookingId is required');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return badRequest(res, 'rating must be 1–5');
    }

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'Booking not found');

    // Booking must be the user's, past, not cancelled.
    const found = await sql.query(
      // "Past" is judged in the business's timezone (fallback UTC).
      `SELECT b.id, b.workspace_id, b.client_id, b.date, b.cancelled_at
       FROM bookings b
       LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
       WHERE b.id = $1 AND b.client_id = ANY($2) AND b.cancelled_at IS NULL
         AND b.date <= (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date`,
      [bookingId, myIds],
    );
    if (found.rows.length === 0) {
      return notFound(res, 'Booking not found, in the future, or already cancelled');
    }
    const booking = found.rows[0];
    const membership = memberships.find((m) => m.clientId === booking.client_id);
    const reviewerName = (membership?.clientName || user.name || 'A client').trim();

    try {
      // Auto-published ('visible') immediately; the owner can respond or
      // appeal it for removal from the Reviews tab.
      const r = await sql`
        INSERT INTO reviews (
          workspace_id, client_id, booking_id, reviewer_user_id,
          reviewer_name, rating, text, status
        ) VALUES (
          ${booking.workspace_id}, ${booking.client_id}, ${booking.id}, ${user.id},
          ${reviewerName}, ${rating}, ${text || null}, 'visible'
        )
        RETURNING *
      `;
      // Review milestones (best-effort, one-time each): the first, then tiers.
      celebrateFirstReview(booking.workspace_id).catch(() => {});
      celebrateReviewMilestones(booking.workspace_id).catch(() => {});
      return created(res, { review: serializeReview(r.rows[0], { includeBookingId: true }) });
    } catch (err) {
      // Hit the UNIQUE (booking_id) constraint - reviewed already.
      if (String(err.code) === '23505' || /duplicate key/i.test(err.message || '')) {
        return badRequest(res, 'You already reviewed this booking');
      }
      throw err;
    }
  } catch (err) {
    return serverError(res, err);
  }
}

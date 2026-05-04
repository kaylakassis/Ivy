// GET /api/me/pending-reviews
// Lists bookings the user has had recently that they haven't reviewed
// yet. Used by ClientHome's summary count + ClientBookings to decorate
// past bookings with a "Leave a review" CTA.
//
// Eligibility: client_id in myClientIds, cancelled_at IS NULL,
// date BETWEEN today − 60 days AND today (recent past), and no row in
// reviews with this booking_id yet.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { bookings: [] });
    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    const { rows } = await sql.query(
      `SELECT b.id, b.workspace_id, b.client_id, b.service_id,
              b.date, b.start_min, b.end_min,
              s.name AS service_name
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       WHERE b.client_id = ANY($1)
         AND b.cancelled_at IS NULL
         AND b.date >= CURRENT_DATE - INTERVAL '60 days'
         AND b.date <= CURRENT_DATE
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
       ORDER BY b.date DESC, b.start_min DESC
       LIMIT 50`,
      [myIds],
    );

    const bookings = rows.map((r) => {
      const m = byClient.get(r.client_id);
      return {
        id: r.id,
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
        startMin: r.start_min,
        endMin:   r.end_min,
        serviceName: r.service_name || 'Appointment',
        businessName: m?.businessName || 'Business',
      };
    });
    return ok(res, { bookings });
  } catch (err) {
    return serverError(res, err);
  }
}

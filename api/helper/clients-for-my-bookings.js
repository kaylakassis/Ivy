// GET /api/helper/clients-for-my-bookings?workspaceId=…
//
// Contact details for ONLY the clients this helper is booked with at
// this business (name, email, phone, notes the owner wrote for them are
// NOT included). Scoped by workspace_id AND staff_id via the bookings
// join - a client with no booking assigned to this helper is invisible.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireHelper } from '../_lib/helpers.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const gate = await requireHelper(req, res, { workspaceId: req.query.workspaceId });
    if (!gate) return;
    const { membership } = gate;

    const { rows } = await sql`
      SELECT c.id, c.name, c.email, c.phone,
             MIN(b.date) FILTER (WHERE b.date >= CURRENT_DATE) AS next_date,
             COUNT(b.id)::int AS booking_count
        FROM clients c
        JOIN bookings b ON b.client_id = c.id
                       AND b.workspace_id = ${membership.workspaceId}
                       AND b.staff_id = ${membership.staffId}
                       AND b.cancelled_at IS NULL
       WHERE c.workspace_id = ${membership.workspaceId}
       GROUP BY c.id, c.name, c.email, c.phone
       ORDER BY c.name ASC
    `;
    return ok(res, {
      workspaceId: membership.workspaceId,
      clients: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email || null,
        phone: r.phone || null,
        nextDate: r.next_date instanceof Date ? r.next_date.toISOString().slice(0, 10) : (r.next_date || null),
        bookingCount: r.booking_count,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

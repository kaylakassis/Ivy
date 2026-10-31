// /api/helper/bookings/:id/no-show   body: { workspaceId? }
//   POST   → mark the helper's OWN booking as a no-show
//   DELETE → undo
//
// Deliberately narrower than the owner endpoint
// (api/calendar/bookings/no-show.js): a helper never charges a no-show
// fee. Money stays with the owner, who sees the no-show flag on the
// calendar and can charge from there. Fee columns are never touched here.
import { sql } from '../../../_lib/db.js';
import { readBody } from '../../../_lib/body.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { requireHelper } from '../../../_lib/helpers.js';
import { serializeHelperBooking } from '../../schedule.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return methodNotAllowed(res, ['POST', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const body = await readBody(req);
    const gate = await requireHelper(req, res, { workspaceId: body.workspaceId || req.query.workspaceId });
    if (!gate) return;
    const { membership } = gate;
    const { id } = req.query;

    const r = await sql`
      SELECT b.*, s.name AS service_name, s.location_type, s.location_label
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.id = ${id}
         AND b.workspace_id = ${membership.workspaceId}
         AND b.staff_id = ${membership.staffId}
       LIMIT 1
    `;
    const booking = r.rows[0];
    if (!booking) return notFound(res, 'Booking not found');

    if (req.method === 'POST') {
      if (booking.cancelled_at) return badRequest(res, "Can't mark a cancelled booking as a no-show");
      if (booking.no_show_at)   return badRequest(res, 'Already marked as a no-show');
      const upd = await sql`
        UPDATE bookings SET no_show_at = NOW(), updated_at = NOW()
         WHERE id = ${id} AND workspace_id = ${membership.workspaceId} AND staff_id = ${membership.staffId}
        RETURNING *
      `;
      return ok(res, { booking: serializeHelperBooking({ ...booking, ...upd.rows[0] }) });
    }

    const undone = await sql`
      UPDATE bookings SET no_show_at = NULL, updated_at = NOW()
       WHERE id = ${id} AND workspace_id = ${membership.workspaceId} AND staff_id = ${membership.staffId}
         AND no_show_at IS NOT NULL
      RETURNING *
    `;
    if (undone.rows.length === 0) return badRequest(res, 'This booking is not marked as a no-show');
    return ok(res, { booking: serializeHelperBooking({ ...booking, ...undone.rows[0] }), undone: true });
  } catch (err) {
    return serverError(res, err);
  }
}

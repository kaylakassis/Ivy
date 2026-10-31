// /api/helper/bookings/:id/complete   body: { workspaceId?, occurrenceDate, notes? }
//   POST   → mark one occurrence of the helper's OWN booking complete
//   DELETE → undo (stray tap)
//
// Same state machine as the owner endpoint (api/_lib/completion.js), so
// the owner sees exactly what they would have recorded themselves, with
// completedByStaffId pointing at the helper. Helpers cannot attach files
// or change client visibility; notes are allowed (what happened in the
// session) and are visible to the owner.
//
// The booking is loaded with workspace_id AND staff_id from the session's
// membership - a booking assigned to anyone else is "not found".
import { sql } from '../../../_lib/db.js';
import { readBody } from '../../../_lib/body.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { requireHelper } from '../../../_lib/helpers.js';
import { markComplete, undoComplete, CompletionError } from '../../../_lib/completion.js';
import { serializeHelperBooking } from '../../schedule.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return methodNotAllowed(res, ['POST', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const body = await readBody(req);
    const gate = await requireHelper(req, res, { workspaceId: body.workspaceId || req.query.workspaceId });
    if (!gate) return;
    const { user, membership } = gate;
    const { id } = req.query;
    const occurrenceDate = body.occurrenceDate ? String(body.occurrenceDate) : null;
    if (!occurrenceDate) return badRequest(res, 'occurrenceDate is required');

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

    try {
      if (req.method === 'POST') {
        const row = await markComplete({
          booking, occurrenceDate,
          userId: user.id, staffId: membership.staffId,
          notes: body.notes == null ? '' : String(body.notes).slice(0, 8000),
          attachments: [],
          visibleToClient: true,
        });
        return ok(res, { booking: serializeHelperBooking({ ...booking, ...row }) });
      }
      const { booking: row } = await undoComplete({ booking, occurrenceDate });
      return ok(res, { booking: serializeHelperBooking({ ...booking, ...row }) });
    } catch (e) {
      if (e instanceof CompletionError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  } catch (err) {
    return serverError(res, err);
  }
}

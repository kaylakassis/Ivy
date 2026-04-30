// DELETE /api/calendar/bookings/:id — cancel a booking (soft, sets cancelled_at).
import { sql } from '../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { methodNotAllowed, noContent, notFound, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const r = await sql`
      UPDATE bookings SET cancelled_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND cancelled_at IS NULL
    `;
    if (r.rowCount === 0) return notFound(res, 'Booking not found');
    return noContent(res);
  } catch (err) {
    return serverError(res, err);
  }
}

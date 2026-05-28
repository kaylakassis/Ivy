// POST   /api/me/groups/:id/mute   → mute this group (no push, still shows)
// DELETE /api/me/groups/:id/mute   → unmute
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { myClientIds } from '../../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { methodNotAllowed, noContent, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'Group not found');
    const { id } = req.query;

    if (req.method === 'POST') {
      const upd = await sql.query(
        `UPDATE group_thread_members SET muted = TRUE
          WHERE thread_id = $1 AND client_id = ANY($2::uuid[]) AND left_at IS NULL
          RETURNING client_id`,
        [id, clientIds],
      );
      if (upd.rows.length === 0) return notFound(res, 'Group not found');
      return ok(res, { muted: true });
    }
    if (req.method === 'DELETE') {
      const upd = await sql.query(
        `UPDATE group_thread_members SET muted = FALSE
          WHERE thread_id = $1 AND client_id = ANY($2::uuid[]) AND left_at IS NULL
          RETURNING client_id`,
        [id, clientIds],
      );
      if (upd.rows.length === 0) return notFound(res, 'Group not found');
      return noContent(res);
    }
    return methodNotAllowed(res, ['POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

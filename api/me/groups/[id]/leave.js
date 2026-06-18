// POST /api/me/groups/:id/leave - client leaves the group.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { myClientIds } from '../../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'Group not found');
    const { id } = req.query;

    const upd = await sql.query(
      `UPDATE group_thread_members
          SET left_at = NOW()
        WHERE thread_id = $1 AND client_id = ANY($2::uuid[]) AND left_at IS NULL
        RETURNING workspace_id`,
      [id, clientIds],
    );
    if (upd.rows.length === 0) return notFound(res, 'Group not found');
    const workspaceId = upd.rows[0].workspace_id;
    await sql`
      INSERT INTO group_messages (thread_id, workspace_id, sender, kind, text)
      VALUES (${id}, ${workspaceId}, 'system', 'member_left', 'A member left the group.')
    `;
    return ok(res, { left: true });
  } catch (err) {
    return serverError(res, err);
  }
}

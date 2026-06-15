// DELETE /api/messages/groups/:id/members/:clientId
// Owner removes a client from a group (sets left_at). History stays.
import { sql } from '../../../../_lib/db.js';
import { requireUser } from '../../../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../../../_lib/security.js';
import { fetchOwnedGroup } from '../../../../_lib/groupChat.js';
import { methodNotAllowed, noContent, notFound, serverError } from '../../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id, clientId } = req.query;

    const thread = await fetchOwnedGroup({ id, workspaceId });
    if (!thread) return notFound(res, 'Group not found');

    const upd = await sql`
      UPDATE group_thread_members
         SET left_at = NOW()
       WHERE thread_id = ${id} AND client_id = ${clientId}
         AND workspace_id = ${workspaceId} AND left_at IS NULL
       RETURNING client_id
    `;
    if (upd.rows.length === 0) return notFound(res, 'Member not found');
    await sql`
      INSERT INTO group_messages (thread_id, workspace_id, sender, kind, text)
      VALUES (${id}, ${workspaceId}, 'system', 'member_removed', 'A member was removed.')
    `;
    return noContent(res);
  } catch (err) {
    return serverError(res, err);
  }
}

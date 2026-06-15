// POST /api/messages/groups/:id/read — owner clears unread_biz.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { fetchOwnedGroup } from '../../../_lib/groupChat.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;
    const thread = await fetchOwnedGroup({ id, workspaceId });
    if (!thread) return notFound(res, 'Group not found');
    await sql`UPDATE group_threads SET unread_biz = 0 WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    return ok(res, { read: true });
  } catch (err) {
    return serverError(res, err);
  }
}

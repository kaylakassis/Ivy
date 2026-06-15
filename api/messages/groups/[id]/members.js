// POST /api/messages/groups/:id/members
//   body: { clientIds: [...] }
// Adds clients to the group. Each id must belong to this workspace.
// Idempotent on (thread, client) — already-present clients are no-ops;
// previously-left clients get re-activated (left_at NULL'd).
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { readBody } from '../../../_lib/body.js';
import { fetchOwnedGroup } from '../../../_lib/groupChat.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

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

    const body = await readBody(req);
    const clientIds = Array.isArray(body.clientIds)
      ? body.clientIds.filter((x) => typeof x === 'string').slice(0, 500)
      : [];
    if (clientIds.length === 0) return badRequest(res, 'clientIds is required');

    const r = await sql.query(
      `SELECT id, name FROM clients WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, clientIds],
    );
    if (r.rows.length === 0) return badRequest(res, 'no matching clients in this workspace');
    const validIds = r.rows.map((row) => row.id);

    await sql.query(
      `INSERT INTO group_thread_members (thread_id, client_id, workspace_id)
        SELECT $1, c, $2 FROM unnest($3::uuid[]) AS c
        ON CONFLICT (thread_id, client_id) DO UPDATE
          SET left_at = NULL,
              joined_at = CASE WHEN group_thread_members.left_at IS NOT NULL THEN NOW() ELSE group_thread_members.joined_at END,
              unread_count = 0`,
      [id, workspaceId, validIds],
    );
    await sql`
      INSERT INTO group_messages (thread_id, workspace_id, sender, kind, text)
      VALUES (${id}, ${workspaceId}, 'system', 'members_added',
              ${`${r.rows.length} member${r.rows.length === 1 ? '' : 's'} added.`})
    `;
    await sql`UPDATE group_threads SET updated_at = NOW() WHERE id = ${id} AND workspace_id = ${workspaceId}`;

    return ok(res, { added: r.rows.length });
  } catch (err) {
    return serverError(res, err);
  }
}

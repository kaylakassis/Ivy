// GET /api/me/groups - every group thread this user is an active member of,
// across all the workspaces they're a client of.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { myClientIds } from '../../_lib/clientPortal.js';
import { serializeGroupThread } from '../../_lib/groupChat.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return ok(res, { groups: [] });

    const r = await sql.query(
      `SELECT t.*,
              m.client_id, m.unread_count, m.muted,
              (SELECT COUNT(*)::int FROM group_thread_members mm
                WHERE mm.thread_id = t.id AND mm.workspace_id = t.workspace_id AND mm.left_at IS NULL) AS member_count,
              cs.biz_name, w.name AS workspace_name
         FROM group_thread_members m
         JOIN group_threads t ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
         JOIN workspaces w ON w.id = t.workspace_id
         LEFT JOIN calendar_settings cs ON cs.workspace_id = t.workspace_id
        WHERE m.client_id = ANY($1::uuid[])
          AND m.left_at IS NULL
          AND t.archived = FALSE
        ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
        LIMIT 500`,
      [clientIds],
    );
    return ok(res, {
      groups: r.rows.map((row) => ({
        ...serializeGroupThread(row, {
          memberCount: row.member_count,
          currentMember: { unread_count: row.unread_count, muted: row.muted },
        }),
        clientId:     row.client_id,
        businessName: row.biz_name || row.workspace_name || 'Business',
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

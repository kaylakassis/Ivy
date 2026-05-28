// GET /api/me/groups/:id — group + members (when mode='open') + messages
// Also clears this client's unread_count.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { myClientIds } from '../../_lib/clientPortal.js';
import {
  serializeGroupThread, serializeGroupMember, serializeGroupMessage,
} from '../../_lib/groupChat.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'Group not found');
    const { id } = req.query;

    // Resolve this user's membership in this thread (across all the
    // clients-rows they own). One row max — one thread is in one workspace.
    const r = await sql.query(
      `SELECT t.*, m.client_id, m.unread_count, m.muted, m.last_read_at
         FROM group_threads t
         JOIN group_thread_members m
           ON m.thread_id = t.id AND m.workspace_id = t.workspace_id
        WHERE t.id = $1
          AND m.client_id = ANY($2::uuid[])
          AND m.left_at IS NULL
        LIMIT 1`,
      [id, clientIds],
    );
    const row = r.rows[0];
    if (!row) return notFound(res, 'Group not found');

    const workspaceId = row.workspace_id;
    const myClientId = row.client_id;

    // Members list — only visible in 'open' mode. In broadcast mode the
    // member list is sensitive (might reveal who else subscribes to the
    // owner's announcements), so we hide it.
    const showMembers = row.mode === 'open';
    const [members, messages] = await Promise.all([
      showMembers ? sql`
        SELECT m.client_id, m.joined_at, m.left_at, m.muted,
               c.name AS client_name, c.email AS client_email
          FROM group_thread_members m
          JOIN clients c ON c.id = m.client_id AND c.workspace_id = m.workspace_id
         WHERE m.thread_id = ${id} AND m.workspace_id = ${workspaceId} AND m.left_at IS NULL
         ORDER BY m.joined_at ASC
      ` : Promise.resolve({ rows: [] }),
      sql`
        SELECT * FROM (
          SELECT msg.*, c.name AS sender_name
            FROM group_messages msg
            LEFT JOIN clients c ON c.id = msg.sender_client_id
           WHERE msg.thread_id = ${id} AND msg.workspace_id = ${workspaceId}
             AND (msg.sender = 'biz' OR msg.sender = 'system'
                  OR (msg.sender = 'client' AND ${row.mode} = 'open'))
           ORDER BY msg.created_at DESC
           LIMIT 500
        ) sub ORDER BY created_at ASC
      `,
    ]);

    // Clear this client's unread + stamp last_read_at.
    if (row.unread_count > 0) {
      await sql`
        UPDATE group_thread_members
           SET unread_count = 0, last_read_at = NOW()
         WHERE thread_id = ${id} AND client_id = ${myClientId} AND workspace_id = ${workspaceId}
      `;
    }

    return ok(res, {
      group: serializeGroupThread(row, {
        memberCount: showMembers ? members.rows.length : null,
        currentMember: { unread_count: 0, muted: row.muted },
      }),
      myClientId,
      members: members.rows.map(serializeGroupMember),
      messages: messages.rows.map(serializeGroupMessage),
      canReply: row.mode === 'open',
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// /api/messages/groups/:id
//   GET    → group + members + recent messages (also clears unread_biz)
//   PATCH  → rename, change description/mode, archive/unarchive, markRead
//   DELETE → archive (preserves history)
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import {
  fetchOwnedGroup,
  serializeGroupThread, serializeGroupMember, serializeGroupMessage,
  loadReactionsForMessages,
} from '../../_lib/groupChat.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

const VALID_MODES = new Set(['open', 'broadcast']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const thread = await fetchOwnedGroup({ id, workspaceId });
    if (!thread) return notFound(res, 'Group not found');

    if (req.method === 'GET') {
      const [members, messages] = await Promise.all([
        sql`
          SELECT m.client_id, m.joined_at, m.left_at, m.muted,
                 c.name AS client_name, c.email AS client_email
            FROM group_thread_members m
            JOIN clients c ON c.id = m.client_id AND c.workspace_id = m.workspace_id
           WHERE m.thread_id = ${id} AND m.workspace_id = ${workspaceId} AND m.left_at IS NULL
           ORDER BY m.joined_at ASC
        `,
        sql`
          SELECT * FROM (
            SELECT msg.*,
                   c.name AS sender_name
              FROM group_messages msg
              LEFT JOIN clients c ON c.id = msg.sender_client_id
             WHERE msg.thread_id = ${id} AND msg.workspace_id = ${workspaceId}
             ORDER BY msg.created_at DESC
             LIMIT 500
          ) sub
          ORDER BY created_at ASC
        `,
      ]);
      // Clear owner-side unread on read.
      if (thread.unread_biz > 0) {
        await sql`UPDATE group_threads SET unread_biz = 0 WHERE id = ${id} AND workspace_id = ${workspaceId}`;
        thread.unread_biz = 0;
      }
      const reactionMap = await loadReactionsForMessages(messages.rows.map((r) => r.id), 'biz');
      return ok(res, {
        group: serializeGroupThread(thread, { memberCount: members.rows.length }),
        members: members.rows.map(serializeGroupMember),
        messages: messages.rows.map((r) =>
          serializeGroupMessage({ ...r, reactions: reactionMap[r.id] || [] }),
        ),
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = String(body.name || '').trim();
        if (!v) return badRequest(res, 'name is required');
        if (v.length > 200) return badRequest(res, 'name is too long');
        push('name', v);
      }
      if ('description' in body) {
        push('description', body.description ? String(body.description).slice(0, 4000) : null);
      }
      if ('mode' in body) {
        if (!VALID_MODES.has(body.mode)) return badRequest(res, 'invalid mode');
        push('mode', body.mode);
      }
      if ('archived' in body) {
        push('archived', !!body.archived);
      }
      if (body.markRead === true) {
        push('unread_biz', 0);
      }
      if (sets.length === 0) return ok(res, { group: serializeGroupThread(thread) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const text = `UPDATE group_threads SET ${sets.join(', ')}
                     WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
                     RETURNING *`;
      const r = await sql.query(text, values);
      return ok(res, { group: serializeGroupThread(r.rows[0]) });
    }

    if (req.method === 'DELETE') {
      // Archive, never hard-delete - preserves history for any member.
      await sql`UPDATE group_threads SET archived = TRUE, updated_at = NOW()
                 WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

// /api/messages/groups/:id/messages
//   GET  → paginated history (?before=ISO&limit=N)
//   POST → owner sends { text, attachments? }
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { readBody } from '../../../_lib/body.js';
import { withIdempotency } from '../../../_lib/idempotency.js';
import {
  fetchOwnedGroup, serializeGroupMessage,
  cleanAttachments, insertGroupMessage, loadReactionsForMessages,
} from '../../../_lib/groupChat.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

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
      const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
      const beforeIso = String(req.query.before || '').trim();
      let rows;
      if (beforeIso) {
        const r = await sql`
          SELECT msg.*, c.name AS sender_name
            FROM group_messages msg
            LEFT JOIN clients c ON c.id = msg.sender_client_id
           WHERE msg.thread_id = ${id} AND msg.workspace_id = ${workspaceId}
             AND msg.created_at < ${beforeIso}::timestamptz
           ORDER BY msg.created_at DESC
           LIMIT ${limit}
        `;
        rows = r.rows.reverse();
      } else {
        const r = await sql`
          SELECT * FROM (
            SELECT msg.*, c.name AS sender_name
              FROM group_messages msg
              LEFT JOIN clients c ON c.id = msg.sender_client_id
             WHERE msg.thread_id = ${id} AND msg.workspace_id = ${workspaceId}
             ORDER BY msg.created_at DESC
             LIMIT ${limit}
          ) s ORDER BY created_at ASC
        `;
        rows = r.rows;
      }
      const reactionMap = await loadReactionsForMessages(rows.map((r) => r.id), 'biz');
      return ok(res, { messages: rows.map((r) =>
        serializeGroupMessage({ ...r, reactions: reactionMap[r.id] || [] }),
      ) });
    }

    if (req.method === 'POST') {
      if (thread.archived) return badRequest(res, 'Group is archived');

      const idemp = await withIdempotency(req, user.id, async () => {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        const attachments = cleanAttachments(body.attachments);
        const parentMessageId = body.parentMessageId ? String(body.parentMessageId) : null;
        if (!text && attachments.length === 0) {
          return { status: 400, body: { error: 'Message text or attachment is required' } };
        }
        if (text.length > 4000) return { status: 400, body: { error: 'Message is too long' } };

        // Load active members for @mention resolution.
        const members = await sql`
          SELECT m.client_id, c.name AS client_name
            FROM group_thread_members m
            JOIN clients c ON c.id = m.client_id AND c.workspace_id = m.workspace_id
           WHERE m.thread_id = ${id} AND m.workspace_id = ${workspaceId} AND m.left_at IS NULL
        `;
        const result = await insertGroupMessage({
          workspaceId, threadId: id, threadName: thread.name,
          sender: 'biz', senderClientId: null,
          text, attachments, parentMessageId,
          activeMembers: members.rows,
        });
        if (result.error) return { status: result.status || 400, body: { error: result.error } };
        return { status: 201, body: { message: result.message } };
      });
      if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
      return res.status(idemp.status).json(idemp.body);
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

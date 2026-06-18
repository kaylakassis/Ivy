// POST /api/me/groups/:id/messages - client sends to the group.
// Rejected when mode='broadcast'.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { myClientIds } from '../../../_lib/clientPortal.js';
import { readBody } from '../../../_lib/body.js';
import { withIdempotency } from '../../../_lib/idempotency.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import {
  cleanAttachments, insertGroupMessage,
} from '../../../_lib/groupChat.js';
import { methodNotAllowed, notFound, serverError } from '../../../_lib/json.js';

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

    // Resolve membership + thread in one shot.
    const r = await sql.query(
      `SELECT t.id, t.workspace_id, t.name, t.mode, t.archived,
              m.client_id
         FROM group_threads t
         JOIN group_thread_members m
           ON m.thread_id = t.id AND m.workspace_id = t.workspace_id
        WHERE t.id = $1 AND m.client_id = ANY($2::uuid[]) AND m.left_at IS NULL
        LIMIT 1`,
      [id, clientIds],
    );
    const row = r.rows[0];
    if (!row) return notFound(res, 'Group not found');
    if (row.archived) return res.status(403).json({ error: 'Group is archived' });
    if (row.mode !== 'open') return res.status(403).json({ error: 'This is an announcements-only group' });

    const workspaceId = row.workspace_id;
    const myClientId = row.client_id;
    const threadName = row.name;

    const idemp = await withIdempotency(req, user.id, async () => {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const attachments = cleanAttachments(body.attachments);
      const parentMessageId = body.parentMessageId ? String(body.parentMessageId) : null;
      if (!text && attachments.length === 0) {
        return { status: 400, body: { error: 'Message text or attachment is required' } };
      }
      if (text.length > 4000) return { status: 400, body: { error: 'Message is too long' } };

      const members = await sql`
        SELECT m.client_id, c.name AS client_name
          FROM group_thread_members m
          JOIN clients c ON c.id = m.client_id AND c.workspace_id = m.workspace_id
         WHERE m.thread_id = ${id} AND m.workspace_id = ${workspaceId} AND m.left_at IS NULL
      `;
      const result = await insertGroupMessage({
        workspaceId, threadId: id, threadName,
        sender: 'client', senderClientId: myClientId,
        text, attachments, parentMessageId,
        activeMembers: members.rows,
      });
      if (result.error) return { status: result.status || 400, body: { error: result.error } };
      return { status: 201, body: { message: result.message } };
    });
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);
  } catch (err) {
    return serverError(res, err);
  }
}

// Client-portal reactions on a group message.
//   POST   { emoji } → add
//   DELETE ?emoji=…  → remove
import { sql } from '../../../../../_lib/db.js';
import { requireUser } from '../../../../../_lib/auth.js';
import { myClientIds } from '../../../../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../../../../_lib/security.js';
import { readBody } from '../../../../../_lib/body.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'Message not found');
    const { id, mid } = req.query;

    // Resolve this client's membership AND the message in one shot.
    const r = await sql.query(
      `SELECT msg.id AS msg_id, msg.workspace_id, m.client_id AS my_client_id
         FROM group_messages msg
         JOIN group_thread_members m
           ON m.thread_id = msg.thread_id AND m.workspace_id = msg.workspace_id
        WHERE msg.id = $1 AND msg.thread_id = $2
          AND m.client_id = ANY($3::uuid[]) AND m.left_at IS NULL
        LIMIT 1`,
      [mid, id, clientIds],
    );
    const row = r.rows[0];
    if (!row) return notFound(res, 'Message not found');

    if (req.method === 'POST') {
      const body = await readBody(req);
      const emoji = String(body.emoji || '').trim();
      if (!emoji || emoji.length > 16) return badRequest(res, 'emoji is required');
      await sql`
        INSERT INTO group_message_reactions (message_id, workspace_id, reactor_client_id, emoji)
        VALUES (${row.msg_id}, ${row.workspace_id}, ${row.my_client_id}, ${emoji})
        ON CONFLICT DO NOTHING
      `;
      return ok(res, { reacted: true });
    }
    if (req.method === 'DELETE') {
      const emoji = String(req.query.emoji || '').trim();
      if (!emoji) return badRequest(res, 'emoji is required');
      await sql`
        DELETE FROM group_message_reactions
         WHERE message_id = ${row.msg_id} AND workspace_id = ${row.workspace_id}
           AND reactor_client_id = ${row.my_client_id} AND emoji = ${emoji}
      `;
      return noContent(res);
    }
    return methodNotAllowed(res, ['POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

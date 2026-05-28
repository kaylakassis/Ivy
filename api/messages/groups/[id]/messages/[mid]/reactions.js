// POST   /api/messages/groups/:id/messages/:mid/reactions  body { emoji }
//   → owner adds a reaction
// DELETE /api/messages/groups/:id/messages/:mid/reactions?emoji=...
//   → owner removes their reaction
import { sql } from '../../../../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../../../../_lib/auth.js';
import { requireSameOrigin } from '../../../../../_lib/security.js';
import { readBody } from '../../../../../_lib/body.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../../../../_lib/json.js';

const EMOJI_MAX = 16;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id, mid } = req.query;

    // Verify the message belongs to this workspace + thread.
    const m = await sql`
      SELECT id FROM group_messages
       WHERE id = ${mid} AND thread_id = ${id} AND workspace_id = ${workspaceId}
       LIMIT 1
    `;
    if (m.rows.length === 0) return notFound(res, 'Message not found');

    if (req.method === 'POST') {
      const body = await readBody(req);
      const emoji = String(body.emoji || '').trim();
      if (!emoji || emoji.length > EMOJI_MAX) return badRequest(res, 'emoji is required');
      await sql`
        INSERT INTO group_message_reactions (message_id, workspace_id, is_owner, emoji)
        VALUES (${mid}, ${workspaceId}, TRUE, ${emoji})
        ON CONFLICT DO NOTHING
      `;
      return ok(res, { reacted: true });
    }

    if (req.method === 'DELETE') {
      const emoji = String(req.query.emoji || '').trim();
      if (!emoji) return badRequest(res, 'emoji is required');
      await sql`
        DELETE FROM group_message_reactions
         WHERE message_id = ${mid} AND workspace_id = ${workspaceId}
           AND is_owner = TRUE AND emoji = ${emoji}
      `;
      return noContent(res);
    }

    return methodNotAllowed(res, ['POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

// /api/me/threads/:id
//   GET  → list messages in this thread + clear unread_client counter
//   POST → append a new message from the client. Body { text }.
//
// Authorization: the thread's client_id must be in the user's myClientIds().
// Owners can NOT use this endpoint — they have /api/messages/:id.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { serializeThread, serializeMessage } from '../../_lib/messages.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';
import { notifyOwnerSafe } from '../../_lib/push.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { id } = req.query;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'Thread not found');

    // Fetch + ownership check in one query.
    const { rows } = await sql.query(
      `SELECT t.*, c.name AS client_name, c.email AS client_email
       FROM message_threads t
       JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
       WHERE t.id = $1 AND t.client_id = ANY($2)`,
      [id, myIds],
    );
    if (rows.length === 0) return notFound(res, 'Thread not found');
    const thread = rows[0];
    const membership = memberships.find((m) => m.clientId === thread.client_id);

    if (req.method === 'GET') {
      const msgs = await sql`
        SELECT * FROM messages WHERE thread_id = ${id} ORDER BY created_at
      `;
      // Clear the client's unread badge once they've opened the thread.
      // Defense-in-depth: re-scope to client_id = ANY(myIds) so a future
      // regression in the SELECT above can't be coerced into clearing
      // somebody else's unread counter.
      if (thread.unread_client > 0) {
        await sql.query(
          `UPDATE message_threads SET unread_client = 0
           WHERE id = $1 AND client_id = ANY($2)`,
          [id, myIds],
        );
        thread.unread_client = 0;
      }
      return ok(res, {
        thread: { ...serializeThread(thread), businessName: membership?.businessName },
        messages: msgs.rows.map(serializeMessage),
      });
    }

    if (req.method === 'POST') {
      // Block writes when the business has set the thread to broadcast-only.
      if (thread.mode === 'one-way') {
        return badRequest(res, 'This conversation is read-only');
      }
      const body = await readBody(req);
      const text = (body.text || '').toString().trim();
      if (!text) return badRequest(res, 'Message text is required');
      if (text.length > 4000) return badRequest(res, 'Message is too long');

      const inserted = await sql`
        INSERT INTO messages (thread_id, sender, text)
        VALUES (${id}, 'client', ${text})
        RETURNING *
      `;
      const preview = text.slice(0, 200);
      // Defense-in-depth: thread ownership is verified by the SELECT above,
      // but re-scope the UPDATE to client_id = ANY(myIds) so a future
      // regression can't bump the unread counter on someone else's thread.
      await sql.query(
        `UPDATE message_threads SET
           last_message_at = NOW(),
           last_message_preview = $1,
           unread_biz = unread_biz + 1
         WHERE id = $2 AND client_id = ANY($3)`,
        [preview, id, myIds],
      );
      // Notify the workspace owner (best-effort).
      notifyOwnerSafe({
        workspaceId: thread.workspace_id,
        type: 'messages',
        payload: {
          title: `Message from ${thread.client_name || 'a client'}`,
          body: preview,
          url: `/messages/${id}`,
          tag: `thread-${id}`,
        },
      });
      return created(res, { message: serializeMessage(inserted.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

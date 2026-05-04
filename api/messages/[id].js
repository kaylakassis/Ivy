// /api/messages/:id
//   GET    → list messages in thread (with thread metadata) + clears unread_biz
//   POST   → append a new message from the owner ({ text })
//   PATCH  → update mode ('two-way'|'one-way') or markRead:true

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { fetchOwnedThread, serializeThread, serializeMessage } from '../_lib/messages.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from "../_lib/security.js";

const VALID_MODES = new Set(['two-way', 'one-way']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const thread = await fetchOwnedThread({ id, workspaceId });
    if (!thread) return notFound(res, 'Thread not found');

    if (req.method === 'GET') {
      const msgs = await sql`
        SELECT * FROM messages WHERE thread_id = ${id} ORDER BY created_at
      `;
      // Mark thread read for the owner side. Re-scope to workspace_id for
      // defense-in-depth (matches the POST/PATCH paths below).
      if (thread.unread_biz > 0) {
        await sql`UPDATE message_threads SET unread_biz = 0 WHERE id = ${id} AND workspace_id = ${workspaceId}`;
        thread.unread_biz = 0;
      }
      return ok(res, {
        thread: serializeThread(thread),
        messages: msgs.rows.map(serializeMessage),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const text = (body.text || '').toString().trim();
      if (!text) return badRequest(res, 'Message text is required');
      if (text.length > 4000) return badRequest(res, 'Message is too long');

      const inserted = await sql`
        INSERT INTO messages (thread_id, sender, text)
        VALUES (${id}, 'biz', ${text})
        RETURNING *
      `;
      const preview = text.slice(0, 200);
      // Defense-in-depth: thread ownership is already verified by
      // fetchOwnedThread above, but include workspace_id on the UPDATE so
      // a future regression in the ownership check can't open a leak.
      await sql`
        UPDATE message_threads SET
          last_message_at = NOW(),
          last_message_preview = ${preview},
          unread_client = unread_client + 1
        WHERE id = ${id} AND workspace_id = ${workspaceId}
      `;
      return created(res, { message: serializeMessage(inserted.rows[0]) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('mode' in body) {
        if (!VALID_MODES.has(body.mode)) return badRequest(res, 'Invalid mode');
        push('mode', body.mode);
      }
      if (body.markRead === true) {
        push('unread_biz', 0);
      }

      if (sets.length === 0) return ok(res, { thread: serializeThread(thread) });

      values.push(id, workspaceId);
      const queryText = `
        UPDATE message_threads SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      // Re-attach client info for serialization
      const updated = { ...rows[0], client_name: thread.client_name, client_email: thread.client_email };
      return ok(res, { thread: serializeThread(updated) });
    }

    return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

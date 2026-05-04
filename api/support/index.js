// User-facing support chat.
//   GET  /api/support — fetch (or implicitly create) the caller's thread
//                       + last 100 messages. Marks unread_user = 0.
//   POST /api/support  { text } — append a user message.
//
// Admins use /api/admin/support (separate file) so we can keep the
// auth + index conventions clean.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_LEN = 4000;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const thread = await ensureThread(user.id);
      if (thread.unread_user > 0) {
        await sql`UPDATE support_threads SET unread_user = 0 WHERE id = ${thread.id}`;
        thread.unread_user = 0;
      }
      const msgs = await sql`
        SELECT id, sender, text, created_at FROM support_messages
        WHERE thread_id = ${thread.id} ORDER BY created_at ASC LIMIT 100
      `;
      return ok(res, { thread: serializeThread(thread), messages: msgs.rows });
    }

    if (req.method === 'POST') {
      const { text } = await readBody(req);
      const t = (text || '').toString().trim();
      if (!t) return badRequest(res, 'Message text is required');
      if (t.length > MAX_LEN) return badRequest(res, 'Message too long');

      const thread = await ensureThread(user.id);
      const ins = await sql`
        INSERT INTO support_messages (thread_id, sender, text)
        VALUES (${thread.id}, 'user', ${t})
        RETURNING id, sender, text, created_at
      `;
      const preview = t.slice(0, 200);
      await sql`
        UPDATE support_threads SET
          last_message_at = NOW(),
          last_message_preview = ${preview},
          unread_admin = unread_admin + 1,
          status = 'open'
        WHERE id = ${thread.id}
      `;
      return created(res, { message: ins.rows[0] });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function ensureThread(userId) {
  const r = await sql`
    INSERT INTO support_threads (user_id) VALUES (${userId})
    ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING *
  `;
  return r.rows[0];
}

function serializeThread(t) {
  return {
    id: t.id,
    status: t.status,
    unreadUser: t.unread_user,
    unreadAdmin: t.unread_admin,
    lastMessageAt: t.last_message_at,
    lastPreview: t.last_message_preview || '',
  };
}

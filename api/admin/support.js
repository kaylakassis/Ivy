// Admin-facing support inbox.
//   GET  /api/admin/support
//        Returns every thread with the user joined for display.
//   GET  /api/admin/support?threadId=X
//        Returns one thread + its last 200 messages, marking
//        unread_admin = 0.
//   POST /api/admin/support  { threadId, text }
//        Append an admin reply.
//   PATCH /api/admin/support  { threadId, status }
//        Toggle 'open' / 'closed'.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { sendPushToUser } from '../_lib/push.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_LEN = 4000;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (req.method === 'GET') {
      const threadId = req.query.threadId ? String(req.query.threadId) : null;
      if (threadId) return getOne(threadId, res);
      return listAll(res);
    }
    if (req.method === 'POST') return reply(req, res);
    if (req.method === 'PATCH') return setStatus(req, res);
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function listAll(res) {
  const { rows } = await sql`
    SELECT t.*, u.email AS user_email, u.name AS user_name
    FROM support_threads t
    JOIN users u ON u.id = t.user_id
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
    LIMIT 200
  `;
  return ok(res, {
    threads: rows.map((r) => ({
      id: r.id,
      status: r.status,
      unreadAdmin: r.unread_admin,
      unreadUser:  r.unread_user,
      lastMessageAt: r.last_message_at,
      lastPreview:   r.last_message_preview || '',
      user: { id: r.user_id, email: r.user_email, name: r.user_name },
    })),
  });
}

async function getOne(threadId, res) {
  const r = await sql`
    SELECT t.*, u.email AS user_email, u.name AS user_name
    FROM support_threads t JOIN users u ON u.id = t.user_id
    WHERE t.id = ${threadId}
  `;
  if (r.rows.length === 0) return badRequest(res, 'Thread not found');
  const t = r.rows[0];
  if (t.unread_admin > 0) {
    await sql`UPDATE support_threads SET unread_admin = 0 WHERE id = ${threadId}`;
    t.unread_admin = 0;
  }
  const msgs = await sql`
    SELECT id, sender, text, created_at FROM support_messages
    WHERE thread_id = ${threadId} ORDER BY created_at ASC LIMIT 200
  `;
  return ok(res, {
    thread: {
      id: t.id, status: t.status,
      unreadAdmin: t.unread_admin, unreadUser: t.unread_user,
      lastMessageAt: t.last_message_at, lastPreview: t.last_message_preview || '',
      user: { id: t.user_id, email: t.user_email, name: t.user_name },
    },
    messages: msgs.rows,
  });
}

async function reply(req, res) {
  const { threadId, text } = await readBody(req);
  if (!threadId) return badRequest(res, 'threadId is required');
  const t = (text || '').toString().trim();
  if (!t) return badRequest(res, 'Message text is required');
  if (t.length > MAX_LEN) return badRequest(res, 'Message too long');

  const tr = await sql`SELECT user_id FROM support_threads WHERE id = ${threadId}`;
  if (tr.rows.length === 0) return badRequest(res, 'Thread not found');

  // Audit: admin replies to user support threads are the staffing
  // surface; need a trail for reviewing how an issue was handled.
  const actor = await getAdminActor(req);
  await recordAudit(req, {
    actor, targetUserId: tr.rows[0].user_id,
    action: 'admin.support.reply',
    meta: { threadId, length: t.length },
  });

  const ins = await sql`
    INSERT INTO support_messages (thread_id, sender, text)
    VALUES (${threadId}, 'admin', ${t})
    RETURNING id, sender, text, created_at
  `;
  const preview = t.slice(0, 200);
  await sql`
    UPDATE support_threads SET
      last_message_at = NOW(),
      last_message_preview = ${preview},
      unread_user = unread_user + 1
    WHERE id = ${threadId}
  `;

  // Best-effort push to the user so they know support replied.
  sendPushToUser({
    userId: tr.rows[0].user_id,
    type: 'support',
    payload: {
      title: 'Ivy Support replied',
      body: preview,
      url: '/account?support=1',
      tag: `support-${threadId}`,
    },
  }).catch(() => { /* swallow */ });

  return created(res, { message: ins.rows[0] });
}

async function setStatus(req, res) {
  const { threadId, status } = await readBody(req);
  if (!threadId) return badRequest(res, 'threadId is required');
  if (status !== 'open' && status !== 'closed') return badRequest(res, 'Invalid status');
  await sql`UPDATE support_threads SET status = ${status}, updated_at = NOW() WHERE id = ${threadId}`;
  return ok(res, { ok: true });
}

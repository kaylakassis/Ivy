// /api/ivy
//   GET  → list sessions + workspace context (the "what Ivy sees" panel)
//   POST → send a message. If body.sessionId is missing, a new session is
//          created from the first message's title. Server generates the reply
//          (mock now, real Anthropic later) and persists both turns.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeSession, serializeMessage, workspaceContext,
  generateReply, fetchOwnedSession, getDailyUsage,
} from '../_lib/ivy.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_MESSAGE_CHARS = 4000;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const sessions = await sql`
        SELECT * FROM ivy_sessions WHERE workspace_id = ${workspaceId}
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 100
      `;
      const context = await workspaceContext(workspaceId);
      // Cheap env-var probe so the UI can show a "mock mode" warning even
      // before the user has sent their first message. Doesn't actually
      // call Anthropic — that happens on POST.
      const hasKey = !!process.env.ANTHROPIC_API_KEY;
      const usage = await getDailyUsage(workspaceId);
      return ok(res, {
        sessions: sessions.rows.map((r) => serializeSession(r)),
        context,
        mode: hasKey ? 'live' : 'mock',
        modeError: hasKey ? null : 'no-api-key',
        usage,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const text = (body.text || '').toString().trim();
      if (!text) return badRequest(res, 'Message is required');
      if (text.length > MAX_MESSAGE_CHARS) return badRequest(res, 'Message too long');

      let session;
      if (body.sessionId) {
        session = await fetchOwnedSession({ id: body.sessionId, workspaceId });
        if (!session) return badRequest(res, 'Unknown session');
      } else {
        const title = text.slice(0, 60).replace(/\s+/g, ' ');
        const ins = await sql`
          INSERT INTO ivy_sessions (workspace_id, title)
          VALUES (${workspaceId}, ${title})
          RETURNING *
        `;
        session = ins.rows[0];
      }

      // Fetch prior turns BEFORE inserting the new user message so the
      // history we pass to Claude doesn't include the message we're about
      // to respond to (we pass it as `text` separately).
      const priorMsgs = await sql`
        SELECT role, text FROM ivy_messages
        WHERE session_id = ${session.id}
        ORDER BY created_at ASC
        LIMIT 40
      `;
      const history = priorMsgs.rows.map((r) => ({ role: r.role, text: r.text }));

      const userMsg = await sql`
        INSERT INTO ivy_messages (session_id, role, text)
        VALUES (${session.id}, 'me', ${text})
        RETURNING *
      `;

      const ctx = await workspaceContext(workspaceId);
      const reply = await generateReply(text, ctx, history, workspaceId);
      const replyText = reply.text;

      const ivyMsg = await sql`
        INSERT INTO ivy_messages (session_id, role, text)
        VALUES (${session.id}, 'ivy', ${replyText})
        RETURNING *
      `;

      const preview = replyText.slice(0, 120);
      const upd = await sql`
        UPDATE ivy_sessions
        SET last_message_at = NOW(), last_message_preview = ${preview}, updated_at = NOW()
        WHERE id = ${session.id}
        RETURNING *
      `;

      const usage = await getDailyUsage(workspaceId);
      return ok(res, {
        session: serializeSession(upd.rows[0]),
        messages: [serializeMessage(userMsg.rows[0]), serializeMessage(ivyMsg.rows[0])],
        context: ctx,
        mode: reply.mode,
        modeError: reply.error || null,
        usage,
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

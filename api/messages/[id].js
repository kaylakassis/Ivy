// /api/messages/:id
//   GET    → list messages in thread (with thread metadata) + clears unread_biz
//   POST   → append a new message from the owner ({ text })
//   PATCH  → update mode ('two-way'|'one-way') or markRead:true

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { fetchOwnedThread, serializeThread, serializeMessage } from '../_lib/messages.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { requireSameOrigin } from "../_lib/security.js";
import { notifyClientSafe } from '../_lib/push.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { appUrl } from '../_lib/tokens.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
      // Defense-in-depth: re-scope by JOINing message_threads + filtering
      // workspace_id in the same query. fetchOwnedThread above already
      // verified ownership, but if a future refactor accidentally drops
      // that guard the JOIN here keeps the leak path closed.
      const msgs = await sql`
        SELECT * FROM (
          SELECT m.*
            FROM messages m
            JOIN message_threads t ON t.id = m.thread_id
           WHERE m.thread_id = ${id}
             AND t.workspace_id = ${workspaceId}
           ORDER BY m.created_at DESC
           LIMIT 500
        ) sub
        ORDER BY created_at ASC
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
      if (!(await requireActiveSubscription(workspaceId, req, res))) return;
      // Bracket the entire send in idempotency. Mobile messaging is the
      // most retry-prone path: phone clients on flaky LTE re-send the
      // same message when the spinner hangs, creating duplicate rows +
      // duplicate push notifications. Idempotency-Key from the client
      // collapses retries back to one logical send.
      const idemp = await withIdempotency(req, user.id, async () => {
        return await sendMessage();
      });
      if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
      return res.status(idemp.status).json(idemp.body);

      async function sendMessage() {
      const body = await readBody(req);
      const text = (body.text || '').toString().trim();
      // Voice memos send an empty text (or a transcript) plus an audio
      // attachment. Either text or at least one attachment must be
      // present — both empty would be a no-op.
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
      const attachments = rawAttachments
        .map((a) => ({
          url: String(a?.url || '').slice(0, 1000),
          type: String(a?.type || '').slice(0, 80),
          name: a?.name ? String(a.name).slice(0, 200) : null,
          durationMs: Number.isFinite(Number(a?.durationMs)) ? Number(a.durationMs) : null,
        }))
        .filter((a) => a.url && a.type);
      if (!text && attachments.length === 0) {
        return { status: 400, body: { error: 'Message text or attachment is required' } };
      }
      if (text.length > 4000) return { status: 400, body: { error: 'Message is too long' } };

      const inserted = await sql`
        INSERT INTO messages (thread_id, sender, text, attachments)
        VALUES (${id}, 'biz', ${text}, ${JSON.stringify(attachments)}::jsonb)
        RETURNING *
      `;
      const audioOnly = !text && attachments.some((a) => a.type.startsWith('audio/'));
      const preview = (text || (audioOnly ? '🎙️ Voice message' : 'Attachment')).slice(0, 200);
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
      // Push to the client (no-op if they haven't claimed their portal
      // account or haven't enabled push). Awaited because Vercel kills
      // un-awaited fetches the moment the response is sent — fire-and-
      // forget here means the push silently drops on the no-email path.
      await notifyClientSafe({
        clientId: thread.client_id,
        type: 'messages',
        payload: {
          title: 'New message',
          body: preview,
          url: `/me/messages/${id}`,
          tag: `thread-${id}`,
        },
      });

      // Email the client too. Critical for prospects who messaged
      // through the public contact form before claiming a THRYVE
      // portal account — without this, owner replies would just sit
      // in their THRYVE inbox where the prospect can't see them.
      // For clients with portal accounts the email also acts as a
      // backup channel (push may be disabled / dismissed).
      if (thread.client_email) {
        try {
          const branding = await fetchBranding(workspaceId);
          const ownerName = branding.businessName || 'your business';
          const portalUrl = thread.client_user_id
            ? `${appUrl()}/me/messages/${id}`
            : `${appUrl()}/signup?email=${encodeURIComponent(thread.client_email)}`;
          await sendEmailToClient({
            clientId: thread.client_id, type: 'messages',
            to: thread.client_email,
            subject: `New message from ${ownerName}`,
            // Reply-To routes the prospect's email-reply directly to
            // the owner so the conversation can continue even before
            // they claim a portal account.
            replyTo: branding.replyTo,
            html: emailShell({
              heading: 'You have a new message',
              body: `<p>Hi ${escapeHtml((thread.client_name || '').split(/\s+/)[0] || 'there')},</p>
                <p><strong>${escapeHtml(branding.businessName || 'Your business')}</strong> sent you a message:</p>
                <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #C7BFA8;background:#F6F5F1;border-radius:6px;font-size:14px;line-height:1.55;color:#3F3D38;white-space:pre-wrap;">${escapeHtml(text)}</blockquote>
                <p>You can reply by hitting Reply on this email${thread.client_user_id ? ' or by opening your THRYVE portal' : ''}.</p>`,
              ctaText: thread.client_user_id ? 'Open my portal' : 'Open in your portal',
              ctaUrl: portalUrl,
              footer: `Replying to this email reaches ${escapeHtml(branding.businessName || 'your business')} directly.`,
              branding,
            }),
          });
        } catch (mailErr) {
          // eslint-disable-next-line no-console
          console.error('[messages] reply email failed:', mailErr.message);
        }
      }

      return { status: 201, body: { message: serializeMessage(inserted.rows[0]) } };
      } // end sendMessage
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

// /api/me/threads/:id
//   GET  → list messages in this thread + clear unread_client counter
//   POST → append a new message from the client. Body { text }.
//
// Authorization: the thread's client_id must be in the user's myClientIds().
// Owners can NOT use this endpoint - they have /api/messages/:id.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { serializeThread, serializeMessage } from '../../_lib/messages.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { sendEmailToUser, emailShell } from '../../_lib/email.js';
import { fetchBranding } from '../../_lib/branding.js';
import { appUrl } from '../../_lib/tokens.js';
import { withIdempotency } from '../../_lib/idempotency.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
      // Defense-in-depth: re-scope the messages SELECT by JOINing
      // message_threads and filtering client_id = ANY(myIds). Thread
      // ownership is already verified by the SELECT above, but a future
      // regression there shouldn't open a path to read a stranger's
      // messages just because they know the thread_id.
      //
      // Pagination: hard cap at 500 most-recent messages. Long-running
      // threads with thousands of messages used to load every one on
      // every open - slow + memory-heavy on phones. Owners on the
      // /messages/:id surface get the same cap via api/messages/[id].js.
      // We return chronological order client-expected, so the LIMIT is
      // applied via a sub-select on DESC then re-ORDER'd ASC.
      const msgs = await sql.query(
        `SELECT * FROM (
           SELECT m.*
             FROM messages m
             JOIN message_threads t ON t.id = m.thread_id
            WHERE m.thread_id = $1
              AND t.client_id = ANY($2)
            ORDER BY m.created_at DESC
            LIMIT 500
         ) sub
         ORDER BY created_at ASC`,
        [id, myIds],
      );
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
      // Idempotency: mobile clients on flaky LTE re-POST the moment a
      // request spinner hangs even though the original landed. Without
      // this wrapper the thread gets the SAME message twice, the owner
      // is pushed twice, and unread_biz double-increments. Owner→client
      // direction (api/messages/[id].js) already wraps the same way.
      const idemp = await withIdempotency(req, user.id, async () => {
        return await sendMessage();
      });
      if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
      return res.status(idemp.status).json(idemp.body);

      async function sendMessage() {
      const body = await readBody(req);
      const text = (body.text || '').toString().trim();
      // Voice memos (and image / file attachments more generally) send
      // empty text plus an attachments array. Mirror the validation
      // and normalization the owner side already runs at
      // api/messages/[id].js so the two directions agree on the shape.
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
        VALUES (${id}, 'client', ${text}, ${JSON.stringify(attachments)}::jsonb)
        RETURNING *
      `;
      const audioOnly = !text && attachments.some((a) => a.type.startsWith('audio/'));
      const preview = (text || (audioOnly ? '🎙️ Voice message' : 'Attachment')).slice(0, 200);
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
      // Notify the workspace owner - push + email. Push alone leaves
      // owners with push-disabled (most do, frankly) totally blind to
      // inbound client messages. Owner→client direction at
      // api/messages/[id].js:141-172 already sends both; we mirror it.
      notifyOwnerSafe({
        workspaceId: thread.workspace_id,
        type: 'messages',
        payload: {
          title: `Message from ${thread.client_name || 'a client'}`,
          body: preview,
          url: `/messages?threadId=${id}`,
          tag: `thread-${id}`,
        },
      });
      try {
        const ownerRow = await sql`
          SELECT u.id, u.email FROM workspaces w
            JOIN users u ON u.id = w.owner_id
           WHERE w.id = ${thread.workspace_id} LIMIT 1
        `;
        const ownerEmail = ownerRow.rows[0]?.email;
        const ownerUserId = ownerRow.rows[0]?.id;
        if (ownerEmail && ownerUserId) {
          const branding = await fetchBranding(thread.workspace_id);
          await sendEmailToUser({
            userId: ownerUserId,
            type: 'messages',
            to: ownerEmail,
            subject: `New message from ${thread.client_name || thread.client_email || 'a client'}`,
            // Reply-To = the client's email so the owner can reply
            // straight from their mail client; the round-trip lands
            // back in their Ivy OS thread via the normal inbound flow.
            replyTo: thread.client_email || branding.replyTo,
            html: emailShell({
              heading: 'New message in your inbox',
              body: `<p>${escapeHtml(thread.client_name || thread.client_email || 'A client')} just sent you a message:</p>
                <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #C7BFA8;background:#F6F5F1;border-radius:6px;font-size:14px;line-height:1.55;color:#3F3D38;white-space:pre-wrap;">${escapeHtml(text)}</blockquote>
                <p>Reply from your Ivy OS Messages inbox or hit Reply on this email.</p>`,
              ctaText: 'Open conversation',
              ctaUrl: `${appUrl()}/messages?threadId=${id}`,
              footer: `Replying to this email reaches ${escapeHtml(thread.client_name || 'them')} directly.`,
              branding,
            }),
          });
        }
      } catch (mailErr) {
        // eslint-disable-next-line no-console
        console.error('[me/threads] owner email failed:', mailErr.message);
      }
      return { status: 201, body: { message: serializeMessage(inserted.rows[0]) } };
      } // end sendMessage
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

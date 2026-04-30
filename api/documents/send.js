// POST /api/documents/send  — body: { id, clientId }
//
// Generates a one-time signing token, emails the client a magic link, marks
// the document 'sent', appends an activity entry, and posts a system message
// into the chat thread between owner and client (creating the thread if
// missing).
//
// File lives next to /api/documents/[id].js as a static sibling so Vercel's
// router sends `/api/documents/send` to this file instead of the dynamic
// [id] handler.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc } from '../_lib/documents.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    const clientId = body.clientId ? String(body.clientId) : null;
    if (!id) return badRequest(res, 'id is required');
    if (!clientId) return badRequest(res, 'clientId is required');

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return badRequest(res, 'Document not found');
    if (doc.status === 'completed') return badRequest(res, 'Already completed');
    if (doc.status === 'voided')    return badRequest(res, 'Document is voided — restore first');

    const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
    if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
    const recipient = cl.rows[0];
    if (!recipient.email) return badRequest(res, 'That client has no email on file');

    // Generate a fresh signing token. Stored hashed; raw token only ever lives
    // in the email link.
    const rawToken = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const newActivity = [
      ...(doc.activity || []),
      { ts: new Date().toISOString(), kind: 'sent', text: `Sent to ${recipient.name}` },
    ];

    const updated = await sql`
      UPDATE documents SET
        recipient_client_id = ${clientId},
        recipient_name = ${recipient.name},
        recipient_email = ${recipient.email},
        status = 'sent',
        sign_token_hash = ${tokenHash},
        sent_at = NOW(),
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    const link = `${appUrl()}/sign/${encodeURIComponent(rawToken)}`;

    // Email + thread integration are best-effort: don't fail the API if either
    // hiccups (the owner can re-send from the activity drawer).
    try {
      await sendEmail({
        to: recipient.email,
        subject: `Action needed: sign "${doc.name}"`,
        html: emailShell({
          heading: 'A document needs your signature',
          body: `<p>Hi ${escapeHtml(recipient.name)},</p>
                 <p>You've been sent a document to review and sign: <b>${escapeHtml(doc.name)}</b>.</p>
                 <p>Click the button to open and sign it.</p>`,
          ctaText: 'Open and sign',
          ctaUrl: link,
          footer: `If you weren't expecting this, you can safely ignore this email.`,
        }),
      });
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[documents/send] email failed:', mailErr.message);
    }

    try {
      const threadRow = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${workspaceId}, ${clientId})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING id
      `;
      const threadId = threadRow.rows[0].id;
      const meta = { docId: doc.id, docName: doc.name };
      await sql`
        INSERT INTO messages (thread_id, sender, text, kind, meta)
        VALUES (${threadId}, 'system', ${`Document sent: ${doc.name}`}, 'doc-sent', ${JSON.stringify(meta)}::jsonb)
      `;
      const preview = `Document sent: ${doc.name}`;
      await sql`
        UPDATE message_threads SET
          last_message_at = NOW(),
          last_message_preview = ${preview},
          unread_client = unread_client + 1
        WHERE id = ${threadId}
      `;
    } catch (msgErr) {
      // eslint-disable-next-line no-console
      console.error('[documents/send] thread message failed:', msgErr.message);
    }

    return ok(res, { document: serializeDoc(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

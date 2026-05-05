// POST /api/documents/send  body: { id, recipients }
//   recipients: [{ clientId, name?, email? }, ...]   — multi-signer.
//                For backward compat with single-signer callers, also
//                accepts a single { clientId } shape.
//
// Builds a document_signers row per recipient (in order), mints a token
// for the FIRST signer only (sequential signing), emails them, and
// drops a system message in the chat thread for that first client.
// When that signer completes, /api/sign/[token] mints + emails the
// next signer's token, and so on. The final completion stamps the
// document and computes the tamper-evident hash.
//
// File lives next to /api/documents/[id].js as a static sibling so
// Vercel's router sends `/api/documents/send` to this file instead of
// the dynamic [id] handler.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc } from '../_lib/documents.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { notifyClientSafe } from '../_lib/push.js';
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
    if (!id) return badRequest(res, 'id is required');

    // Normalize input: accept either a `recipients` array OR a legacy
    // single-clientId shape. Cap at 10 signers to keep the UI sane.
    let recipients = [];
    if (Array.isArray(body.recipients) && body.recipients.length > 0) {
      recipients = body.recipients;
    } else if (body.clientId) {
      recipients = [{ clientId: body.clientId }];
    } else {
      return badRequest(res, 'recipients or clientId is required');
    }
    if (recipients.length > 10) return badRequest(res, 'Up to 10 signers per document');

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return badRequest(res, 'Document not found');
    if (doc.status === 'completed') return badRequest(res, 'Already completed');
    if (doc.status === 'voided')    return badRequest(res, 'Document is voided — restore first');
    if (doc.status === 'declined')  return badRequest(res, 'Document was declined — restore to draft first');

    // Resolve each recipient: must belong to this workspace, must have an
    // email. Build the rows we'll insert.
    const resolved = [];
    for (const r of recipients) {
      const cid = r.clientId ? String(r.clientId) : null;
      if (!cid) return badRequest(res, 'Each recipient needs a clientId');
      const cl = await sql`
        SELECT id, name, email FROM clients
        WHERE id = ${cid} AND workspace_id = ${workspaceId}
      `;
      if (cl.rows.length === 0) return badRequest(res, `Unknown client: ${cid}`);
      const c = cl.rows[0];
      const name = (r.name || c.name || '').toString().slice(0, 200);
      const email = (r.email || c.email || '').toString().toLowerCase().trim();
      if (!email) return badRequest(res, `Client ${name || cid} has no email`);
      resolved.push({ clientId: cid, name, email });
    }

    // Wipe any prior signer rows for this doc (re-sending should reset
    // signer state cleanly). Then insert fresh rows in order.
    // Defense-in-depth: scope by workspace via subquery so a future
    // regression in the fetchOwnedDoc check above can't be coerced
    // into wiping signers for someone else's document.
    await sql`
      DELETE FROM document_signers
       WHERE document_id = ${id}
         AND document_id IN (
           SELECT id FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId}
         )
    `;

    // Mint the first signer's token only. Sequential signing: each
    // signer's token is created as the previous one completes, so a
    // leaked email link never gives access out of order.
    const firstRaw  = generateRawToken(32);
    const firstHash = crypto.createHash('sha256').update(firstRaw).digest('hex');

    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const isFirst = i === 0;
      await sql`
        INSERT INTO document_signers (
          document_id, order_index, client_id, name, email,
          sign_token_hash, status
        ) VALUES (
          ${id}, ${i}, ${r.clientId}, ${r.name}, ${r.email},
          ${isFirst ? firstHash : null},
          ${isFirst ? 'awaiting' : 'pending'}
        )
      `;
    }

    const newActivity = [
      ...(doc.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'sent',
        text: `Sent to ${resolved.length} signer${resolved.length === 1 ? '' : 's'}: ${resolved.map((r) => r.name).join(', ')}`,
      },
    ];

    // Update the document. We also keep the legacy recipient_* fields
    // in sync with the FIRST signer so older code paths still display
    // a reasonable "to whom" label.
    // Wipe any stale field values from a prior signing round before
    // sending again (re-send after void/decline). We keep field
    // metadata — id/type/page/x/y/w/h/signerIndex/label/required —
    // but blank `.value` so the new signers don't see prior inputs.
    const cleanedFields = (doc.fields || []).map((f) => ({ ...f, value: '' }));
    const first = resolved[0];
    const updated = await sql`
      UPDATE documents SET
        recipient_client_id = ${first.clientId},
        recipient_name      = ${first.name},
        recipient_email     = ${first.email},
        status              = 'sent',
        sign_token_hash     = ${firstHash},
        sent_at             = NOW(),
        activity            = ${JSON.stringify(newActivity)}::jsonb,
        fields              = ${JSON.stringify(cleanedFields)}::jsonb,
        completion_hash     = NULL,
        decline_reason      = NULL,
        declined_at         = NULL,
        final_pdf_url       = NULL,
        final_pdf_blob_pathname = NULL,
        updated_at          = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    // Email + thread message for the first signer only. Subsequent
    // signers get their email when their turn comes up.
    const link = `${appUrl()}/sign/${encodeURIComponent(firstRaw)}`;
    const positionLine = resolved.length > 1
      ? `<p style="font-size:13px;color:#85827B;">You're signer 1 of ${resolved.length}. The next signer will receive their link after you finish.</p>`
      : '';
    const branding = await fetchBranding(workspaceId);
    try {
      await sendEmail({
        to: first.email,
        subject: `Action needed: sign "${doc.name}"`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: 'A document needs your signature',
          body: `<p>Hi ${escapeHtml(first.name)},</p>
                 <p>You've been sent a document to review and sign: <b>${escapeHtml(doc.name)}</b>.</p>
                 <p>Click the button to open and sign it.</p>
                 ${positionLine}`,
          ctaText: 'Open and sign',
          ctaUrl: link,
          footer: `If you weren't expecting this, you can safely ignore this email.`,
          branding,
        }),
      });
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[documents/send] email failed:', mailErr.message);
    }

    try {
      const threadRow = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${workspaceId}, ${first.clientId})
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
          last_message_at      = NOW(),
          last_message_preview = ${preview},
          unread_client        = unread_client + 1
        WHERE id = ${threadId}
      `;
    } catch (msgErr) {
      // eslint-disable-next-line no-console
      console.error('[documents/send] thread message failed:', msgErr.message);
    }

    notifyClientSafe({
      clientId: first.clientId,
      type: 'documents',
      payload: {
        title: 'Document needs your signature',
        body: doc.name,
        url: `/me/documents`,
        tag: `doc-${doc.id}`,
        requireInteraction: true,
      },
    });

    return ok(res, { document: serializeDoc(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

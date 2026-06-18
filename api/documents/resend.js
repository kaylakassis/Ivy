// POST /api/documents/resend  body: { id }
//
// Re-emails the current pending signer of a document. Mints a fresh
// sign token (invalidates the prior link), updates the signer row
// (and the legacy documents.sign_token_hash mirror), and appends an
// activity entry.
//
// Refuses if the document is completed, voided, or has no pending
// signer (e.g. already declined). For multi-signer flows, only the
// CURRENT awaiting signer gets the resend - subsequent signers
// receive their links automatically when their turn comes up.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc } from '../_lib/documents.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    // Idempotent wrap - a Resend retry used to mint a fresh token
    // every time (invalidating the prior link sent moments earlier),
    // so a double-click would race itself.
    const idemp = await withIdempotency(req, user.id, async () => doResend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doResend() {
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return { status: 400, body: { error: 'id is required' } };

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return { status: 400, body: { error: 'Document not found' } };
    if (doc.status === 'completed') return { status: 400, body: { error: 'Already signed - nothing to resend' } };
    if (doc.status === 'voided')    return { status: 400, body: { error: 'Document is voided' } };
    if (doc.status === 'draft')     return { status: 400, body: { error: "Draft hasn't been sent - use Send instead" } };
    if (doc.status === 'declined')  return { status: 400, body: { error: 'Document was declined - revise + resend a new copy' } };

    // Find the current awaiting signer. Multi-signer flow records each
    // signer in document_signers ordered by order_index; the one with
    // status='awaiting' is the active recipient.
    const { rows: signers } = await sql`
      SELECT id, client_id, name, email, order_index, status
      FROM document_signers
      WHERE document_id = ${id}
      ORDER BY order_index ASC
    `;

    let target = null;
    if (signers.length > 0) {
      target = signers.find((s) => s.status === 'awaiting');
    }
    // Legacy single-signer fallback: document carries recipient_email
    // directly and there's no document_signers row.
    if (!target && doc.recipient_email) {
      target = {
        id: null,
        client_id: doc.recipient_client_id,
        name: doc.recipient_name,
        email: doc.recipient_email,
        order_index: 0,
      };
    }
    if (!target) return { status: 400, body: { error: 'No pending signer to resend to' } };
    if (!target.email) return { status: 400, body: { error: 'Current signer has no email on file' } };

    const raw = generateRawToken(32);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (target.id) {
      await sql`UPDATE document_signers SET sign_token_hash = ${hash}, status = 'awaiting', updated_at = NOW() WHERE id = ${target.id}`;
    }
    // Keep the legacy fields on documents in sync so the owner-list
    // view + sign flow both see the latest token.
    const newActivity = [
      ...(doc.activity || []),
      { ts: new Date().toISOString(), kind: 'sent', text: `Resent to ${target.name || target.email}` },
    ];
    await sql`
      UPDATE documents SET
        recipient_client_id = ${target.client_id || null},
        recipient_name      = ${target.name || ''},
        recipient_email     = ${target.email},
        sign_token_hash     = ${hash},
        activity            = ${JSON.stringify(newActivity)}::jsonb,
        updated_at          = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;

    const link = `${appUrl()}/sign/${encodeURIComponent(raw)}`;
    const branding = await fetchBranding(workspaceId);
    const position = signers.length > 1
      ? `<p style="font-size:13px;color:#85827B;">You're signer ${target.order_index + 1} of ${signers.length}.</p>`
      : '';
    let emailWarning = null;
    try {
      await sendEmailToClient({
        clientId: target.client_id || null,
        type: 'documents',
        to: target.email,
        subject: `Reminder: please sign "${doc.name}"`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: 'Document still waiting on you',
          body: `<p>Hi ${escapeHtml(target.name || 'there')},</p>
                 <p>This is a friendly nudge - <b>${escapeHtml(doc.name)}</b> is still waiting on your signature.</p>
                 ${position}`,
          ctaText: 'Open and sign',
          ctaUrl: link,
          footer: "If you weren't expecting this, you can safely ignore.",
          branding,
        }),
      });
    } catch (mailErr) {
      console.error('[documents/resend] email failed:', mailErr.message);
      emailWarning = `We refreshed the link but the email to ${target.name || target.email} didn't go through - try again in a moment.`;
    }

    const reloaded = await fetchOwnedDoc({ id, workspaceId });
    return {
      status: 200,
      body: {
        document: serializeDoc(reloaded),
        ...(emailWarning ? { warning: emailWarning } : {}),
      },
    };
    } // end doResend
  } catch (err) {
    return serverError(res, err);
  }
}

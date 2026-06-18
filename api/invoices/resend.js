// POST /api/invoices/resend  body: { id }
//
// Re-emails an already-sent invoice to its recipient. Mints a fresh
// view token (invalidates the prior link so the most recent email
// always works), appends an activity entry, and posts a "resent"
// system message into the chat thread.
//
// Refuses if the invoice is paid, voided, or hasn't been sent yet.
// Use POST /api/invoices/send for the first send.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals } from '../_lib/finance.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    // Same idempotency rationale as invoices/send - double-clicking
    // Resend used to mint two tokens + send two reminder emails. Now
    // the Idempotency-Key header collapses retries.
    const idemp = await withIdempotency(req, user.id, async () => doResend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doResend() {
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return { status: 400, body: { error: 'id is required' } };

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return { status: 400, body: { error: 'Invoice not found' } };
    if (inv.status === 'paid')   return { status: 400, body: { error: 'Already paid - nothing to resend' } };
    if (inv.status === 'voided') return { status: 400, body: { error: 'Voided - restore before resending' } };
    if (inv.status === 'draft')  return { status: 400, body: { error: 'Draft hasn\'t been sent yet - use Send instead' } };
    if (!inv.client_email)       return { status: 400, body: { error: 'No recipient email on file' } };

    const rawToken = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const newActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'sent', text: `Resent to ${inv.client_name || inv.client_email}` },
    ];

    const updated = await sql`
      UPDATE invoices SET
        view_token_hash = ${tokenHash},
        status = 'sent',
        sent_at = NOW(),
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    const link = `${appUrl()}/invoice/${encodeURIComponent(rawToken)}`;
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName;

    let emailWarning = null;
    try {
      await sendEmailToClient({
        clientId: inv.client_id, type: 'invoices',
        to: inv.client_email,
        subject: `Reminder: Invoice ${inv.number}${business ? ' from ' + business : ''} · ${fmtMoney(totals.total)}`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: `Invoice ${inv.number}`,
          body: `<p>Hi ${escapeHtml(inv.client_name || 'there')},</p>
                 <p>${business ? escapeHtml(business) + ' is following up on' : "We're following up on"}
                    invoice <b>${escapeHtml(inv.number)}</b> for
                    <b>${fmtMoney(totals.total)}</b>${inv.due_date ? ', due ' + escapeHtml(new Date(inv.due_date).toLocaleDateString()) : ''}.</p>
                 <p>If you've already paid, please ignore - it can take a day or two to clear.</p>`,
          ctaText: 'View invoice',
          ctaUrl: link,
          footer: `Reply to this email if anything looks off.`,
          branding,
        }),
      });
    } catch (mailErr) {
      console.error('[invoices/resend] email failed:', mailErr.message);
      emailWarning = `We refreshed the link but the email didn't go through - try again in a moment.`;
    }

    try {
      if (inv.client_id) {
        const t = await sql`
          INSERT INTO message_threads (workspace_id, client_id)
          VALUES (${workspaceId}, ${inv.client_id})
          ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
          RETURNING id
        `;
        const text = `Invoice ${inv.number} resent · ${fmtMoney(totals.total)}`;
        await sql`
          INSERT INTO messages (thread_id, sender, text, kind, meta)
          VALUES (${t.rows[0].id}, 'system', ${text}, 'invoice-resent',
            ${JSON.stringify({ invoiceId: inv.id, number: inv.number })}::jsonb)
        `;
        await sql`
          UPDATE message_threads SET
            last_message_at = NOW(), last_message_preview = ${text}
          WHERE id = ${t.rows[0].id}
        `;
      }
    } catch (msgErr) {
      console.error('[invoices/resend] thread message failed:', msgErr.message);
    }

    return {
      status: 200,
      body: {
        invoice: serializeInvoice(updated.rows[0]),
        ...(emailWarning ? { warning: emailWarning } : {}),
      },
    };
    } // end doResend
  } catch (err) {
    return serverError(res, err);
  }
}

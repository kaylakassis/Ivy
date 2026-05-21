// POST /api/quotes/resend  body: { id }
//
// Re-emails an already-sent quote. Same idempotency model as
// /api/invoices/resend: mints a fresh token, marks status='sent',
// stamps sent_at, drops a system message into the chat thread.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedQuote, serializeQuote } from '../_lib/quotes.js';
import { computeTotals } from '../_lib/finance.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

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
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    const q = await fetchOwnedQuote({ id, workspaceId });
    if (!q) return badRequest(res, 'Quote not found');
    if (q.status === 'accepted') return badRequest(res, 'Already accepted');
    if (q.status === 'voided')   return badRequest(res, 'Voided — restore first');
    if (q.status === 'draft')    return badRequest(res, "Draft hasn't been sent yet — use Send instead");
    if (!q.client_email)         return badRequest(res, 'No recipient email on file');

    const rawToken = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const totals = computeTotals(q.items, q.tax_rate, q.discount);
    const newActivity = [
      ...(q.activity || []),
      { ts: new Date().toISOString(), kind: 'sent', text: `Resent to ${q.client_name || q.client_email}` },
    ];

    const updated = await sql`
      UPDATE quotes SET
        view_token_hash = ${tokenHash},
        status          = 'sent',
        sent_at         = NOW(),
        activity        = ${JSON.stringify(newActivity)}::jsonb,
        updated_at      = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    const link = `${appUrl()}/quote/${encodeURIComponent(rawToken)}`;
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName;

    let emailWarning = null;
    try {
      await sendEmailToClient({
        clientId: q.client_id, type: 'invoices',
        to: q.client_email,
        subject: `Reminder: Estimate ${q.number}${business ? ' from ' + business : ''} · ${fmtMoney(totals.total)}`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: `Estimate ${q.number}`,
          body: `<p>Hi ${escapeHtml(q.client_name || 'there')},</p>
                 <p>${business ? escapeHtml(business) + ' is following up on' : "We're following up on"}
                    estimate <b>${escapeHtml(q.number)}</b> for
                    <b>${fmtMoney(totals.total)}</b>${q.expiry_date ? `, valid through ${escapeHtml(new Date(q.expiry_date).toLocaleDateString())}` : ''}.</p>
                 <p>Open it to review the line items and accept (or decline).</p>`,
          ctaText: 'View estimate',
          ctaUrl: link,
          footer: `Reply to this email if anything looks off.`,
          branding,
        }),
      });
    } catch (mailErr) {
      console.error('[quotes/resend] email failed:', mailErr.message);
      emailWarning = `We refreshed the link but the email didn't go through — try again in a moment.`;
    }

    try {
      if (q.client_id) {
        const t = await sql`
          INSERT INTO message_threads (workspace_id, client_id)
          VALUES (${workspaceId}, ${q.client_id})
          ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
          RETURNING id
        `;
        const text = `Estimate ${q.number} resent · ${fmtMoney(totals.total)}`;
        await sql`
          INSERT INTO messages (thread_id, sender, text, kind, meta)
          VALUES (${t.rows[0].id}, 'system', ${text}, 'quote-resent',
            ${JSON.stringify({ quoteId: q.id, number: q.number })}::jsonb)
        `;
        await sql`
          UPDATE message_threads SET
            last_message_at = NOW(), last_message_preview = ${text}
          WHERE id = ${t.rows[0].id}
        `;
      }
    } catch (msgErr) {
      console.error('[quotes/resend] thread message failed:', msgErr.message);
    }

    return ok(res, {
      quote: serializeQuote(updated.rows[0]),
      ...(emailWarning ? { warning: emailWarning } : {}),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

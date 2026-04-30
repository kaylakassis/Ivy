// POST /api/invoices/send  body: { id, clientId? }
// Generates a one-time view token, emails the recipient a magic link, marks
// the invoice 'sent', appends activity, posts a 'invoice-sent' system message
// into the chat thread (creating one if missing).
//
// Lives as a static sibling to /api/invoices/[id].js (Vercel routing
// disambiguates by static-first).

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals } from '../_lib/finance.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return badRequest(res, 'Invoice not found');
    if (inv.status === 'paid')   return badRequest(res, 'Already paid');
    if (inv.status === 'voided') return badRequest(res, 'Voided — restore first');

    // Resolve recipient. Allow override clientId in body, otherwise use stored.
    let clientId = body.clientId ? String(body.clientId) : inv.client_id;
    let recipientName  = inv.client_name;
    let recipientEmail = inv.client_email;

    if (clientId) {
      const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
      recipientName  = cl.rows[0].name;
      recipientEmail = cl.rows[0].email;
    }
    if (!recipientEmail) return badRequest(res, 'Recipient has no email on file');

    // Token: stored hashed; raw lives only in the email link.
    const rawToken = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const newActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'sent', text: `Sent to ${recipientName}` },
    ];

    const updated = await sql`
      UPDATE invoices SET
        client_id = ${clientId},
        client_name = ${recipientName},
        client_email = ${recipientEmail},
        view_token_hash = ${tokenHash},
        status = 'sent',
        sent_at = NOW(),
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    const link = `${appUrl()}/invoice/${encodeURIComponent(rawToken)}`;
    const business = (await sql`SELECT biz_name FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0]?.biz_name;

    // Email — best-effort; don't fail the call.
    try {
      await sendEmail({
        to: recipientEmail,
        subject: `Invoice ${inv.number}${business ? ' from ' + business : ''} · ${fmtMoney(totals.total)}`,
        html: emailShell({
          heading: `Invoice ${inv.number}`,
          body: `<p>Hi ${escapeHtml(recipientName)},</p>
                 <p>${business ? escapeHtml(business) + ' has' : "You've"} sent you an invoice for
                    <b>${fmtMoney(totals.total)}</b>${inv.due_date ? ', due ' + escapeHtml(new Date(inv.due_date).toLocaleDateString()) : ''}.</p>
                 <p>Open the invoice to review the line items.</p>`,
          ctaText: 'View invoice',
          ctaUrl: link,
          footer: `Reply to this email if anything looks off.`,
        }),
      });
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[invoices/send] email failed:', mailErr.message);
    }

    // Best-effort: post into the chat thread.
    try {
      if (clientId) {
        const t = await sql`
          INSERT INTO message_threads (workspace_id, client_id)
          VALUES (${workspaceId}, ${clientId})
          ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
          RETURNING id
        `;
        const threadId = t.rows[0].id;
        const meta = { invoiceId: inv.id, number: inv.number, total: totals.total };
        const text = `Invoice ${inv.number} sent · ${fmtMoney(totals.total)}`;
        await sql`
          INSERT INTO messages (thread_id, sender, text, kind, meta)
          VALUES (${threadId}, 'system', ${text}, 'invoice-sent', ${JSON.stringify(meta)}::jsonb)
        `;
        await sql`
          UPDATE message_threads SET
            last_message_at = NOW(),
            last_message_preview = ${text},
            unread_client = unread_client + 1
          WHERE id = ${threadId}
        `;
      }
    } catch (msgErr) {
      // eslint-disable-next-line no-console
      console.error('[invoices/send] thread message failed:', msgErr.message);
    }

    return ok(res, { invoice: serializeInvoice(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

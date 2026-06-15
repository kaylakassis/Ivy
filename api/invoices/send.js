// POST /api/invoices/send  body: { id, clientId? }
// Generates a one-time view token, emails the recipient a magic link, marks
// the invoice 'sent', appends activity, posts a 'invoice-sent' system message
// into the chat thread (creating one if missing).
//
// Lives as a static sibling to /api/invoices/[id].js (Vercel routing
// disambiguates by static-first).

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals } from '../_lib/finance.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { notifyClientSafe } from '../_lib/push.js';
import { fetchBranding } from '../_lib/branding.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';
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
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    // Idempotent wrap. Owners double-clicking Send or hitting a flaky
    // network used to fire the invoice email twice with different
    // tokens — only the second worked, but both landed in the
    // client's inbox + activity log. Now an Idempotency-Key header
    // (api.js sets one on every mutating POST) collapses retries to
    // the cached response without re-sending.
    const idemp = await withIdempotency(req, user.id, async () => doSend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doSend() {
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return { status: 400, body: { error: 'id is required' } };

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return { status: 400, body: { error: 'Invoice not found' } };
    if (inv.status === 'paid')   return { status: 400, body: { error: 'Already paid' } };
    if (inv.status === 'voided') return { status: 400, body: { error: 'Voided — restore first' } };

    // Resolve recipient. Allow override clientId in body, otherwise use stored.
    let clientId = body.clientId ? String(body.clientId) : inv.client_id;
    let recipientName  = inv.client_name;
    let recipientEmail = inv.client_email;

    if (clientId) {
      const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (cl.rows.length === 0) return { status: 400, body: { error: 'Unknown client' } };
      recipientName  = cl.rows[0].name;
      recipientEmail = cl.rows[0].email;
    }
    if (!recipientEmail) return { status: 400, body: { error: 'Recipient has no email on file' } };

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
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName;

    // Email — best-effort; don't fail the call.
    try {
      await sendEmailToClient({
        clientId, type: 'invoices',
        to: recipientEmail,
        subject: `Invoice ${inv.number}${business ? ' from ' + business : ''} · ${fmtMoney(totals.total)}`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: `Invoice ${inv.number}`,
          body: `<p>Hi ${escapeHtml(recipientName)},</p>
                 <p>${business ? escapeHtml(business) + ' has' : "You've"} sent you an invoice for
                    <b>${fmtMoney(totals.total)}</b>${inv.due_date ? ', due ' + escapeHtml(new Date(inv.due_date).toLocaleDateString()) : ''}.</p>
                 <p>Open the invoice to review the line items.</p>`,
          ctaText: 'View invoice',
          ctaUrl: link,
          footer: `Reply to this email if anything looks off.`,
          branding,
        }),
      });
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[invoices/send] email failed:', mailErr.message);
    }

    // Client-side push so the email isn't the only signal. Helpful for
    // clients who've claimed their portal — they get the invoice in
    // their pocket without inbox-fatigue gambling.
    if (clientId) {
      notifyClientSafe({
        clientId, type: 'payments',
        payload: {
          title: `Invoice from ${business || 'your provider'}`,
          body: `${inv.number} · ${fmtMoney(totals.total)}${inv.due_date ? ` · due ${new Date(inv.due_date).toLocaleDateString()}` : ''}`,
          url: '/me/invoices',
          tag: `invoice-sent-${inv.id}`,
        },
      });
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

    return { status: 200, body: { invoice: serializeInvoice(updated.rows[0]) } };
    } // end doSend
  } catch (err) {
    return serverError(res, err);
  }
}

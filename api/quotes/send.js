// POST /api/quotes/send  body: { id, clientId? }
//
// Mints a public view token for the quote, marks it 'sent', emails
// the client through the workspace's branded shell, and drops a
// system message in their chat thread. Mirrors /api/invoices/send.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedQuote, serializeQuote } from '../_lib/quotes.js';
import { quoteTotals } from '../_lib/quotes.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
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
    // Idempotent wrap - same rationale as invoices/send. A double-click
    // on the owner's "Send estimate" button used to mint two tokens +
    // fire two emails; only the second was visible to the recipient.
    const idemp = await withIdempotency(req, user.id, async () => doSend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doSend() {
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return { status: 400, body: { error: 'id is required' } };

    const q = await fetchOwnedQuote({ id, workspaceId });
    if (!q) return { status: 400, body: { error: 'Quote not found' } };
    if (q.status === 'accepted') return { status: 400, body: { error: 'Already accepted' } };
    if (q.status === 'voided')   return { status: 400, body: { error: 'Voided - restore first' } };

    let clientId = body.clientId ? String(body.clientId) : q.client_id;
    let recipientName  = q.client_name;
    let recipientEmail = q.client_email;
    if (clientId) {
      const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (cl.rows.length === 0) return { status: 400, body: { error: 'Unknown client' } };
      recipientName  = cl.rows[0].name;
      recipientEmail = cl.rows[0].email;
    }
    if (!recipientEmail) return { status: 400, body: { error: 'Recipient has no email on file' } };

    const rawToken = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    // Included-items-only total (quoteTotals) - computeTotals over ALL
    // items quoted a higher number in the email than the client sees and
    // accepts on the public quote page (optional items excluded there).
    const totals = quoteTotals(q.items, q.tax_rate, q.discount);
    const newActivity = [
      ...(q.activity || []),
      { ts: new Date().toISOString(), kind: 'sent', text: `Sent to ${recipientName}` },
    ];

    const updated = await sql`
      UPDATE quotes SET
        client_id       = ${clientId},
        client_name     = ${recipientName},
        client_email    = ${recipientEmail},
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

    try {
      await sendEmailToClient({
        clientId, type: 'invoices',
        to: recipientEmail,
        subject: `Estimate ${q.number}${business ? ' from ' + business : ''} · ${fmtMoney(totals.total)}`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: `Estimate ${q.number}`,
          body: `<p>Hi ${escapeHtml(recipientName)},</p>
                 <p>${business ? escapeHtml(business) + ' has' : "You've"} sent you an estimate for
                    <b>${fmtMoney(totals.total)}</b>${q.expiry_date ? `, valid through ${escapeHtml(new Date(q.expiry_date).toLocaleDateString())}` : ''}.</p>
                 <p>Open it to review the line items and accept (or decline).</p>`,
          ctaText: 'View estimate',
          ctaUrl: link,
          footer: `Reply to this email if anything looks off.`,
          branding,
        }),
      });
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[quotes/send] email failed:', mailErr.message);
    }

    // Best-effort thread message + system note.
    try {
      if (clientId) {
        const t = await sql`
          INSERT INTO message_threads (workspace_id, client_id)
          VALUES (${workspaceId}, ${clientId})
          ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
          RETURNING id
        `;
        const threadId = t.rows[0].id;
        const text = `Estimate ${q.number} sent · ${fmtMoney(totals.total)}`;
        const meta = { quoteId: q.id, number: q.number, total: totals.total };
        await sql`
          INSERT INTO messages (thread_id, sender, text, kind, meta)
          VALUES (${threadId}, 'system', ${text}, 'quote-sent', ${JSON.stringify(meta)}::jsonb)
        `;
        await sql`
          UPDATE message_threads SET
            last_message_at      = NOW(),
            last_message_preview = ${text},
            unread_client        = unread_client + 1
          WHERE id = ${threadId}
        `;
      }
    } catch (msgErr) {
      // eslint-disable-next-line no-console
      console.error('[quotes/send] thread message failed:', msgErr.message);
    }

    return { status: 200, body: { quote: serializeQuote(updated.rows[0]) } };
    } // end doSend
  } catch (err) {
    return serverError(res, err);
  }
}

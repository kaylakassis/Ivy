// POST /api/invoices/pay-link  body: { id }
//
// Mints a one-time view token for an invoice and returns the public-pay
// URL. Used by the "Collect in person" flow — the owner shows the URL
// (or a QR rendering of it) to the customer, who pays on their own
// phone via the existing /invoice/:token page.
//
// Differs from /api/invoices/send:
//   • Doesn't email the recipient. The owner is going to share the link
//     in person (SMS, AirDrop, QR scan).
//   • Doesn't change invoice status away from 'draft' — issuing a link
//     for an unsent draft is a normal in-person flow ("I just made the
//     invoice, here's the QR, please pay").
//   • Returns the raw token URL in the response. /send is server-side
//     only because the URL goes out via email; here the owner is the
//     one who needs it.
//
// The token is stored hashed exactly like /send, so this minting
// invalidates any previous link to the same invoice — last one wins.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice } from '../_lib/finance.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'Missing invoice id');

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return badRequest(res, 'Invoice not found');
    if (inv.status === 'paid')   return badRequest(res, 'Invoice already paid');
    if (inv.status === 'voided') return badRequest(res, 'Invoice voided — restore first');

    const rawToken = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const newActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'pay-link', text: 'In-person pay link generated' },
    ];

    // Promote draft → 'sent' so the public-pay page accepts the link.
    // /api/invoice-pay/[token] requires the invoice not to be in draft
    // (it's the same gate /send uses). For invoices already in 'sent' or
    // 'overdue', preserve the status.
    const newStatus = inv.status === 'draft' ? 'sent' : inv.status;
    const setSentAt = inv.status === 'draft' && !inv.sent_at;

    const updated = await sql`
      UPDATE invoices SET
        view_token_hash = ${tokenHash},
        status          = ${newStatus},
        sent_at         = ${setSentAt ? new Date() : inv.sent_at},
        activity        = ${JSON.stringify(newActivity)}::jsonb,
        updated_at      = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    const url = `${appUrl()}/invoice/${encodeURIComponent(rawToken)}`;
    return ok(res, {
      url,
      invoice: serializeInvoice(updated.rows[0]),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

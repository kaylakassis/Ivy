// POST /api/invoices/mark-paid  body: { id, method? }
// Manually marks an invoice paid. Real Stripe integration lands in phase B —
// for now this is the owner saying "yes, the payment came through".

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  fetchOwnedInvoice, serializeInvoice, computeTotals, VALID_PAID_METHOD,
} from '../_lib/finance.js';
import { notifyInvoicePaid } from '../_lib/invoiceNotify.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

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

    const method = body.method && VALID_PAID_METHOD.has(body.method) ? body.method : 'other';

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return badRequest(res, 'Invoice not found');
    if (inv.status === 'paid')   return badRequest(res, 'Already paid');
    if (inv.status === 'voided') return badRequest(res, 'Voided — restore first');

    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const newActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'paid', text: `Paid by ${method} · ${fmtMoney(totals.total)}` },
    ];

    const updated = await sql`
      UPDATE invoices SET
        status = 'paid',
        paid_at = NOW(),
        paid_method = ${method},
        paid_amount = ${totals.total},
        view_token_hash = NULL,
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    // Best-effort thread message.
    try {
      if (inv.client_id) {
        const t = await sql`
          INSERT INTO message_threads (workspace_id, client_id)
          VALUES (${workspaceId}, ${inv.client_id})
          ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
          RETURNING id
        `;
        const threadId = t.rows[0].id;
        const meta = { invoiceId: inv.id, number: inv.number, total: totals.total };
        const text = `Invoice ${inv.number} paid · ${fmtMoney(totals.total)}`;
        await sql`
          INSERT INTO messages (thread_id, sender, text, kind, meta)
          VALUES (${threadId}, 'system', ${text}, 'invoice-paid', ${JSON.stringify(meta)}::jsonb)
        `;
        await sql`
          UPDATE message_threads SET
            last_message_at = NOW(),
            last_message_preview = ${text}
          WHERE id = ${threadId}
        `;
      }
    } catch (msgErr) {
      // eslint-disable-next-line no-console
      console.error('[invoices/mark-paid] thread message failed:', msgErr.message);
    }

    // Fire-and-forget receipt email to the client.
    notifyInvoicePaid({
      workspaceId, invoiceId: id, totalAmount: totals.total, method,
    });

    return ok(res, { invoice: serializeInvoice(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

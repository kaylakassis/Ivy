// POST /api/invoices/void  body: { id }
// Owner voids the invoice; the public view link stops working.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice } from '../_lib/finance.js';
import { restoreStock } from '../_lib/products.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

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
    if (!id) return badRequest(res, 'id is required');

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return badRequest(res, 'Invoice not found');
    if (inv.status === 'paid') return badRequest(res, "Can't void a paid invoice");

    // POS sales decrement stock at pay-link issuance, so voiding an
    // unpaid sale must put the units back. Balanced-pairs bookkeeping in
    // the activity log ('restocked' vs 'stock-rededucted' from un-void)
    // makes a void→restore→void cycle restock exactly once per void.
    const activity = inv.activity || [];
    const stockItems = (Array.isArray(inv.items) ? inv.items : [])
      .filter((it) => it.productId && Number(it.quantity) > 0);
    const restocks   = activity.filter((a) => a.kind === 'restocked').length;
    const rededucts  = activity.filter((a) => a.kind === 'stock-rededucted').length;
    const willRestock = stockItems.length > 0 && restocks <= rededucts;

    const newActivity = [
      ...activity,
      { ts: new Date().toISOString(), kind: 'voided', text: 'Invoice voided' },
      ...(willRestock
        ? [{ ts: new Date().toISOString(), kind: 'restocked', text: 'Stock returned to inventory' }]
        : []),
    ];

    // Status guard mirrors send/resend: a payment landing between the
    // read above and this write must win - never flip paid → voided.
    const updated = await sql`
      UPDATE invoices SET
        status = 'voided',
        view_token_hash = NULL,
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
        AND status NOT IN ('paid', 'refunded')
      RETURNING *
    `;
    if (updated.rows.length === 0) {
      return badRequest(res, 'This invoice was just paid - refresh to see its current state.');
    }
    if (willRestock) {
      for (const it of stockItems) {
        // eslint-disable-next-line no-await-in-loop
        await restoreStock({ workspaceId, productId: it.productId, qty: it.quantity });
      }
    }
    // Immutable trail of an irreversible state change. Fire-and-forget;
    // a logging blip won't undo the void.
    recordWorkspaceAudit(req, {
      workspaceId, actor: user,
      action: 'invoice.void',
      target: { kind: 'invoice', id: inv.id },
      meta: { number: inv.number, client_name: inv.client_name },
    });
    return ok(res, { invoice: serializeInvoice(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

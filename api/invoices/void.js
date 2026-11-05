// POST /api/invoices/void  body: { id, notifyClient? }
// Owner voids an unpaid invoice. It stays on record marked Void, the
// client's link shows "This invoice was voided" and can no longer take a
// payment, reminders stop, and nothing is owed. Paid invoices are refunded
// instead; an invoice with a part payment needs that payment refunded
// first. Rules: src/lib/invoiceRules.js; core: api/_lib/invoiceActions.js.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { voidInvoiceCore } from '../_lib/invoiceActions.js';
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
    try {
      const out = await voidInvoiceCore({
        workspaceId, id, actor: user, req,
        notifyClient: body.notifyClient === true || body.notifyClient === 'true',
      });
      return ok(res, out);
    } catch (e) {
      if (e.code === 'not_found' || e.code === 'refused') return badRequest(res, e.message);
      throw e;
    }
  } catch (err) {
    return serverError(res, err);
  }
}

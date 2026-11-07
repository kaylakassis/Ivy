// POST /api/invoices/refund   body: { id, amount?, reason? }
//
// Refunds a paid (or part-paid) invoice (omit `amount` for everything
// left). The amount is split across the invoice's payments newest first
// (invoice_payments), one refund per payment through the processor that
// took it (Stripe / Square / PayPal, in the invoice's currency); money the
// owner recorded by hand (cash, check, Venmo) is only recorded as given
// back, and a gift card that paid gets its credit back.
//
// State changes:
//   refunded_amount += amount; refunded_at = NOW(); status = 'refunded'
//   when everything paid is back, otherwise stays 'paid' (so partial
//   refunds are visible without dropping the "this client paid me"
//   signal). If a later processor refund fails, a 400 says exactly what
//   went back and what did not (details: refunded, notRefunded, invoice).
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { refundInvoice } from '../_lib/refunds.js';
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
    try {
      // Shared core (also used by Ivy's refund_invoice tool). It throws a
      // user-safe Error on validation/provider failures, which we surface
      // as a 400 to preserve this endpoint's existing behavior.
      const result = await refundInvoice({
        workspaceId,
        id: body.id ? String(body.id) : null,
        amount: body.amount,
        reason: body.reason,
        audit: { req, actor: user },
      });
      return ok(res, result);
    } catch (e) {
      // A refund split across payments where a later one failed: the
      // message says what went back and what did not; details carry the
      // numbers and the invoice as it now stands.
      const details = e.partial
        ? { refunded: e.partial.refunded, notRefunded: e.partial.notRefunded, requested: e.partial.requested, invoice: e.partial.invoice, parts: e.partial.parts }
        : undefined;
      return badRequest(res, e.message || 'Refund failed', details);
    }
  } catch (err) {
    return serverError(res, err);
  }
}

// POST /api/invoices/refund   body: { id, amount?, reason? }
//
// Refunds a paid invoice. Two paths:
//   • Card-paid invoices (stripe_payment_intent set): hits Stripe's
//     /refunds endpoint with the workspace's secret key. Partial
//     amounts allowed (omit `amount` for a full refund of what's left).
//   • Manually-marked-paid invoices: records the refund on our side
//     only — the owner handles the actual money outside the app.
//     Useful for cash / check / external Venmo refunds.
//
// State changes:
//   refunded_amount += amount; refunded_at = NOW(); status = 'refunded'
//   when refunded_amount reaches the invoice total, otherwise stays
//   'paid' (so partial refunds are visible without dropping the
//   "this client paid me" signal).
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
      return badRequest(res, e.message || 'Refund failed');
    }
  } catch (err) {
    return serverError(res, err);
  }
}

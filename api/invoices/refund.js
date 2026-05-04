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
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { decrypt } from '../_lib/secrets.js';
import { createRefund } from '../_lib/stripe.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals } from '../_lib/finance.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

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

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return badRequest(res, 'Invoice not found');
    if (inv.status !== 'paid' && inv.status !== 'refunded') {
      return badRequest(res, 'Only paid invoices can be refunded');
    }

    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const alreadyRefunded = Number(inv.refunded_amount || 0);
    const remaining = Math.max(0, totals.total - alreadyRefunded);
    if (remaining <= 0) {
      return badRequest(res, 'This invoice has already been fully refunded');
    }

    let amount = body.amount == null ? remaining : Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return badRequest(res, 'amount must be a positive number');
    }
    if (amount > remaining + 0.001) {
      return badRequest(res, `Cannot refund more than remaining (${fmtMoney(remaining)})`);
    }
    // Round to cents to avoid float drift in the running total.
    amount = Math.round(amount * 100) / 100;

    const reason = body.reason && VALID_REASONS.has(body.reason) ? body.reason : null;
    const method = inv.stripe_payment_intent ? 'card' : (inv.paid_method || 'manual');

    let stripeRefundId = null;
    if (inv.stripe_payment_intent) {
      // Card refund — needs the workspace's stripe secret.
      const cs = await sql`
        SELECT stripe_secret_encrypted FROM finance_settings WHERE workspace_id = ${workspaceId}
      `;
      const enc = cs.rows[0]?.stripe_secret_encrypted;
      if (!enc) {
        return badRequest(res, 'Card refund needs your Stripe account connected. Reconnect Stripe in Finance, or refund manually below.');
      }
      let secretKey;
      try { secretKey = decrypt(enc); }
      catch { return serverError(res, new Error('Could not load Stripe credentials')); }
      try {
        const r = await createRefund({
          secretKey,
          paymentIntent: inv.stripe_payment_intent,
          amountCents: Math.round(amount * 100),
          reason,
        });
        stripeRefundId = r.id;
      } catch (err) {
        return badRequest(res, `Stripe refused the refund: ${err.message}`);
      }
    }

    const newRefunded = alreadyRefunded + amount;
    const fullyRefunded = newRefunded >= totals.total - 0.001;
    const newStatus = fullyRefunded ? 'refunded' : 'paid';

    const activityEntry = {
      ts: new Date().toISOString(),
      kind: 'refund',
      text: `Refunded ${fmtMoney(amount)}${method === 'card' ? ' to card' : ''}${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}`,
      ...(stripeRefundId ? { stripeRefundId } : {}),
    };

    const updated = await sql`
      UPDATE invoices SET
        status            = ${newStatus},
        refunded_amount   = ${newRefunded},
        refunded_at       = NOW(),
        activity          = ${JSON.stringify([...(inv.activity || []), activityEntry])}::jsonb,
        updated_at        = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;
    return ok(res, {
      invoice: serializeInvoice(updated.rows[0]),
      refund: { amount, method, fullyRefunded, stripeRefundId },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

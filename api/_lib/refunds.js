// Shared refund core. Extracted from api/invoices/refund.js so BOTH the
// HTTP route and Ivy's refund_invoice tool run the exact same money logic
// (provider dispatch, partial-amount math, idempotency, concurrency
// guard) instead of duplicating it. Money out of a real account is not a
// place for two slightly-different code paths.
//
// Returns { invoice (serialized), refund: { amount, method, fullyRefunded,
// stripeRefundId, deduped? } } on success. Throws Error (with a
// user-safe message) on any validation/provider failure — callers map
// that to their own error shape (badRequest for the route; tool error
// surfaced to the owner for Ivy).
//
// `audit` is optional: when { req, actor } is supplied (the HTTP route),
// an immutable workspace-audit row is recorded. Ivy omits it (no request
// object), so the refund itself still happens but the IP-scoped audit
// trail is skipped — the invoice activity log still captures the refund.
import { sql } from './db.js';
import { createRefund } from './stripe.js';
import { loadStripeCreds } from './stripeCreds.js';
import { createRefund as squareCreateRefund } from './payments/square.js';
import { createRefund as paypalCreateRefund } from './payments/paypal.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals, fetchFinanceSettings } from './finance.js';
import { recordWorkspaceAudit } from './audit.js';

const VALID_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function refundInvoice({ workspaceId, id, amount: amountIn, reason: reasonIn, audit = null }) {
  if (!id) throw new Error('id is required');

  const inv = await fetchOwnedInvoice({ id, workspaceId });
  if (!inv) throw new Error('Invoice not found');
  if (inv.status !== 'paid' && inv.status !== 'refunded') {
    throw new Error('Only paid invoices can be refunded');
  }

  const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
  const alreadyRefunded = Number(inv.refunded_amount || 0);
  const remaining = Math.max(0, totals.total - alreadyRefunded);
  if (remaining <= 0) throw new Error('This invoice has already been fully refunded');

  let amount = amountIn == null ? remaining : Number(amountIn);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
  if (amount > remaining + 0.001) throw new Error(`Cannot refund more than remaining (${fmtMoney(remaining)})`);
  amount = Math.round(amount * 100) / 100;

  const reason = reasonIn && VALID_REASONS.has(reasonIn) ? reasonIn : null;
  const method = inv.stripe_payment_intent ? 'card' : (inv.paid_method || 'manual');

  // Deterministic key so a retry that reads the same alreadyRefunded reuses
  // the same provider idempotency key (provider returns the original refund
  // rather than issuing a second one).
  const refundKey = `refund-${id}-${Math.round(alreadyRefunded * 100)}`;

  let stripeRefundId = null;
  if (inv.stripe_payment_intent) {
    const fs = await fetchFinanceSettings(workspaceId);
    const provider = fs?.paymentProvider || 'stripe';
    if (provider === 'square') {
      const out = await squareCreateRefund({
        workspaceId, settings: fs, paymentIntent: inv.stripe_payment_intent,
        amountCents: Math.round(amount * 100), currency: fs.currency, reason, idempotencyKey: refundKey,
      });
      stripeRefundId = out.id;
    } else if (provider === 'paypal') {
      const out = await paypalCreateRefund({
        workspaceId, settings: fs, paymentIntent: inv.stripe_payment_intent,
        amountCents: Math.round(amount * 100), currency: fs.currency, reason, idempotencyKey: refundKey,
      });
      stripeRefundId = out.id;
    } else {
      let creds;
      try {
        creds = await loadStripeCreds(workspaceId);
      } catch (err) {
        if (err.code === 'no_stripe_connection') {
          throw new Error('Card refund needs your Stripe account connected. Reconnect Stripe in Finance, or refund manually.');
        }
        throw err;
      }
      const r = await createRefund({
        secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
        paymentIntent: inv.stripe_payment_intent, amountCents: Math.round(amount * 100),
        reason, idempotencyKey: refundKey,
      });
      stripeRefundId = r.id;
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

  // Concurrency guard: only apply if refunded_amount is still what we read.
  // A racing request that already recorded a refund matches 0 rows; the
  // provider call above was idempotent (same key) so no double money moved.
  const updated = await sql`
    UPDATE invoices SET
      status          = ${newStatus},
      refunded_amount = ${newRefunded},
      refunded_at     = NOW(),
      activity        = ${JSON.stringify([...(inv.activity || []), activityEntry])}::jsonb,
      updated_at      = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
      AND COALESCE(refunded_amount, 0) = ${alreadyRefunded}
    RETURNING *
  `;
  if (updated.rowCount === 0) {
    const current = await fetchOwnedInvoice({ id, workspaceId });
    const curRefunded = Number(current?.refunded_amount || 0);
    return {
      invoice: serializeInvoice(current),
      refund: { amount, method, fullyRefunded: curRefunded >= totals.total - 0.001, stripeRefundId, deduped: true },
    };
  }

  // Immutable trail — only when an HTTP request context is supplied.
  if (audit?.req) {
    recordWorkspaceAudit(audit.req, {
      workspaceId, actor: audit.actor,
      action: 'invoice.refund',
      target: { kind: 'invoice', id: inv.id },
      meta: {
        number: inv.number, amount, method, reason: reason || null,
        provider_refund_id: stripeRefundId || null, fully_refunded: fullyRefunded,
      },
    });
  }

  return {
    invoice: serializeInvoice(updated.rows[0]),
    refund: { amount, method, fullyRefunded, stripeRefundId },
  };
}

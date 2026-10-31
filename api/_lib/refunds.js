// Shared refund core. Extracted from api/invoices/refund.js so BOTH the
// HTTP route and Ivy's refund_invoice tool run the exact same money logic
// (provider dispatch, partial-amount math, idempotency, concurrency
// guard) instead of duplicating it. Money out of a real account is not a
// place for two slightly-different code paths.
//
// Returns { invoice (serialized), refund: { amount, method, fullyRefunded,
// stripeRefundId, deduped? } } on success. Throws Error (with a
// user-safe message) on any validation/provider failure - callers map
// that to their own error shape (badRequest for the route; tool error
// surfaced to the owner for Ivy).
//
// `audit` is optional: when { req, actor } is supplied (the HTTP route),
// an immutable workspace-audit row is recorded. Ivy omits it (no request
// object), so the refund itself still happens but the IP-scoped audit
// trail is skipped - the invoice activity log still captures the refund.
import { sql } from './db.js';
import { createRefund } from './stripe.js';
import { loadStripeCreds } from './stripeCreds.js';
import { createRefund as squareCreateRefund } from './payments/square.js';
import { createRefund as paypalCreateRefund } from './payments/paypal.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals, fetchFinanceSettings } from './finance.js';
import { recordWorkspaceAudit } from './audit.js';
import { notifyInvoiceRefunded } from './invoiceNotify.js';
import { restoreGiftCardCreditForInvoice } from './giftCards.js';

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
  // Cap refunds against what was ACTUALLY collected (paid_amount), not the
  // recomputed invoice total. With Stripe Tax, paid_amount can exceed the
  // base total (so the tax portion must be refundable); for legacy rows with
  // no paid_amount, fall back to the total.
  const refundBasis = inv.paid_amount != null ? Number(inv.paid_amount) : totals.total;
  const alreadyRefunded = Number(inv.refunded_amount || 0);
  const remaining = Math.max(0, refundBasis - alreadyRefunded);
  if (remaining <= 0) throw new Error('This invoice has already been fully refunded');

  let amount = amountIn == null ? remaining : Number(amountIn);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
  if (amount > remaining + 0.001) throw new Error(`Cannot refund more than remaining (${fmtMoney(remaining)})`);
  amount = Math.round(amount * 100) / 100;

  const reason = reasonIn && VALID_REASONS.has(reasonIn) ? reasonIn : null;
  // 'gift_card' = the client paid the whole invoice with a gift card: no
  // processor took money, so a refund puts the credit back on the card.
  const method = inv.stripe_payment_intent ? 'card' : (inv.paid_method || 'manual');

  // Deterministic key so a retry that reads the same alreadyRefunded reuses
  // the same provider idempotency key (provider returns the original refund
  // rather than issuing a second one).
  const refundKey = `refund-${id}-${Math.round(alreadyRefunded * 100)}`;

  let stripeRefundId = null;
  if (inv.stripe_payment_intent) {
    const out = await refundThroughProvider({
      workspaceId, paymentIntent: inv.stripe_payment_intent, paidMethod: inv.paid_method,
      amountCents: Math.round(amount * 100), reason, idempotencyKey: refundKey,
    });
    stripeRefundId = out.id;
  }

  const newRefunded = alreadyRefunded + amount;
  const fullyRefunded = newRefunded >= refundBasis - 0.001;
  const newStatus = fullyRefunded ? 'refunded' : 'paid';

  const activityEntry = {
    ts: new Date().toISOString(),
    kind: 'refund',
    text: `Refunded ${fmtMoney(amount)}${method === 'card' ? ' to card' : method === 'gift_card' ? ' to the gift card' : ''}${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}`,
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
      refund: { amount, method, fullyRefunded: curRefunded >= refundBasis - 0.001, stripeRefundId, deduped: true },
    };
  }

  // Immutable trail - only when an HTTP request context is supplied.
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

  // Gift card credit goes back on the card: for an invoice the card paid
  // in full, each refund returns that much credit; for a mixed invoice
  // (card + processor), the credit comes back once the money part is fully
  // refunded. Exactly-once inside the helper; a failure is logged and the
  // credit stays claimable for a later void / refund.
  let giftRestoredCents = 0;
  const giftLeft = Number(inv.gift_card_credit_cents || 0) - Number(inv.gift_card_credit_restored_cents || 0);
  if (giftLeft > 0 && (method === 'gift_card' || fullyRefunded)) {
    giftRestoredCents = await restoreGiftCardCreditForInvoice({
      workspaceId, invoiceId: inv.id,
      amountCents: method === 'gift_card' ? Math.round(amount * 100) : null,
    }).catch((err) => { console.error('[refund] gift card restore failed:', err.message); return 0; });
  }

  // Tell the client. Only on the write that actually applied (the deduped
  // path above returns early), and never let an email failure undo or
  // fail a refund that already moved money.
  await notifyInvoiceRefunded({
    workspaceId, invoiceId: inv.id, amount,
    method: inv.stripe_payment_intent ? (inv.paid_method === 'ach' ? 'ach' : 'card') : (inv.paid_method || 'other'),
    giftRestoredCents,
  }).catch(() => {});

  const finalRow = giftRestoredCents > 0 ? (await fetchOwnedInvoice({ id, workspaceId })) || updated.rows[0] : updated.rows[0];
  return {
    invoice: serializeInvoice(finalRow),
    refund: { amount, method, fullyRefunded, stripeRefundId, giftRestoredCents },
  };
}

// Send `amountCents` back through the provider that CAPTURED the payment,
// not whatever provider is currently selected - owners who switch
// providers must still be able to refund older sales. Each capture path
// leaves a distinct signature: PayPal stamps paid_method='paypal'; Stripe
// payment ids are pi_/ch_-prefixed; Square ids are neither. Shared by the
// invoice refund above and the purchase refunds (programs, gift cards,
// packages) in purchaseRefunds.js, so money leaves through one code path.
// `idempotencyKey` must be deterministic per (purchase, cumulative amount)
// so a retry returns the original refund instead of issuing a second one.
export async function refundThroughProvider({ workspaceId, paymentIntent, paidMethod = null, amountCents, reason = null, idempotencyKey }) {
  if (!paymentIntent) throw new Error('No online payment is attached to this purchase');
  const fs = await fetchFinanceSettings(workspaceId);
  const provider = paidMethod === 'paypal' ? 'paypal'
    : /^(pi_|ch_)/.test(paymentIntent) ? 'stripe'
    : (fs?.paymentProvider === 'square' || paidMethod === 'card') ? 'square'
    : (fs?.paymentProvider || 'stripe');
  if (provider === 'square') {
    return squareCreateRefund({
      workspaceId, settings: fs, paymentIntent, amountCents, currency: fs?.currency, reason, idempotencyKey,
    });
  }
  if (provider === 'paypal') {
    return paypalCreateRefund({
      workspaceId, settings: fs, paymentIntent, amountCents, currency: fs?.currency, reason, idempotencyKey,
    });
  }
  let creds;
  try {
    creds = await loadStripeCreds(workspaceId);
  } catch (err) {
    if (err.code === 'no_stripe_connection') {
      throw new Error('Card refund needs your Stripe account connected. Reconnect Stripe in Finance, or refund manually.');
    }
    throw err;
  }
  return createRefund({
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
    paymentIntent, amountCents, reason, idempotencyKey,
  });
}

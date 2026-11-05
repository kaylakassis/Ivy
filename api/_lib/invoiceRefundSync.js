// A refund made straight in the Stripe Dashboard (or the echo of one Ivy
// made) lands as charge.refunded. This folds it into the matching invoice:
// refunded_amount is set to Stripe's cumulative amount (an absolute set, so
// a re-delivered or echoed event is a no-op), the status flips to
// 'refunded' when the whole charge is back, a gift card applied to the
// invoice gets its credit back, the client gets the refund email once and
// the owner a push.
//
// Shared by the Connect platform webhook (api/webhooks/stripe-platform.js)
// and the older per-workspace webhook (api/webhooks/stripe/[workspaceId].js),
// which used to ignore invoice refunds so the invoice kept saying "Paid"
// after the money went back.
//
// Returns 'not-found' (no invoice for that payment), 'already' (nothing
// new) or 'applied'.
import { sql } from './db.js';
import { notifyOwnerSafe } from './push.js';
import { restoreGiftCardCreditForInvoice } from './giftCards.js';

export async function applyStripeChargeRefundToInvoice({ workspaceId, charge }) {
  const pi = typeof charge?.payment_intent === 'string' ? charge.payment_intent : charge?.payment_intent?.id;
  if (!pi) return 'not-found';
  const inv = await sql`
    SELECT id, number, activity, refunded_amount, status FROM invoices
     WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${pi}
     LIMIT 1
  `;
  if (inv.rows.length === 0) return 'not-found';
  const i = inv.rows[0];
  const refundedTotal = Math.round(Number(charge.amount_refunded || 0)) / 100;
  const already = Number(i.refunded_amount || 0);
  if (refundedTotal <= already) return 'already';
  const fully = Number(charge.amount_refunded) >= Number(charge.amount);
  // A part payment on a still-open invoice stays open; a paid one flips.
  const open = i.status === 'sent' || i.status === 'overdue';
  const newStatus = open ? i.status : (fully ? 'refunded' : 'paid');
  const entry = {
    ts: new Date().toISOString(),
    kind: 'refund',
    text: `Refunded $${(refundedTotal - already).toFixed(2)} to card (via Stripe)`,
  };
  const applied = await sql`
    UPDATE invoices SET
      status          = ${newStatus},
      refunded_amount = ${refundedTotal},
      refunded_at     = NOW(),
      activity        = ${JSON.stringify([...(i.activity || []), entry])}::jsonb,
      updated_at      = NOW()
    WHERE id = ${i.id} AND workspace_id = ${workspaceId}
      AND COALESCE(refunded_amount, 0) = ${already}
    RETURNING id
  `;
  if (applied.rowCount > 0) {
    let giftRestoredCents = 0;
    if (fully && !open) {
      giftRestoredCents = await restoreGiftCardCreditForInvoice({ workspaceId, invoiceId: i.id })
        .catch((err) => { console.error('[stripe refund sync] gift card restore failed:', err.message); return 0; });
    }
    const { notifyInvoiceRefunded } = await import('./invoiceNotify.js');
    await notifyInvoiceRefunded({ workspaceId, invoiceId: i.id, amount: Math.round((refundedTotal - already) * 100) / 100, giftRestoredCents }).catch(() => {});
  }
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: fully ? 'Invoice refunded' : 'Partial refund recorded',
      body: `${i.number} · $${refundedTotal.toFixed(2)} refunded via Stripe`,
      url: `/finance?invoice=${i.id}`,
      tag: `refund-${i.id}`,
    },
  });
  return 'applied';
}

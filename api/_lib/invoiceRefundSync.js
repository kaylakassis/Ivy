// Refunds reported by a payment provider (made straight in the Stripe,
// Square or PayPal dashboard, or the echo of one Ivy made) are folded into
// the invoice they belong to, against the PAYMENT they were made on: the
// invoice_payments row for that payment id (invoiceLedger.js). An invoice
// with several payments used to match only its latest payment id, so a
// refund of an earlier payment was ignored and the invoice kept saying
// "Paid".
//
//   • Stripe (charge.refunded): amount_refunded is the payment's running
//     total, so the row moves UP to it; a re-delivered event or the echo of
//     an Ivy refund lands on the same total and adds nothing.
//   • Square / PayPal: one event per refund, counted once by refund id
//     (also against the ids Ivy noted on the invoice before the ledger).
//
// The invoice's refunded_amount moves by the same amount in the same
// statement; a paid invoice flips to 'refunded' once everything paid is
// back (then a gift card applied to it gets its credit back).
//
// Shared by the Connect platform webhook (api/webhooks/stripe-platform.js),
// the older per-workspace Stripe webhook, the Square webhook and the PayPal
// webhooks.
import { sql } from './db.js';
import { notifyOwnerSafe } from './push.js';
import { restoreGiftCardCreditForInvoice } from './giftCards.js';
import { findPaymentRow, applyRefundToPayment } from './invoiceLedger.js';

async function restoreGiftIfFullyRefunded({ workspaceId, invoice, label }) {
  if (!invoice || invoice.status !== 'refunded' || invoice.prev_status === 'refunded') return 0;
  return restoreGiftCardCreditForInvoice({ workspaceId, invoiceId: invoice.id })
    .catch((err) => { console.error(`[${label} refund sync] gift card restore failed:`, err.message); return 0; });
}

// Returns 'not-found' (no invoice payment with that id), 'already'
// (nothing new) or 'applied'.
export async function applyStripeChargeRefundToInvoice({ workspaceId, charge }) {
  const pi = typeof charge?.payment_intent === 'string' ? charge.payment_intent : charge?.payment_intent?.id;
  if (!pi) return 'not-found';
  const row = await findPaymentRow({ workspaceId, provider: 'stripe', providerPaymentId: pi });
  if (!row) return 'not-found';
  const cumulative = Math.round(Number(charge.amount_refunded || 0)) / 100;
  const { delta, invoice } = await applyRefundToPayment({
    workspaceId, paymentRowId: row.id, cumulative, activityText: ' to card (via Stripe)',
  });
  if (!(delta > 0) || !invoice) return 'already';

  const giftRestoredCents = await restoreGiftIfFullyRefunded({ workspaceId, invoice, label: 'stripe' });
  const { notifyInvoiceRefunded } = await import('./invoiceNotify.js');
  await notifyInvoiceRefunded({ workspaceId, invoiceId: invoice.id, amount: delta, giftRestoredCents }).catch(() => {});
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: invoice.status === 'refunded' ? 'Invoice refunded' : 'Partial refund recorded',
      body: `${invoice.number} · $${delta.toFixed(2)} refunded via Stripe`,
      url: `/finance?invoice=${invoice.id}`,
      tag: `refund-${invoice.id}`,
    },
  });
  return 'applied';
}

// One Square or PayPal refund event. `label` names the provider in the
// invoice's activity line. Returns { result: 'not-found' | 'zero-amount' |
// 'already' | 'applied', invoice }.
export async function applyProviderRefundEvent({ workspaceId, provider, paymentId, refundId = null, amountCents, reason = null, label }) {
  if (!paymentId) return { result: 'not-found', invoice: null };
  const row = await findPaymentRow({ workspaceId, provider, providerPaymentId: paymentId });
  if (!row) return { result: 'not-found', invoice: null };
  const amount = Math.round(Number(amountCents || 0)) / 100;
  if (!(amount > 0)) return { result: 'zero-amount', invoice: null };

  // A refund Ivy made before the ledger existed is noted only on the
  // invoice's activity log; its late webhook must not count it again.
  if (refundId) {
    const inv = (await sql`SELECT activity FROM invoices WHERE id = ${row.invoice_id} AND workspace_id = ${workspaceId}`).rows[0];
    const seen = (inv?.activity || []).some((a) => a?.kind === 'refund'
      && (a.stripeRefundId === refundId || (Array.isArray(a.refundIds) && a.refundIds.includes(refundId))));
    if (seen && !(row.refund_ids || []).includes(refundId)) {
      // Remember it on the row so the next delivery stops here too.
      await sql`
        UPDATE invoice_payments SET refund_ids = array_append(refund_ids, ${refundId}::text), updated_at = NOW()
         WHERE id = ${row.id} AND workspace_id = ${workspaceId} AND NOT (${refundId}::text = ANY(refund_ids))
      `;
      return { result: 'already', invoice: null };
    }
  }

  const { delta, invoice } = await applyRefundToPayment({
    workspaceId, paymentRowId: row.id, add: amount, refundId,
    activityText: ` (${label}${reason ? ` · ${reason}` : ''})`,
  });
  if (!(delta > 0) || !invoice) return { result: 'already', invoice: null };
  await restoreGiftIfFullyRefunded({ workspaceId, invoice, label });
  return { result: 'applied', invoice };
}

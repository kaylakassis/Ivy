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
import { restoreGiftCardCreditForInvoice, retakeGiftCardCreditForInvoice } from './giftCards.js';
import { findPaymentRow, applyRefundToPayment, reverseRefundOnPayment } from './invoiceLedger.js';

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Refund ids Ivy noted on the invoice's activity before the ledger existed.
async function legacyRefundNoted({ workspaceId, row, refundId }) {
  if (!refundId || (row.refund_ids || []).includes(refundId)) return false;
  const inv = (await sql`SELECT activity FROM invoices WHERE id = ${row.invoice_id} AND workspace_id = ${workspaceId}`).rows[0];
  return (inv?.activity || []).some((a) => a?.kind === 'refund'
    && (a.stripeRefundId === refundId || (Array.isArray(a.refundIds) && a.refundIds.includes(refundId))));
}

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
    if (await legacyRefundNoted({ workspaceId, row, refundId })) {
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
  const giftRestoredCents = await restoreGiftIfFullyRefunded({ workspaceId, invoice, label });
  // The client hears about it like a Stripe dashboard refund: once, from
  // the write that counted it (a refund made in Ivy already emailed, and
  // its notice here counts nothing).
  const { notifyInvoiceRefunded } = await import('./invoiceNotify.js');
  await notifyInvoiceRefunded({
    workspaceId, invoiceId: invoice.id, amount: delta,
    method: provider === 'paypal' ? 'paypal' : 'card', giftRestoredCents,
  }).catch(() => {});
  return { result: 'applied', invoice };
}

// A Square / PayPal refund the provider later reports as failed: take it
// back off the payment and the invoice, and tell the owner plainly. Once
// per refund id. Returns { result: 'not-found' | 'not-recorded' | 'already'
// | 'reversed', invoice }.
export async function applyProviderRefundFailure({ workspaceId, provider, paymentId, refundId, amountCents, label }) {
  if (!paymentId || !refundId) return { result: 'not-found', invoice: null };
  const row = await findPaymentRow({ workspaceId, provider, providerPaymentId: paymentId });
  if (!row) return { result: 'not-found', invoice: null };
  if ((row.refund_ids || []).includes(`failed:${refundId}`)) return { result: 'already', invoice: null };
  // Counted before the ledger existed (noted only on the invoice): put it
  // on the row first so it is taken back like any other.
  if (await legacyRefundNoted({ workspaceId, row, refundId })) {
    await sql`
      UPDATE invoice_payments SET refund_ids = array_append(refund_ids, ${refundId}::text), updated_at = NOW()
       WHERE id = ${row.id} AND workspace_id = ${workspaceId} AND NOT (${refundId}::text = ANY(refund_ids))
    `;
  }
  const amount = Math.round(Number(amountCents || 0)) / 100;
  const { back, invoice } = await reverseRefundOnPayment({
    workspaceId, paymentRowId: row.id, refundId, amount,
    activityText: ` failed at ${label}. The money was not returned.`,
  });
  if (!(back > 0) || !invoice) return { result: 'not-recorded', invoice: null };
  // The refund had made the invoice fully refunded and put its gift card
  // credit back on the card; it is no longer refunded, so the credit comes
  // back off (never below zero).
  if (invoice.prev_status === 'refunded' && invoice.status !== 'refunded') {
    const g = await retakeGiftCardCreditForInvoice({ workspaceId, invoiceId: invoice.id })
      .catch((err) => { console.error(`[${label} refund failure] gift card credit not taken back:`, err.message); return null; });
    if (g && g.shortCents > 0) {
      notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: {
          title: 'Gift card credit already spent',
          body: `${invoice.client_name || 'Your client'} already spent ${fmt(g.shortCents / 100)} of the gift card credit that came back with the failed refund on ${invoice.number}. Only ${fmt(g.takenCents / 100)} could be taken back off the card.`,
          url: `/finance?invoice=${invoice.id}`,
          tag: `gift-retake-${invoice.id}`,
        },
      });
    }
  }
  // The client was told "Refund issued"; tell them once it did not go
  // through (this write is the only one that takes the refund back).
  const { notifyInvoiceRefundFailed } = await import('./invoiceNotify.js');
  await notifyInvoiceRefundFailed({ workspaceId, invoiceId: invoice.id, amount: back }).catch(() => {});
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: 'Refund failed',
      body: `The ${fmt(back)} refund to ${invoice.client_name || 'your client'} failed at ${label}. The money was not returned.`,
      url: `/finance?invoice=${invoice.id}`,
      tag: `refund-failed-${refundId}`,
    },
  });
  return { result: 'reversed', invoice };
}

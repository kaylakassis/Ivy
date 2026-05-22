// Shared PayPal webhook apply-logic. Used by both the platform-level
// webhook (api/webhooks/paypal/index.js — the one PayPal actually delivers
// to, since PayPal Commerce supports a single app-level webhook URL) and
// the legacy per-workspace route (api/webhooks/paypal/[workspaceId].js).
//
// All writes are workspace-scoped and idempotent so a webhook retry — or
// the synchronous capture path in paypal-return.js calling applyPayment
// directly — can't double-apply.
import { sql } from './db.js';

// Resolve the workspace a PayPal capture/refund belongs to.
//   • capture.completed carries the payee merchant id → match finance_settings.
//   • refunds may not carry a payee → fall back to the invoice that owns the
//     capture id (stored in stripe_payment_intent, which doubles as the
//     generic provider payment-id column).
export async function resolveWorkspaceForPaypalEvent(parsed) {
  if (parsed?.payeeMerchantId) {
    const { rows } = await sql`
      SELECT workspace_id FROM finance_settings
       WHERE paypal_merchant_id = ${parsed.payeeMerchantId} LIMIT 1
    `;
    if (rows[0]?.workspace_id) return rows[0].workspace_id;
  }
  if (parsed?.paymentId) {
    const { rows } = await sql`
      SELECT workspace_id FROM invoices
       WHERE stripe_payment_intent = ${parsed.paymentId} LIMIT 1
    `;
    if (rows[0]?.workspace_id) return rows[0].workspace_id;
  }
  return null;
}

// Mark an invoice (or booking deposit) paid from a completed capture.
// Idempotent: a repeat for an already-paid invoice with the same capture
// is a no-op; a different capture on an already-paid invoice is ignored.
export async function applyPaymentToInvoice({ workspaceId, parsed }) {
  // Booking deposit — invoice_id is synthetic ('bookdep_<bookingId>').
  const invoiceId = parsed.metadata?.invoice_id;
  if (invoiceId && String(invoiceId).startsWith('bookdep_')) {
    const bookingId = String(invoiceId).slice('bookdep_'.length);
    const dep = await sql`
      UPDATE bookings SET
        deposit_paid = deposit_required,
        deposit_paid_at = NOW(),
        deposit_payment_intent = ${parsed.paymentId || null},
        updated_at = NOW()
      WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
        AND deposit_paid_at IS NULL
      RETURNING id
    `;
    return dep.rows.length > 0 ? 'deposit-paid' : 'deposit-already-paid';
  }
  if (!invoiceId) return 'no-invoice';

  const { rows: invRows } = await sql`
    SELECT * FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
  `;
  const inv = invRows[0];
  if (!inv) return 'invoice-not-found';

  if (inv.status === 'paid' && inv.stripe_payment_intent === parsed.paymentId) return 'already-applied';
  if (inv.status === 'paid') {
    // eslint-disable-next-line no-console
    console.warn('[paypal] invoice', invoiceId, 'already paid by a different capture id — ignoring');
    return 'already-paid';
  }

  const paidAmountDollars = Math.round(Number(parsed.amountCents || 0)) / 100;
  const newActivity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'paid', text: `Paid by PayPal · $${paidAmountDollars.toFixed(2)}` },
  ];

  const upd = await sql`
    UPDATE invoices SET
      status                = 'paid',
      paid_at               = NOW(),
      paid_amount           = ${paidAmountDollars},
      paid_method           = 'paypal',
      stripe_payment_intent = ${parsed.paymentId || null},
      view_token_hash       = NULL,
      activity              = ${JSON.stringify(newActivity)}::jsonb,
      updated_at            = NOW()
    WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status <> 'paid'
    RETURNING id
  `;
  return upd.rows.length > 0 ? 'paid' : 'already-paid';
}

// Apply a refund/reversal from a PayPal webhook (or a dashboard-initiated
// refund picked up out-of-band). Idempotent via the refund id recorded in
// the invoice activity log.
export async function applyRefundToInvoice({ workspaceId, parsed }) {
  if (!parsed.paymentId) return 'no-capture';
  const { rows: invRows } = await sql`
    SELECT * FROM invoices
    WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${parsed.paymentId}
    LIMIT 1
  `;
  const inv = invRows[0];
  if (!inv) {
    // eslint-disable-next-line no-console
    console.warn('[paypal] no invoice matches capture', parsed.paymentId, '— ignoring refund');
    return 'invoice-not-found';
  }
  const refundAmount = Math.round(Number(parsed.amountCents || 0)) / 100;
  if (refundAmount <= 0) return 'zero-amount';

  const activity = inv.activity || [];
  if (parsed.refundId && activity.some((a) => a.kind === 'refund' && a.stripeRefundId === parsed.refundId)) {
    return 'already-applied';
  }

  const alreadyRefunded = Number(inv.refunded_amount || 0);
  const newRefunded = +(alreadyRefunded + refundAmount).toFixed(2);
  const paidAmount = Number(inv.paid_amount || 0);
  const fullyRefunded = paidAmount > 0 && newRefunded >= paidAmount - 0.005;
  const newStatus = fullyRefunded ? 'refunded' : inv.status;

  const newActivity = [
    ...activity,
    {
      ts: new Date().toISOString(),
      kind: 'refund',
      text: `Refunded $${refundAmount.toFixed(2)} (PayPal${parsed.reason ? ` · ${parsed.reason}` : ''})`,
      ...(parsed.refundId ? { stripeRefundId: parsed.refundId } : {}),
    },
  ];

  await sql`
    UPDATE invoices SET
      status          = ${newStatus},
      refunded_amount = ${newRefunded},
      refunded_at     = NOW(),
      activity        = ${JSON.stringify(newActivity)}::jsonb,
      updated_at      = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
  `;
  return fullyRefunded ? 'refunded' : 'partial-refund';
}

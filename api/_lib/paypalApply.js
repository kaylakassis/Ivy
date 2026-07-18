// Shared PayPal webhook apply-logic. Used by both the platform-level
// webhook (api/webhooks/paypal/index.js - the one PayPal actually delivers
// to, since PayPal Commerce supports a single app-level webhook URL) and
// the legacy per-workspace route (api/webhooks/paypal/[workspaceId].js).
//
// All writes are workspace-scoped and idempotent so a webhook retry - or
// the synchronous capture path in paypal-return.js calling applyPayment
// directly - can't double-apply.
import { sql } from './db.js';
import { computeTotals } from './finance.js';
import { notifyOwnerSafe } from './push.js';
import { notifyInvoicePaid } from './invoiceNotify.js';

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
  // Booking deposit - invoice_id is synthetic ('bookdep_<bookingId>').
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
    console.warn('[paypal] invoice', invoiceId, 'already paid by a different capture id - ignoring');
    return 'already-paid';
  }

  const paidAmountDollars = Math.round(Number(parsed.amountCents || 0)) / 100;
  // Guard against a partial/under-capture (or currency mismatch) silently
  // flipping the invoice to fully paid. Only settle when the captured
  // amount covers the invoice total (1¢ tolerance for rounding). PayPal
  // checkout amount is the invoice total - no Stripe-Tax add-on to expect.
  const expectedTotal = computeTotals(inv.items, inv.tax_rate, inv.discount).total;
  const underpaid = paidAmountDollars < expectedTotal - 0.01;

  if (underpaid) {
    const partialActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'partial-payment',
        text: `Partial PayPal payment · $${paidAmountDollars.toFixed(2)} of $${expectedTotal.toFixed(2)}` },
    ];
    // Record the amount + capture id but leave the invoice open (not paid).
    await sql`
      UPDATE invoices SET
        paid_amount           = ${paidAmountDollars},
        paid_method           = 'paypal',
        stripe_payment_intent = ${parsed.paymentId || null},
        activity              = ${JSON.stringify(partialActivity)}::jsonb,
        updated_at            = NOW()
      WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status <> 'paid'
    `;
    return 'partial-payment';
  }

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
    RETURNING id, number, client_name
  `;
  if (upd.rows.length === 0) return 'already-paid';

  // Owner push + client receipt - parity with the Stripe path at
  // /api/webhooks/stripe/[workspaceId].js:482-502. Without these,
  // workspaces taking payment via PayPal saw the invoice flip to paid
  // but got no notification and the customer got no receipt email.
  // Fire-and-forget; the RETURNING-id race guard above means these
  // only fire when our UPDATE actually flipped the row.
  const number = upd.rows[0].number;
  const clientLabel = upd.rows[0].client_name || 'A client';
  notifyOwnerSafe({
    workspaceId,
    type: 'payments',
    payload: {
      title: 'Invoice paid',
      body: `${clientLabel} · ${number} · $${paidAmountDollars.toFixed(2)}`,
      url: `/finance?invoice=${invoiceId}`,
      tag: `inv-${invoiceId}`,
    },
  });
  notifyInvoicePaid({
    workspaceId, invoiceId, totalAmount: paidAmountDollars, method: 'paypal',
  });
  return 'paid';
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
    console.warn('[paypal] no invoice matches capture', parsed.paymentId, '- ignoring refund');
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

  // Concurrency predicate on the value we read (mirrors the charge.refunded
  // guard in api/webhooks/stripe-platform.js): two overlapping deliveries
  // would otherwise both read the same refunded_amount and the second write
  // silently overwrites the first (lost update). 0 rows = the other writer
  // already folded a refund in → treat as already applied.
  const upd = await sql`
    UPDATE invoices SET
      status          = ${newStatus},
      refunded_amount = ${newRefunded},
      refunded_at     = NOW(),
      activity        = ${JSON.stringify(newActivity)}::jsonb,
      updated_at      = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
      AND COALESCE(refunded_amount, 0) = ${alreadyRefunded}
    RETURNING id
  `;
  if (upd.rows.length === 0) return 'already-applied';
  return fullyRefunded ? 'refunded' : 'partial-refund';
}

// Apply a normalized PayPal subscription event (from parseWebhookEvent's
// 'subscription.updated' / 'subscription.renewed') to client_memberships.
// Self-resolving: the first ACTIVATED carries { workspace_id, membership_id,
// client_id } in custom_id metadata and creates the row; later events match
// the existing row by paypal_subscription_id. Idempotent (unique
// paypal_subscription_id). Mirrors applySubscriptionState for Stripe.
export async function applyPaypalSubscriptionEvent({ parsed }) {
  if (!parsed?.subscriptionId) return 'no-subscription';

  const existing = (await sql`
    SELECT * FROM client_memberships
     WHERE paypal_subscription_id = ${parsed.subscriptionId} LIMIT 1
  `).rows[0];

  if (!existing) {
    // We only create on a positive (active) signal - a cancel/past_due for a
    // subscription we never recorded is a no-op (likely created out-of-band).
    if (parsed.subStatus !== 'active') return 'unknown-subscription';
    const md = parsed.metadata || {};
    if (!md.workspace_id || !md.membership_id || !md.client_id) return 'missing-metadata';
    const tier = (await sql`
      SELECT id, name, price_cents, interval FROM memberships
       WHERE id = ${md.membership_id} AND workspace_id = ${md.workspace_id} LIMIT 1
    `).rows[0];
    if (!tier) return 'tier-not-found';
    const client = (await sql`
      SELECT id FROM clients WHERE id = ${md.client_id} AND workspace_id = ${md.workspace_id} LIMIT 1
    `).rows[0];
    if (!client) return 'client-not-found';
    await sql`
      INSERT INTO client_memberships (
        workspace_id, client_id, membership_id, membership_name, price_cents, interval,
        paypal_subscription_id, provider, status, current_period_end
      ) VALUES (
        ${md.workspace_id}, ${md.client_id}, ${tier.id}, ${tier.name}, ${tier.price_cents}, ${tier.interval},
        ${parsed.subscriptionId}, 'paypal', 'active', ${parsed.nextBillingTime || null}
      )
      ON CONFLICT (paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL DO NOTHING
    `;
    return 'created';
  }

  const status = parsed.subStatus || existing.status;
  await sql`
    UPDATE client_memberships SET
      status              = ${status},
      current_period_end  = COALESCE(${parsed.nextBillingTime || null}, current_period_end),
      cancelled_at        = ${status === 'cancelled' ? new Date() : null},
      updated_at          = NOW()
    WHERE id = ${existing.id}
  `;
  if (status === 'cancelled') return 'cancelled';
  return parsed.type === 'subscription.renewed' ? 'renewed' : 'updated';
}

// POST /api/webhooks/paypal/:workspaceId
// PayPal posts payment-capture events here. Configure the webhook on
// the platform-level app at developer.paypal.com → Apps → My App →
// Webhooks; subscribe to PAYMENT.CAPTURE.COMPLETED at minimum.
//
// We don't body-parse; PayPal's verify endpoint takes the raw event
// JSON as a property in the verify-call payload, so we need bytes.
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { verifyWebhook, parseWebhookEvent } from '../../_lib/payments/paypal.js';
import { fetchFinanceSettings } from '../../_lib/finance.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let claimedEventId = null;
  try {
    const { workspaceId } = req.query;
    const settings = await fetchFinanceSettings(workspaceId);
    if (!settings?.paypalMerchantId) return res.status(404).json({ error: 'Workspace not connected to PayPal' });

    const rawBody = await readRawBody(req);
    let event;
    try {
      event = await verifyWebhook({ rawBody, headers: req.headers });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Dedup BEFORE processing. PayPal retries for ~25h on non-2xx
    // responses; without this a handler crash mid-write would
    // re-process on every retry. event.id is part of PayPal's
    // webhook envelope.
    if (!await markProcessed('paypal', event?.id, workspaceId)) {
      return ok(res, { handled: true, deduped: true });
    }
    claimedEventId = event?.id;

    const parsed = parseWebhookEvent(event);
    if (!parsed) return ok(res, { handled: false });

    // Defense-in-depth: the PayPal webhook is verified against a single
    // platform-level webhook id (not per-workspace), so pin the event to
    // THIS workspace's connected merchant. The invoice writes are already
    // workspace-scoped (so cross-tenant application can't happen), but
    // rejecting a mismatched payee makes the intent explicit and avoids
    // wasted work / confusing logs. Only enforced when the event carries
    // a payee merchant id.
    if (parsed.payeeMerchantId
        && settings.paypalMerchantId
        && parsed.payeeMerchantId !== settings.paypalMerchantId) {
      console.warn('[webhooks/paypal] payee merchant', parsed.payeeMerchantId,
        'does not match workspace merchant', settings.paypalMerchantId, '— ignoring');
      return ok(res, { handled: false, reason: 'merchant-mismatch' });
    }

    if (parsed.type === 'checkout.completed' && parsed.status === 'paid') {
      await applyPaymentToInvoice({ workspaceId, parsed });
    } else if (parsed.type === 'refund.updated' && parsed.status === 'succeeded') {
      // Dashboard-initiated refunds from Merchant Center + reversals
      // from disputes. Both flip the invoice out of 'paid' so revenue
      // reports reflect reality.
      await applyRefundToInvoice({ workspaceId, parsed });
    }
    return ok(res, { handled: true });
  } catch (err) {
    // Release the dedup claim so PayPal's retry re-processes (its natural
    // guards keep the re-run from double-applying).
    if (claimedEventId) await releaseProcessed('paypal', claimedEventId);
    return serverError(res, err);
  }
}

// Same shape as the Square handler — see api/webhooks/square/[workspaceId].js
// for the rationale. Captures paid_amount, the PayPal capture id (stored
// in stripe_payment_intent — the column doubles as a generic provider
// payment-id field so refund.js can find it), idempotency by capture id,
// and an activity log entry.
async function applyPaymentToInvoice({ workspaceId, parsed }) {
  const invoiceId = parsed.metadata?.invoice_id;
  if (!invoiceId) return;

  const { rows: invRows } = await sql`
    SELECT * FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
  `;
  const inv = invRows[0];
  if (!inv) return;

  if (inv.status === 'paid' && inv.stripe_payment_intent === parsed.paymentId) return;
  if (inv.status === 'paid') {
    console.warn('[webhooks/paypal] invoice', invoiceId, 'already paid by a different capture id — ignoring');
    return;
  }

  const paidAmountDollars = Math.round(Number(parsed.amountCents || 0)) / 100;
  const newActivity = [
    ...(inv.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'paid',
      text: `Paid by PayPal · $${paidAmountDollars.toFixed(2)}`,
    },
  ];

  await sql`
    UPDATE invoices SET
      status                = 'paid',
      paid_at               = NOW(),
      paid_amount           = ${paidAmountDollars},
      paid_method           = 'card',
      stripe_payment_intent = ${parsed.paymentId || null},
      view_token_hash       = NULL,
      activity              = ${JSON.stringify(newActivity)}::jsonb,
      updated_at            = NOW()
    WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status <> 'paid'
  `;
}

// Mirror of the Square refund handler — see
// api/webhooks/square/[workspaceId].js#applyRefundToInvoice for the
// rationale. PayPal sends PAYMENT.CAPTURE.REFUNDED + .REVERSED; both
// get normalized to type='refund.updated' with status='succeeded' in
// the adapter's parseWebhookEvent.
async function applyRefundToInvoice({ workspaceId, parsed }) {
  if (!parsed.paymentId) return;
  const { rows: invRows } = await sql`
    SELECT * FROM invoices
    WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${parsed.paymentId}
    LIMIT 1
  `;
  const inv = invRows[0];
  if (!inv) {
    console.warn('[webhooks/paypal] no invoice matches capture', parsed.paymentId, '— ignoring refund');
    return;
  }
  const refundAmount = Math.round(Number(parsed.amountCents || 0)) / 100;
  if (refundAmount <= 0) return;

  const activity = inv.activity || [];
  if (parsed.refundId && activity.some((a) => a.kind === 'refund' && a.stripeRefundId === parsed.refundId)) {
    return;
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
}

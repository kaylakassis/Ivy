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
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
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

    const parsed = parseWebhookEvent(event);
    if (!parsed) return ok(res, { handled: false });

    if (parsed.type === 'checkout.completed' && parsed.status === 'paid') {
      await applyPaymentToInvoice({ workspaceId, parsed });
    }
    return ok(res, { handled: true });
  } catch (err) {
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

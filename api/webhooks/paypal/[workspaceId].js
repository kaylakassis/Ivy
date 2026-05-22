// POST /api/webhooks/paypal/:workspaceId
// PayPal posts payment-capture events here. Configure the webhook on
// the platform-level app at developer.paypal.com → Apps → My App →
// Webhooks; subscribe to PAYMENT.CAPTURE.COMPLETED at minimum.
//
// We don't body-parse; PayPal's verify endpoint takes the raw event
// JSON as a property in the verify-call payload, so we need bytes.
import { readRawBody } from '../../_lib/body.js';
import { verifyWebhook, parseWebhookEvent } from '../../_lib/payments/paypal.js';
import { fetchFinanceSettings } from '../../_lib/finance.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { applyPaymentToInvoice, applyRefundToInvoice } from '../../_lib/paypalApply.js';
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

// POST /api/webhooks/paypal — platform-level PayPal webhook.
//
// THIS is the URL to configure in the PayPal app (developer.paypal.com →
// Apps → your platform app → Webhooks). PayPal Commerce delivers ALL
// connected-merchant events to a single app-level webhook URL, so a
// per-workspace URL (the legacy /api/webhooks/paypal/[workspaceId] route)
// can never actually receive them. We resolve the owning workspace from
// the event itself: the payee merchant id for captures, or the capture id
// → invoice for refunds.
//
// Subscribe at minimum to: PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.REFUNDED,
// PAYMENT.CAPTURE.REVERSED.
import { readRawBody } from '../../_lib/body.js';
import { verifyWebhook, parseWebhookEvent } from '../../_lib/payments/paypal.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { resolveWorkspaceForPaypalEvent, applyPaymentToInvoice, applyRefundToInvoice, applyPaypalSubscriptionEvent } from '../../_lib/paypalApply.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

// PayPal's verify-webhook-signature call needs the exact raw bytes.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let claimedEventId = null;
  try {
    const rawBody = await readRawBody(req);

    let event;
    try {
      event = await verifyWebhook({ rawBody, headers: req.headers });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // Dedup BEFORE processing — PayPal retries for ~25h on non-2xx.
    // event.id is unique + stable across retransmits. Platform-scoped
    // (null workspace) since we haven't resolved the workspace yet.
    if (!await markProcessed('paypal', event?.id, null)) {
      return ok(res, { handled: true, deduped: true });
    }
    claimedEventId = event?.id;

    const parsed = parseWebhookEvent(event);
    if (!parsed) return ok(res, { handled: false });

    // Subscription events self-resolve their workspace (from the
    // subscription's custom_id metadata, or the existing client_memberships
    // row), so they don't go through the payee-merchant lookup.
    if (parsed.type === 'subscription.updated' || parsed.type === 'subscription.renewed') {
      const result = await applyPaypalSubscriptionEvent({ parsed });
      return ok(res, { handled: true, result });
    }

    const workspaceId = await resolveWorkspaceForPaypalEvent(parsed);
    if (!workspaceId) {
      // No connected workspace for this merchant / capture — accept so
      // PayPal stops retrying, but do nothing.
      return ok(res, { handled: false, reason: 'no-workspace' });
    }

    if (parsed.type === 'checkout.completed' && parsed.status === 'paid') {
      await applyPaymentToInvoice({ workspaceId, parsed });
    } else if (parsed.type === 'refund.updated' && parsed.status === 'succeeded') {
      await applyRefundToInvoice({ workspaceId, parsed });
    }
    return ok(res, { handled: true });
  } catch (err) {
    // Release the dedup claim so PayPal's retry re-processes (the apply
    // helpers are idempotent, so a re-run can't double-apply).
    if (claimedEventId) await releaseProcessed('paypal', claimedEventId);
    return serverError(res, err);
  }
}

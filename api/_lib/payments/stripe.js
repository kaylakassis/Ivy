// Stripe adapter — wraps the existing per-workspace Stripe Connect
// integration through the common payments interface. Behavior is
// unchanged from the pre-abstraction code path; this file just exposes
// the shape every adapter exposes so callers don't branch on provider.
import {
  platformStripeSecret, platformWebhookSecret,
  createCheckoutSession as stripeCreateCheckout,
  verifyWebhookSignature, fetchCheckoutSession,
} from '../stripe.js';
import { fetchFinanceSettings } from '../finance.js';

export function getProviderName() { return 'stripe'; }

export async function isConnected({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  return !!(fs?.stripeConnectUserId);
}

export async function getDisplayInfo({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!fs?.stripeConnectUserId) return null;
  return {
    label: fs.stripeAccountLabel || 'Stripe',
    environment: fs.stripeConnectLivemode ? 'live' : 'test',
    merchantId: fs.stripeConnectUserId,
    connectedAt: fs.stripeConnectedAt,
  };
}

export async function createCheckoutSession({
  workspaceId, settings,
  amountCents, currency = 'USD',
  description, metadata = {},
  successUrl, cancelUrl, customerEmail,
}) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!fs?.stripeConnectUserId) {
    throw new Error('Stripe is not connected for this workspace');
  }
  const secretKey = platformStripeSecret();
  if (!secretKey) throw new Error('Platform Stripe secret is not configured');

  // Reuse the existing helper. The "invoice" shape is what it expects;
  // we synthesize one when the metadata didn't come from a real invoice
  // (booking deposit, ad-hoc charge) so the helper signature doesn't
  // need to change.
  const invoice = {
    id: metadata.invoice_id || metadata.booking_id || 'adhoc',
    number: metadata.invoice_number || description || 'Charge',
    workspace_id: workspaceId,
  };
  const session = await stripeCreateCheckout({
    secretKey, invoice, currency, totalCents: amountCents,
    successUrl, cancelUrl, customerEmail,
  });
  return { url: session.url, sessionId: session.id };
}

// Stripe's HMAC-SHA256 over the raw body using the platform webhook
// secret. Returns the parsed event JSON on success; throws otherwise.
export function verifyWebhook({ rawBody, headers }) {
  const secret = platformWebhookSecret();
  if (!secret) throw new Error('Stripe webhook secret is not configured');
  const sig = headers['stripe-signature'] || headers['Stripe-Signature'];
  return verifyWebhookSignature({
    payload: rawBody, header: sig, secret,
  });
}

// Normalize the Stripe event taxonomy into the abstraction's flat
// shape. We only care about checkout.session.completed for the v1
// invoice-paid flow; everything else returns null and the caller
// no-ops on the webhook.
export function parseWebhookEvent(event) {
  if (!event) return null;
  if (event.type === 'checkout.session.completed') {
    const s = event.data?.object || {};
    return {
      type:        'checkout.completed',
      sessionId:   s.id,
      paymentId:   s.payment_intent,
      status:      s.payment_status === 'paid' ? 'paid' : (s.status || 'unknown'),
      amountCents: s.amount_total || 0,
      currency:    (s.currency || 'usd').toUpperCase(),
      metadata:    s.metadata || {},
      providerData: { customerEmail: s.customer_details?.email },
    };
  }
  return null;
}

// Exposed so the existing webhook receiver can opt back into the
// Stripe-specific session-fetch fallback (useful when the webhook
// arrives before metadata propagates).
export { fetchCheckoutSession };

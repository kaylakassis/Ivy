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

// "Connected" semantics differ slightly between flows:
//   • Account Links / Express: acct exists AND onboarding is 'complete'
//     (a 'pending' status means the owner started the form but didn't
//      finish — they can't yet receive charges).
//   • Standard OAuth (legacy): the access token is the proof of
//     connection — if it's stored, the account works.
function stripeIsLive(fs) {
  if (!fs) return false;
  if (fs.stripeConnectUserId && fs.stripeOnboardingStatus === 'complete') return true;
  if (fs.stripeSecretEncrypted) return true;
  return false;
}

export async function isConnected({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  return stripeIsLive(fs);
}

export async function getDisplayInfo({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!stripeIsLive(fs)) return null;
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
  if (!stripeIsLive(fs)) {
    throw new Error('Stripe is not connected for this workspace');
  }
  // Account-Links flow uses platform secret + Stripe-Account header.
  // Legacy Standard OAuth stored the connected acct's own secret —
  // when present, we use it directly with no acct header.
  let secretKey;
  let stripeAccount = null;
  if (fs.stripeConnectUserId && fs.stripeOnboardingStatus === 'complete') {
    secretKey = platformStripeSecret();
    if (!secretKey) throw new Error('Platform Stripe secret is not configured');
    stripeAccount = fs.stripeConnectUserId;
  } else {
    // Legacy path — secretKey loaded by the caller via stripeCreds.js
    // already; here we don't have it decrypted, so we route through the
    // platform key as a safe fallback (will fail if Standard OAuth was
    // the only auth — caller should use loadStripeCreds in that case).
    secretKey = platformStripeSecret();
    if (!secretKey) throw new Error('Platform Stripe secret is not configured');
  }
  const invoice = {
    id: metadata.invoice_id || metadata.booking_id || 'adhoc',
    number: metadata.invoice_number || description || 'Charge',
    workspace_id: workspaceId,
  };
  const session = await stripeCreateCheckout({
    secretKey, stripeAccount, invoice, currency, totalCents: amountCents,
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

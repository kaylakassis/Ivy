// Payment provider registry — picks the right adapter for a workspace.
//
// All provider adapters expose the same async interface so the
// application code never branches on provider type:
//
//   getProviderName()                                 → 'stripe' | 'square' | 'paypal'
//   isConnected({ workspaceId })                      → boolean
//   getDisplayInfo({ workspaceId })                   → { label, environment, merchantId }
//   createCheckoutSession({ workspaceId, amountCents, currency,
//                           description, metadata,
//                           successUrl, cancelUrl })  → { url, sessionId }
//   verifyWebhook({ rawBody, headers })               → event | throws
//   parseWebhookEvent(event)                          → { type, sessionId, paymentId,
//                                                          status, amountCents,
//                                                          metadata } | null
//
// Provider-specific extras (refunds, saved cards, recurring billing,
// subscriptions) are not part of the common interface yet — those flows
// stay Stripe-only in v1 because Square and PayPal need separate per-
// adapter implementations and v1 is checkout-only.
import { fetchFinanceSettings } from '../finance.js';
import * as stripeProvider from './stripe.js';
import * as squareProvider from './square.js';
import * as paypalProvider from './paypal.js';

const REGISTRY = {
  stripe: stripeProvider,
  square: squareProvider,
  paypal: paypalProvider,
};

// Returns the provider adapter for the workspace's configured choice,
// defaulting to Stripe so existing workspaces keep working with no
// migration needed. The settings row is fetched once and passed to the
// adapter so per-call DB hits stay zero.
export async function getProvider(workspaceId) {
  const settings = await fetchFinanceSettings(workspaceId);
  const name = settings?.paymentProvider || 'stripe';
  const adapter = REGISTRY[name] || REGISTRY.stripe;
  return { adapter, name, settings };
}

export function getProviderByName(name) {
  return REGISTRY[name] || null;
}

export const PROVIDER_NAMES = Object.keys(REGISTRY);

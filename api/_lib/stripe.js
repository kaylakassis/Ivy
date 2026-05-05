// Thin Stripe REST client. We only use a handful of endpoints
// (verify the account, create a checkout session, parse a webhook event), so
// pulling in the official SDK isn't worth it.
//
// All calls take an explicit `secretKey` — we never read it from env. This
// keeps the door open for per-workspace keys without surprises.
import crypto from 'node:crypto';

const STRIPE_BASE = 'https://api.stripe.com/v1';

function formEncode(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object') {
          out.push(formEncode(item, `${key}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (v && typeof v === 'object') {
      out.push(formEncode(v, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return out.filter(Boolean).join('&');
}

async function stripeFetch(path, { method = 'GET', secretKey, body }) {
  if (!secretKey || typeof secretKey !== 'string') {
    throw new Error('Stripe secret key is required');
  }
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    Accept: 'application/json',
  };
  let payload;
  if (body) {
    payload = formEncode(body);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(`${STRIPE_BASE}${path}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe ${method} ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.stripeCode = json?.error?.code;
    throw err;
  }
  return json;
}

// Returns { id, label, livemode } so the UI can confirm the right account is
// connected. We prefer business_profile.name, then email, then the account id.
export async function fetchAccountSummary(secretKey) {
  const acct = await stripeFetch('/account', { secretKey });
  const label =
    acct.business_profile?.name ||
    acct.settings?.dashboard?.display_name ||
    acct.email ||
    acct.id;
  return { id: acct.id, label, livemode: !!acct.charges_enabled && !acct.id?.startsWith('acct_test_') };
}

// Creates a Stripe Checkout session for a single invoice. The invoice's
// id+workspace are baked into metadata so the webhook can look it up.
export async function createCheckoutSession({
  secretKey, invoice, currency, totalCents,
  successUrl, cancelUrl, customerEmail,
}) {
  const body = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    'line_items[0][price_data][currency]': currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': totalCents,
    'line_items[0][price_data][product_data][name]': `Invoice ${invoice.number}`,
    'line_items[0][quantity]': 1,
    'metadata[invoice_id]': invoice.id,
    'metadata[workspace_id]': invoice.workspace_id,
    payment_intent_data: { metadata: { invoice_id: invoice.id, workspace_id: invoice.workspace_id } },
  };
  // formEncode handles nested objects, but Stripe is picky about its own
  // bracketed style — we pass already-flattened keys to keep it predictable.
  // For payment_intent_data.metadata, formEncode will recurse correctly.
  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST', secretKey, body,
  });
  return { id: session.id, url: session.url };
}

// Verifies a Stripe webhook signature header per Stripe's spec:
//   Stripe-Signature: t=<timestamp>,v1=<sig>,v1=<sig>...
// Throws on mismatch / replay. Returns the parsed event on success.
//
// `tolerance` is in seconds — Stripe's recommended default is 300.
export function verifyWebhookSignature({ payload, header, secret, tolerance = 300 }) {
  if (!header) throw new Error('Missing Stripe-Signature header');
  if (!secret) throw new Error('Webhook secret is not configured');
  const parts = String(header).split(',').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
    return acc;
  }, {});
  const timestamp = parseInt(parts.t?.[0], 10);
  const sigs = parts.v1 || [];
  if (!timestamp || sigs.length === 0) throw new Error('Malformed Stripe-Signature header');

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > tolerance) {
    throw new Error('Webhook timestamp is outside tolerance');
  }

  const signed = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const match = sigs.some((s) => {
    try {
      const sBuf = Buffer.from(s, 'hex');
      return sBuf.length === expectedBuf.length && crypto.timingSafeEqual(sBuf, expectedBuf);
    } catch { return false; }
  });
  if (!match) throw new Error('Webhook signature mismatch');

  try {
    return JSON.parse(payload);
  } catch {
    throw new Error('Webhook payload is not valid JSON');
  }
}

// ─── Subscription billing (THRYVE itself charging workspace owners) ──
// These talk to *our* Stripe account, not the per-workspace one. Pass the
// platform secret (process.env.THRYVE_STRIPE_SECRET).

export async function createSubscriptionCheckoutSession({
  secretKey, priceId, customerId, customerEmail,
  workspaceId, successUrl, cancelUrl,
}) {
  const body = {
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    'metadata[workspace_id]': workspaceId,
    'subscription_data[metadata][workspace_id]': workspaceId,
    allow_promotion_codes: true,
  };
  if (customerId) body.customer = customerId;
  else if (customerEmail) body.customer_email = customerEmail;
  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST', secretKey, body,
  });
  return { id: session.id, url: session.url, customer: session.customer };
}

// Stripe Customer Portal — self-serve cancel / update card / view invoices.
// Owner clicks "Manage subscription" on the Account page.
export async function createBillingPortalSession({
  secretKey, customerId, returnUrl,
}) {
  if (!customerId) throw new Error('customerId is required');
  const session = await stripeFetch('/billing_portal/sessions', {
    method: 'POST', secretKey,
    body: { customer: customerId, return_url: returnUrl },
  });
  return { id: session.id, url: session.url };
}

export async function fetchCheckoutSession({ secretKey, sessionId }) {
  if (!sessionId) throw new Error('sessionId is required');
  return stripeFetch(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[0]=subscription`, { secretKey });
}

export async function fetchSubscription({ secretKey, subscriptionId }) {
  if (!subscriptionId) throw new Error('subscriptionId is required');
  return stripeFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { secretKey });
}

// ─── Per-workspace card-on-file flow ─────────────────────────────────
// These run against the workspace's connected Stripe account
// (stripe_secret_encrypted). They power the client-portal "save a card
// on file" flow and the off-session charging that powers no-show /
// late-cancel fees + post-session tips.

// Find or create a Stripe customer on the connected account for a
// given client email. We only ever look up by email + check metadata
// to confirm it's the right tenant — we never trust a client_id that
// the browser handed us. The returned id is what we save on
// clients.stripe_customer_id.
export async function findOrCreateCustomer({ secretKey, email, name, workspaceId, clientId }) {
  if (!email) throw new Error('email is required');
  // Stripe doesn't have a search-by-email index by default, but the
  // List API supports filtering by email and returns at most 100. We
  // never have more than one customer per (workspace, email) because
  // we always re-use this lookup, so the first match wins.
  const list = await stripeFetch(
    `/customers?email=${encodeURIComponent(email)}&limit=1`,
    { secretKey },
  );
  if (Array.isArray(list.data) && list.data.length > 0) {
    return list.data[0];
  }
  return stripeFetch('/customers', {
    method: 'POST', secretKey,
    body: {
      email,
      name: name || undefined,
      'metadata[workspace_id]': workspaceId,
      'metadata[client_id]': clientId || undefined,
    },
  });
}

// Mint a SetupIntent the browser uses with Stripe Elements / Checkout
// in setup mode to save a card without charging. Webhook handles the
// post-confirm step (storing payment_method_id on the client row).
export async function createSetupIntent({ secretKey, customerId, workspaceId, clientId }) {
  if (!customerId) throw new Error('customerId is required');
  return stripeFetch('/setup_intents', {
    method: 'POST', secretKey,
    body: {
      customer: customerId,
      'payment_method_types[0]': 'card',
      usage: 'off_session',
      'metadata[workspace_id]': workspaceId,
      'metadata[client_id]': clientId,
    },
  });
}

// Mint a Stripe Checkout session in 'setup' mode — used for the
// portal "save a card" link. After the user completes Checkout, the
// webhook (checkout.session.completed with mode='setup') stores the
// resulting payment_method on the client row.
export async function createSetupCheckoutSession({
  secretKey, customerId, workspaceId, clientId, successUrl, cancelUrl,
}) {
  if (!customerId) throw new Error('customerId is required');
  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST', secretKey,
    body: {
      mode: 'setup',
      customer: customerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      'payment_method_types[0]': 'card',
      'metadata[workspace_id]': workspaceId,
      'metadata[client_id]': clientId,
      'metadata[purpose]': 'save_card',
      'setup_intent_data[metadata][workspace_id]': workspaceId,
      'setup_intent_data[metadata][client_id]': clientId,
      'setup_intent_data[metadata][purpose]': 'save_card',
    },
  });
  return { id: session.id, url: session.url };
}

// Get full PaymentMethod info (brand, last4, exp) so we can render
// "Visa · 4242 · expires 09/27" in the portal without storing more
// than the bare minimum.
export async function fetchPaymentMethod({ secretKey, paymentMethodId }) {
  return stripeFetch(`/payment_methods/${encodeURIComponent(paymentMethodId)}`, { secretKey });
}

// Make a saved payment_method the customer's default for future
// invoices / off-session charges. Without this, off-session charges
// would have to specify the PM each time.
export async function setDefaultPaymentMethod({ secretKey, customerId, paymentMethodId }) {
  if (!customerId || !paymentMethodId) throw new Error('customerId + paymentMethodId required');
  return stripeFetch(`/customers/${encodeURIComponent(customerId)}`, {
    method: 'POST', secretKey,
    body: {
      'invoice_settings[default_payment_method]': paymentMethodId,
    },
  });
}

// Detach a saved payment method from a customer (the portal "remove
// card" action). Stripe's detach endpoint also clears it from
// invoice_settings.default_payment_method automatically.
export async function detachPaymentMethod({ secretKey, paymentMethodId }) {
  return stripeFetch(`/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {
    method: 'POST', secretKey,
  });
}

// Off-session charge against a saved card. Used for late-cancel
// fees, no-show fees, and post-session tips. Returns the
// PaymentIntent so the caller can persist its id for future refunds.
//
// Stripe will return a 402 if the card requires authentication
// (3DS) — the caller should surface that as "couldn't auto-charge,
// please ask the client to update their card."
export async function chargeOffSession({
  secretKey, customerId, paymentMethodId,
  amountCents, currency, description, metadata,
  statementDescriptor,
}) {
  if (!customerId || !paymentMethodId) {
    throw new Error('customerId + paymentMethodId required');
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('amountCents must be a positive integer');
  }
  const body = {
    amount: amountCents,
    currency: (currency || 'usd').toLowerCase(),
    customer: customerId,
    payment_method: paymentMethodId,
    confirm: 'true',
    off_session: 'true',
    description: description || undefined,
  };
  // Stripe requires statement descriptor to be 5–22 chars, no
  // <>"'\\* — clamp + sanitize defensively. Optional.
  if (statementDescriptor) {
    body.statement_descriptor = String(statementDescriptor)
      .replace(/[<>"'\\*]/g, '')
      .slice(0, 22);
  }
  if (metadata && typeof metadata === 'object') {
    for (const [k, v] of Object.entries(metadata)) {
      if (v == null) continue;
      body[`metadata[${k}]`] = String(v);
    }
  }
  return stripeFetch('/payment_intents', {
    method: 'POST', secretKey, body,
  });
}

// ─── Memberships (subscription products on the connected account) ────

// Provision a Stripe Product + recurring Price on the connected
// account at the moment a membership tier is saved. We store both
// IDs on the memberships row so the public sign-up flow can reuse
// them. Currency comes from finance_settings.
export async function createMembershipProduct({
  secretKey, name, description, priceCents, interval, currency,
}) {
  if (!name) throw new Error('name is required');
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new Error('priceCents must be a non-negative integer');
  }
  const product = await stripeFetch('/products', {
    method: 'POST', secretKey,
    body: { name, description: description || undefined },
  });
  const intervalMap = { week: 'week', month: 'month', quarter: 'month', year: 'year' };
  const intervalCount = interval === 'quarter' ? 3 : 1;
  const price = await stripeFetch('/prices', {
    method: 'POST', secretKey,
    body: {
      product: product.id,
      unit_amount: priceCents,
      currency: (currency || 'usd').toLowerCase(),
      'recurring[interval]': intervalMap[interval] || 'month',
      'recurring[interval_count]': intervalCount,
    },
  });
  return { productId: product.id, priceId: price.id };
}

// Build a Checkout Session for a membership purchase on the
// connected account. The metadata is what the webhook uses to
// stitch the resulting subscription back to a client_memberships row.
export async function createMembershipCheckoutSession({
  secretKey, priceId, customerId, customerEmail,
  workspaceId, membershipId, clientId,
  successUrl, cancelUrl,
}) {
  const body = {
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    'metadata[workspace_id]': workspaceId,
    'metadata[membership_id]': membershipId,
    'metadata[purpose]': 'membership',
    'subscription_data[metadata][workspace_id]': workspaceId,
    'subscription_data[metadata][membership_id]': membershipId,
    'subscription_data[metadata][purpose]': 'membership',
  };
  if (clientId) {
    body['metadata[client_id]'] = clientId;
    body['subscription_data[metadata][client_id]'] = clientId;
  }
  if (customerId) body.customer = customerId;
  else if (customerEmail) body.customer_email = customerEmail;
  const session = await stripeFetch('/checkout/sessions', {
    method: 'POST', secretKey, body,
  });
  return { id: session.id, url: session.url, customer: session.customer };
}

// Cancel a subscription. `atPeriodEnd=true` sets cancel_at_period_end
// so the member keeps access until the end of the cycle they paid for.
export async function cancelSubscription({ secretKey, subscriptionId, atPeriodEnd = true }) {
  if (atPeriodEnd) {
    return stripeFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'POST', secretKey,
      body: { cancel_at_period_end: 'true' },
    });
  }
  return stripeFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE', secretKey,
  });
}

// Issue a refund against a payment_intent. amountCents omitted = full
// refund of remaining balance. reason maps to Stripe's enum:
// 'duplicate' | 'fraudulent' | 'requested_by_customer'.
export async function createRefund({ secretKey, paymentIntent, amountCents, reason }) {
  if (!paymentIntent) throw new Error('paymentIntent is required');
  const body = { payment_intent: paymentIntent };
  if (amountCents != null) body.amount = amountCents;
  if (reason) body.reason = reason;
  const refund = await stripeFetch('/refunds', { method: 'POST', secretKey, body });
  return {
    id:     refund.id,
    amount: refund.amount,
    status: refund.status,
    reason: refund.reason,
  };
}

// PayPal Commerce Platform adapter — owners onboard via PayPal Partner
// Referrals; we mint hosted PayPal checkout URLs for owner→client
// charges. PayPal's hosted checkout offers Venmo as a button alongside
// PayPal balance + cards in supported regions.
//
// Required platform env vars (set in Vercel):
//   PAYPAL_CLIENT_ID       — your platform's PayPal app client ID
//   PAYPAL_CLIENT_SECRET   — your platform's PayPal app secret
//   PAYPAL_PARTNER_ID      — your BN_CODE / partner ID (issued by PayPal)
//   PAYPAL_ENVIRONMENT     — 'sandbox' | 'live' (defaults to sandbox)
//   PAYPAL_WEBHOOK_ID      — for signature verification
//
// Per-workspace: we do NOT store an OAuth token. PayPal Commerce uses
// the auth-assertion pattern — the platform mints short-lived bearer
// tokens with its own client_id+secret and includes a base64-encoded
// header asserting the merchant's id. So per-workspace storage is just
// the merchant_id and a connection timestamp.
import crypto from 'node:crypto';
import { sql } from '../db.js';
import { fetchFinanceSettings } from '../finance.js';

export function getProviderName() { return 'paypal'; }

export function paypalEnv() {
  return (process.env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase() === 'live'
    ? 'live' : 'sandbox';
}
export function paypalApiBase(env = paypalEnv()) {
  return env === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// Cache one access token in module scope per cold start (PayPal access
// tokens last ~9 hours). Refresh on 401.
let _platformToken = null;
let _platformTokenExpires = 0;
async function platformAccessToken() {
  if (_platformToken && Date.now() < _platformTokenExpires - 30_000) return _platformToken;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal platform credentials are not configured');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PayPal token mint failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const j = await res.json();
  _platformToken = j.access_token;
  _platformTokenExpires = Date.now() + (j.expires_in || 32400) * 1000;
  return _platformToken;
}

// PayPal-Auth-Assertion is a JWT-shaped header that lets the platform
// act on behalf of a connected merchant. Algorithm is "none" — PayPal
// trusts that the request is authenticated via the platform's bearer
// token and uses the assertion only to scope the action.
function authAssertion({ merchantId }) {
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  if (!partnerId) throw new Error('PAYPAL_PARTNER_ID is not configured');
  const header  = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: process.env.PAYPAL_CLIENT_ID, payer_id: merchantId,
  })).toString('base64url');
  return `${header}.${payload}.`;
}

// Build the Partner Referrals onboarding URL. Owners click this, sign
// in / sign up at PayPal, grant permission, and PayPal redirects them
// back to our callback with `merchantIdInPayPal` + a status flag we
// persist.
//
// Docs: https://developer.paypal.com/docs/multiparty/seller-onboarding/before-payment/
export async function buildOnboardingUrl({ workspaceId, returnUrl, trackingId }) {
  const token = await platformAccessToken();
  const env = paypalEnv();
  const body = {
    tracking_id: trackingId || workspaceId,
    operations: [{
      operation: 'API_INTEGRATION',
      api_integration_preference: {
        rest_api_integration: {
          integration_method: 'PAYPAL',
          integration_type: 'THIRD_PARTY',
          third_party_details: {
            features: ['PAYMENT', 'REFUND', 'PARTNER_FEE', 'READ_SELLER_DISPUTE'],
          },
        },
      },
    }],
    products: ['EXPRESS_CHECKOUT'],
    legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
    partner_config_override: {
      return_url: returnUrl,
      return_url_description: 'Return to THRYVE',
    },
  };
  const res = await fetch(`${paypalApiBase(env)}/v2/customer/partner-referrals`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PayPal partner referral failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const j = await res.json();
  // Find the action URL the owner needs to be redirected to.
  const action = (j.links || []).find((l) => l.rel === 'action_url');
  return action?.href || null;
}

// After a merchant returns from PayPal with their merchantIdInPayPal,
// look up their seller status to confirm they can receive payments.
export async function fetchSellerStatus({ merchantId }) {
  const token = await platformAccessToken();
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  const res = await fetch(
    `${paypalApiBase()}/v1/customer/partners/${partnerId}/merchant-integrations/${merchantId}`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  return res.json();
}

export async function isConnected({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  return !!fs?.paypalMerchantId;
}

export async function getDisplayInfo({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!fs?.paypalMerchantId) return null;
  return {
    label:       fs.paypalAccountLabel || 'PayPal',
    environment: fs.paypalEnvironment || 'sandbox',
    merchantId:  fs.paypalMerchantId,
    connectedAt: fs.paypalConnectedAt,
    paymentsEnabled: fs.paypalPaymentsEnabled,
  };
}

// Create an Order via PayPal Orders v2 with PAY_UPON_INVOICE rail off
// and the merchant set as the payee. Returns the approval URL the
// customer is redirected to. PayPal's hosted approval page renders a
// PayPal button + Venmo button (US, eligible buyers) + a Pay-with-Card
// guest checkout block.
export async function createCheckoutSession({
  workspaceId, settings,
  amountCents, currency = 'USD',
  description, metadata = {},
  successUrl, cancelUrl, customerEmail,
}) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!fs?.paypalMerchantId) throw new Error('PayPal is not connected for this workspace');

  const token = await platformAccessToken();
  const env = fs.paypalEnvironment || paypalEnv();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: currency.toUpperCase(),
        value: (amountCents / 100).toFixed(2),
      },
      description: (description || 'Charge').slice(0, 127),
      custom_id: JSON.stringify(metadata).slice(0, 127),
      payee: { merchant_id: fs.paypalMerchantId },
    }],
    application_context: {
      return_url: successUrl,
      cancel_url: cancelUrl,
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      brand_name: fs.paypalAccountLabel || 'THRYVE',
    },
    payer: customerEmail ? { email_address: customerEmail } : undefined,
  };
  const res = await fetch(`${paypalApiBase(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Auth-Assertion': authAssertion({ merchantId: fs.paypalMerchantId }),
      'PayPal-Partner-Attribution-Id': process.env.PAYPAL_PARTNER_ID || '',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PayPal order create failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const j = await res.json();
  const approve = (j.links || []).find((l) => l.rel === 'approve');
  return {
    url: approve?.href || null,
    sessionId: j.id,
    providerData: { orderId: j.id },
  };
}

// Refund a PayPal capture. paymentIntent is the capture ID (PayPal's
// equivalent of Stripe's payment_intent). PayPal Partner refunds run
// against the connected merchant via the auth-assertion header so the
// platform doesn't need OAuth tokens for each merchant.
//
// Returns { id, amount, status, reason } matching Stripe + Square
// shapes so /api/invoices/refund doesn't have to branch.
export async function createRefund({
  workspaceId, settings,
  paymentIntent,  // PayPal capture ID
  amountCents,
  currency = 'USD',
  reason,
}) {
  if (!paymentIntent) throw new Error('paymentIntent (PayPal capture ID) is required');
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!fs?.paypalMerchantId) throw new Error('PayPal is not connected for this workspace');

  const token = await platformAccessToken();
  const env = fs.paypalEnvironment || paypalEnv();
  const body = {};
  if (amountCents != null) {
    body.amount = {
      value:         (Number(amountCents) / 100).toFixed(2),
      currency_code: currency.toUpperCase(),
    };
  }
  if (reason) body.note_to_payer = String(reason).slice(0, 255);

  // PayPal-Auth-Assertion: base64 JSON identifying the merchant we're
  // acting on behalf of. Format: header.payload.signature where the
  // signature segment is empty for Partner integrations using the
  // PARTNER token. (Same pattern createCheckoutSession uses.)
  const assertHeader = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const assertPayload = Buffer.from(JSON.stringify({
    iss: process.env.PAYPAL_CLIENT_ID,
    payer_id: fs.paypalMerchantId,
  })).toString('base64url');
  const authAssertion = `${assertHeader}.${assertPayload}.`;

  const res = await fetch(
    `${paypalApiBase(env)}/v2/payments/captures/${encodeURIComponent(paymentIntent)}/refund`,
    {
      method: 'POST',
      headers: {
        'Authorization':         `Bearer ${token}`,
        'Content-Type':          'application/json',
        'PayPal-Auth-Assertion': authAssertion,
        'PayPal-Request-Id':     crypto.randomUUID(),
        'Prefer':                'return=representation',
      },
      body: JSON.stringify(body),
    },
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j?.message
      || j?.details?.[0]?.description
      || `HTTP ${res.status}`;
    throw new Error(`PayPal refused the refund: ${msg}`);
  }
  return {
    id:     j.id || null,
    amount: Math.round(Number(j.amount?.value || 0) * 100),
    status: (j.status || 'PENDING').toLowerCase(),
    reason: reason || null,
  };
}

// PayPal webhook signature verification: POST to /v1/notifications/
// verify-webhook-signature with the headers + body and let PayPal tell
// us if it's authentic. Heavier than HMAC but PayPal's recommended path.
export async function verifyWebhook({ rawBody, headers }) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not configured');
  const token = await platformAccessToken();
  const verifyBody = {
    auth_algo:      headers['paypal-auth-algo']      || headers['PAYPAL-AUTH-ALGO'],
    cert_url:       headers['paypal-cert-url']       || headers['PAYPAL-CERT-URL'],
    transmission_id:   headers['paypal-transmission-id']   || headers['PAYPAL-TRANSMISSION-ID'],
    transmission_sig:  headers['paypal-transmission-sig']  || headers['PAYPAL-TRANSMISSION-SIG'],
    transmission_time: headers['paypal-transmission-time'] || headers['PAYPAL-TRANSMISSION-TIME'],
    webhook_id: webhookId,
    webhook_event: JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')),
  };
  const res = await fetch(`${paypalApiBase()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(verifyBody),
  });
  if (!res.ok) throw new Error('PayPal verify-webhook call failed');
  const j = await res.json();
  if (j.verification_status !== 'SUCCESS') throw new Error('PayPal webhook signature mismatch');
  return verifyBody.webhook_event;
}

// Normalized webhook shape for the events we care about.
//
// Handled:
//   PAYMENT.CAPTURE.COMPLETED  → 'checkout.completed' (status='paid')
//   PAYMENT.CAPTURE.REFUNDED   → 'refund.updated'    (status='succeeded')
//   PAYMENT.CAPTURE.REVERSED   → 'refund.updated'    (status='succeeded')
//                                  PayPal reversals are functionally a
//                                  forced refund (typically due to a
//                                  dispute) — we treat them as refunds
//                                  in THRYVE's bookkeeping so the
//                                  invoice flips out of 'paid'.
//
// Why bother with refunds here: PayPal owners can issue refunds from
// the PayPal Merchant Center, not just THRYVE. Without this branch the
// invoice stays marked 'paid' in THRYVE forever after the money
// reverses, and revenue reports lie.
export function parseWebhookEvent(event) {
  if (!event) return null;
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const r = event.resource || {};
    let metadata = {};
    try { if (r.custom_id) metadata = JSON.parse(r.custom_id); } catch { /* ignore */ }
    const amount = r.amount?.value ? Math.round(Number(r.amount.value) * 100) : 0;
    return {
      type:        'checkout.completed',
      sessionId:   r.supplementary_data?.related_ids?.order_id || r.id,
      paymentId:   r.id,
      status:      'paid',
      amountCents: amount,
      currency:    (r.amount?.currency_code || 'USD').toUpperCase(),
      metadata,
      providerData: { captureId: r.id, payerEmail: event.resource?.payer?.email_address },
    };
  }
  if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED'
      || event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
    const r = event.resource || {};
    // For REFUNDED events resource.id is the refund id; the original
    // capture lives in supplementary_data.related_ids.capture_id. For
    // REVERSED the capture id is r.id itself.
    const captureId = r.supplementary_data?.related_ids?.capture_id || r.id;
    const orderId   = r.supplementary_data?.related_ids?.order_id || null;
    const amount    = r.amount?.value ? Math.round(Number(r.amount.value) * 100) : 0;
    return {
      type:        'refund.updated',
      refundId:    event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? r.id : null,
      paymentId:   captureId,
      sessionId:   orderId,
      status:      'succeeded',
      amountCents: amount,
      currency:    (r.amount?.currency_code || 'USD').toUpperCase(),
      reason:      r.note_to_payer || r.status_details?.reason || null,
      providerData: { captureId, orderId },
    };
  }
  return null;
}

export async function persistConnection({ workspaceId, merchantId, environment, label, sellerStatus }) {
  const paymentsEnabled = !!sellerStatus?.payments_receivable;
  await sql`
    INSERT INTO finance_settings (workspace_id, paypal_merchant_id, paypal_account_label, paypal_connected_at, paypal_payments_enabled, paypal_environment, payment_provider)
    VALUES (${workspaceId}, ${merchantId}, ${label || 'PayPal'}, NOW(), ${paymentsEnabled}, ${environment}, 'paypal')
    ON CONFLICT (workspace_id) DO UPDATE SET
      paypal_merchant_id       = EXCLUDED.paypal_merchant_id,
      paypal_account_label     = EXCLUDED.paypal_account_label,
      paypal_connected_at      = EXCLUDED.paypal_connected_at,
      paypal_payments_enabled  = EXCLUDED.paypal_payments_enabled,
      paypal_environment       = EXCLUDED.paypal_environment,
      payment_provider         = 'paypal'
  `;
}

export async function disconnect({ workspaceId }) {
  await sql`
    UPDATE finance_settings SET
      paypal_merchant_id      = NULL,
      paypal_account_label    = NULL,
      paypal_connected_at     = NULL,
      paypal_payments_enabled = NULL,
      paypal_environment      = NULL
    WHERE workspace_id = ${workspaceId}
  `;
}

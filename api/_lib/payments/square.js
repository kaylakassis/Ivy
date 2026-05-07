// Square adapter — owners connect their own Square account via OAuth;
// we mint hosted Square Checkout links for owner→client charges. The
// hosted page automatically offers Cash App Pay as a payment option in
// supported regions, alongside cards.
//
// Required platform env vars (set in Vercel):
//   SQUARE_APPLICATION_ID       — your Square app's public ID
//   SQUARE_APPLICATION_SECRET   — your Square app's secret (OAuth code exchange)
//   SQUARE_ENVIRONMENT          — 'sandbox' | 'production' (defaults to sandbox)
//   SQUARE_WEBHOOK_SIGNATURE_KEY (optional) — for verifying webhook events
//
// Per-workspace credentials are stored in finance_settings.square_*:
//   square_credentials_encrypted — JSON { access_token, refresh_token, expires_at }
//   square_merchant_id           — for the Square-Merchant-Id header on writes
//   square_location_id           — default location used for checkouts
//   square_environment           — 'sandbox' | 'production' (matches the env at connect time)
import crypto from 'node:crypto';
import { sql } from '../db.js';
import { encrypt, decrypt } from '../secrets.js';
import { fetchFinanceSettings } from '../finance.js';

export function getProviderName() { return 'square'; }

export function squareEnv() {
  return (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase() === 'production'
    ? 'production' : 'sandbox';
}
export function squareApiBase(env = squareEnv()) {
  return env === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}
export function squareOAuthBase(env = squareEnv()) {
  return env === 'production'
    ? 'https://connect.squareup.com/oauth2/authorize'
    : 'https://connect.squareupsandbox.com/oauth2/authorize';
}

// Scopes we ask for at Connect time — wide enough for hosted-checkout
// link creation, payment lookup, and refunds. Square requires every
// scope to be pre-declared in the app's dashboard.
const SQUARE_SCOPES = [
  'PAYMENTS_WRITE', 'PAYMENTS_READ',
  'ORDERS_WRITE',   'ORDERS_READ',
  'MERCHANT_PROFILE_READ',
  'CUSTOMERS_READ',
];

export function buildAuthorizeUrl({ state, redirectUri }) {
  const env = squareEnv();
  const u = new URL(squareOAuthBase(env));
  u.searchParams.set('client_id', process.env.SQUARE_APPLICATION_ID || '');
  u.searchParams.set('scope', SQUARE_SCOPES.join(' '));
  u.searchParams.set('session', 'false');
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', redirectUri);
  return u.toString();
}

// Exchanges the OAuth `code` from Square's redirect for a permanent
// access_token + refresh_token + merchant_id. Returns the decoded JSON
// so the caller can encrypt + persist it.
export async function exchangeOAuthCode({ code, redirectUri }) {
  const res = await fetch(`${squareApiBase()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': '2024-10-17' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APPLICATION_ID,
      client_secret: process.env.SQUARE_APPLICATION_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Square OAuth exchange failed (${res.status}): ${text.slice(0, 240)}`);
  }
  return res.json();
}

// Fetch the merchant's first location — checkouts need a location_id.
// Owners can change it later from settings if they have multiple.
export async function fetchFirstLocation({ accessToken }) {
  const res = await fetch(`${squareApiBase()}/v2/locations`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Square-Version': '2024-10-17',
    },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.locations?.[0] || null;
}

async function loadSquareCreds(settings) {
  if (!settings?.squareCredentialsEncrypted) {
    throw new Error('Square is not connected for this workspace');
  }
  let creds;
  try {
    creds = JSON.parse(decrypt(settings.squareCredentialsEncrypted));
  } catch {
    throw new Error('Square credentials are misconfigured');
  }
  return creds;
}

export async function isConnected({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  return !!(fs?.squareCredentialsEncrypted && fs?.squareMerchantId);
}

export async function getDisplayInfo({ workspaceId, settings }) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  if (!fs?.squareMerchantId) return null;
  return {
    label:       fs.squareAccountLabel || 'Square',
    environment: fs.squareEnvironment || 'sandbox',
    merchantId:  fs.squareMerchantId,
    connectedAt: fs.squareConnectedAt,
    locationId:  fs.squareLocationId,
  };
}

// Creates a Square Checkout link via the Online Checkout API. Returns
// the hosted-page URL; the customer pays there (cards + Cash App Pay
// where eligible) and Square POSTs us a webhook on success.
//
// Square's hosted checkout takes a quick_pay shape for one-line items:
//   POST /v2/online-checkout/payment-links
//   { idempotency_key, quick_pay: { name, price_money: { amount, currency }, location_id }, ... }
export async function createCheckoutSession({
  workspaceId, settings,
  amountCents, currency = 'USD',
  description, metadata = {},
  successUrl, cancelUrl, customerEmail,
}) {
  const fs = settings || await fetchFinanceSettings(workspaceId);
  const creds = await loadSquareCreds(fs);
  const env = fs.squareEnvironment || squareEnv();
  const locationId = fs.squareLocationId;
  if (!locationId) throw new Error('Square location is not set for this workspace');

  const idempotencyKey = crypto.randomUUID();
  const body = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: (description || 'Charge').slice(0, 255),
      price_money: { amount: amountCents, currency: currency.toUpperCase() },
      location_id: locationId,
    },
    checkout_options: {
      redirect_url: successUrl,
      // Square accepts ASCII-only metadata via note; we stash a flat
      // version of metadata so the webhook handler can correlate back.
      ask_for_shipping_address: false,
    },
    pre_populated_data: customerEmail ? { buyer_email: customerEmail } : undefined,
  };
  // Square's "Note" field surfaces on the merchant receipt + webhook.
  // Use it to carry our metadata as a key=value blob; clip to 60 char
  // since longer notes get truncated in the dashboard.
  const noteBits = Object.entries(metadata).slice(0, 5)
    .map(([k, v]) => `${k}=${String(v).slice(0, 16)}`).join(' ');
  if (noteBits) body.quick_pay.name = `${body.quick_pay.name} | ${noteBits}`.slice(0, 255);

  const res = await fetch(`${squareApiBase(env)}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.access_token}`,
      'Square-Version': '2024-10-17',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Square checkout link failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const j = await res.json();
  return {
    url:        j.payment_link?.url,
    sessionId:  j.payment_link?.id,
    providerData: { orderId: j.payment_link?.order_id, paymentLinkId: j.payment_link?.id },
  };
}

// Webhook signature: HMAC-SHA1 of (notification_url + raw_body) with
// the signature key from the Square Developer Dashboard. Returns the
// parsed event JSON; throws on mismatch / missing key.
export function verifyWebhook({ rawBody, headers, notificationUrl }) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key) throw new Error('Square webhook signature key is not configured');
  const sig = headers['x-square-hmacsha256-signature']
           || headers['X-Square-Hmacsha256-Signature'];
  if (!sig) throw new Error('Missing X-Square-HmacSha256-Signature header');
  const url = notificationUrl || '';
  const expected = crypto.createHmac('sha256', key)
    .update(url + (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')))
    .digest('base64');
  if (expected !== sig) throw new Error('Square webhook signature mismatch');
  return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
}

// Maps Square's payment / order events to the abstraction's flat shape.
// We only normalize payment.created and payment.updated for now; other
// event types fall through and the handler no-ops.
export function parseWebhookEvent(event) {
  if (!event) return null;
  const type = event.type;
  if (type === 'payment.created' || type === 'payment.updated') {
    const p = event.data?.object?.payment || {};
    return {
      type:        'checkout.completed',
      sessionId:   p.order_id || p.id,
      paymentId:   p.id,
      status:      p.status === 'COMPLETED' ? 'paid' : (p.status || 'unknown').toLowerCase(),
      amountCents: p.amount_money?.amount || 0,
      currency:    (p.amount_money?.currency || 'USD').toUpperCase(),
      metadata:    {},
      providerData: { orderId: p.order_id, customerEmail: p.buyer_email_address },
    };
  }
  return null;
}

// Persist a fresh OAuth-exchange result. Called by the OAuth callback
// after exchangeOAuthCode + fetchFirstLocation.
export async function persistConnection({ workspaceId, oauthResult, location, environment, label }) {
  const credsJson = JSON.stringify({
    access_token:  oauthResult.access_token,
    refresh_token: oauthResult.refresh_token || null,
    expires_at:    oauthResult.expires_at || null,
  });
  const enc = encrypt(credsJson);
  const merchantId = oauthResult.merchant_id;
  const locationId = location?.id || null;
  await sql`
    INSERT INTO finance_settings (workspace_id, square_credentials_encrypted, square_merchant_id, square_location_id, square_account_label, square_connected_at, square_environment, payment_provider)
    VALUES (${workspaceId}, ${enc}, ${merchantId}, ${locationId}, ${label || location?.name || 'Square'}, NOW(), ${environment}, 'square')
    ON CONFLICT (workspace_id) DO UPDATE SET
      square_credentials_encrypted = EXCLUDED.square_credentials_encrypted,
      square_merchant_id           = EXCLUDED.square_merchant_id,
      square_location_id           = COALESCE(finance_settings.square_location_id, EXCLUDED.square_location_id),
      square_account_label         = EXCLUDED.square_account_label,
      square_connected_at          = EXCLUDED.square_connected_at,
      square_environment           = EXCLUDED.square_environment,
      payment_provider             = 'square'
  `;
}

export async function disconnect({ workspaceId }) {
  await sql`
    UPDATE finance_settings SET
      square_credentials_encrypted = NULL,
      square_merchant_id           = NULL,
      square_location_id           = NULL,
      square_account_label         = NULL,
      square_connected_at          = NULL,
      square_environment           = NULL
    WHERE workspace_id = ${workspaceId}
  `;
}

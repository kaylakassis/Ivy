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

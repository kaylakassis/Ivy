// App Store Server API client - the one call we need: "Extend a
// Subscription Renewal Date". This is how an Apple-billed owner gets a
// referral reward: we cannot credit an Apple customer's balance (Apple
// bills them, not us), so we push their next renewal out by 7 days per
// earned week instead.
//
//   PUT https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/extend/{originalTransactionId}
//   body: { extendByDays, extendReasonCode, requestIdentifier }
//   auth: Bearer <ES256 JWT signed with the In-App Purchase key>
//
// Zero dependencies on purpose (same reasoning as apns.js): the JWT is a
// few lines of node:crypto, and the request is a plain fetch.
//
// Required env (reads lazily on every call so a hot-reloaded or freshly
// set var is picked up without a restart):
//   APP_STORE_ISSUER_ID    Issuer ID from App Store Connect → Users and
//                          Access → Integrations → In-App Purchase
//   APP_STORE_KEY_ID       Key ID of that In-App Purchase key
//   APP_STORE_PRIVATE_KEY  the .p8 contents (BEGIN PRIVATE KEY ...).
//                          Literal "\n" escapes are tolerated.
//   APP_STORE_BUNDLE_ID    falls back to APNS_BUNDLE_ID, then the app id
//   APP_STORE_ENV          'production' (default) | 'sandbox'. Falls back
//                          to APNS_ENV so a sandbox build only needs one
//                          switch.
//
// Apple's rules for this endpoint (enforced server-side by Apple, mirrored
// in api/_lib/referrals.js so we never make a call that will be refused):
//   - at most 90 days per extension
//   - at most two extensions per subscription in any 365-day window
//   - the subscription must be active (not expired or refunded)
import crypto from 'node:crypto';
import { fetchWithTimeout } from './fetchTimeout.js';

const HOSTS = {
  production: 'https://api.storekit.itunes.apple.com',
  sandbox:    'https://api.storekit-sandbox.itunes.apple.com',
};

// Customer satisfaction / other reasons per Apple's extendReasonCode enum:
//   0 undeclared, 1 customer satisfaction, 2 other, 3 service issue.
export const REASON_CUSTOMER_SATISFACTION = 1;

const MAX_DAYS_PER_EXTENSION = 90;
const TOKEN_TTL_SECONDS = 1200; // Apple caps App Store Server API tokens at 20 minutes

function readEnv() {
  const env = String(process.env.APP_STORE_ENV || process.env.APNS_ENV || 'production').toLowerCase();
  return {
    issuerId:   String(process.env.APP_STORE_ISSUER_ID || '').trim(),
    keyId:      String(process.env.APP_STORE_KEY_ID || '').trim(),
    privateKey: String(process.env.APP_STORE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(),
    bundleId:   String(process.env.APP_STORE_BUNDLE_ID || process.env.APNS_BUNDLE_ID || 'ai.joinivy.app').trim(),
    host:       env === 'sandbox' ? HOSTS.sandbox : HOSTS.production,
    env:        env === 'sandbox' ? 'sandbox' : 'production',
  };
}

// Which of the required vars are missing. Empty when fully configured.
export function appleConfigMissing() {
  const e = readEnv();
  const missing = [];
  if (!e.issuerId) missing.push('APP_STORE_ISSUER_ID');
  if (!e.keyId) missing.push('APP_STORE_KEY_ID');
  if (!e.privateKey) missing.push('APP_STORE_PRIVATE_KEY');
  if (!e.bundleId) missing.push('APP_STORE_BUNDLE_ID');
  return missing;
}

export function appleConfigured() {
  return appleConfigMissing().length === 0;
}

export function appleEnvironment() {
  return readEnv().env;
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Mint a fresh ES256 JWT for the App Store Server API. Exported for tests
// and the readiness probe; callers inside this module mint per request
// (the call volume is tiny, and a fresh token sidesteps clock-skew expiry).
//
// ES256 = ECDSA over P-256 with SHA-256. node:crypto emits ASN.1 DER by
// default; JWS wants the raw 64-byte r||s concatenation, which is what
// dsaEncoding 'ieee-p1363' produces. Never logs or returns the key.
export function mintToken({ now = Date.now() } = {}) {
  const missing = appleConfigMissing();
  if (missing.length) throw new Error(`App Store Server API not configured: missing ${missing.join(', ')}`);
  const e = readEnv();
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: e.keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: e.issuerId,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    aud: 'appstoreconnect-v1',
    bid: e.bundleId,
  }));
  const signingInput = `${header}.${payload}`;
  let key;
  try {
    key = crypto.createPrivateKey(e.privateKey);
  } catch (err) {
    throw new Error(`APP_STORE_PRIVATE_KEY could not be parsed as a PEM private key (${err.message})`);
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(`APP_STORE_PRIVATE_KEY is a ${key.asymmetricKeyType} key; the In-App Purchase key must be an EC P-256 key`);
  }
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

// Push the subscription's next renewal date out by `days` (1..90).
// Returns { ok, status, effectiveDate?, requestId, error? } and never
// throws: callers (webhooks, sweeps) must stay up whatever Apple says.
export async function extendRenewalDate({ originalTransactionId, days, reason = REASON_CUSTOMER_SATISFACTION, requestId } = {}) {
  const id = String(originalTransactionId || '').trim();
  const n = Math.floor(Number(days));
  const requestIdentifier = requestId || crypto.randomUUID();
  if (!id) return { ok: false, status: 0, requestId: requestIdentifier, error: 'originalTransactionId is required' };
  if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS_PER_EXTENSION) {
    return { ok: false, status: 0, requestId: requestIdentifier, error: `days must be between 1 and ${MAX_DAYS_PER_EXTENSION}` };
  }
  if (!appleConfigured()) {
    return { ok: false, status: 0, requestId: requestIdentifier, error: `App Store Server API not configured: missing ${appleConfigMissing().join(', ')}` };
  }

  let token;
  try {
    token = mintToken();
  } catch (err) {
    return { ok: false, status: 0, requestId: requestIdentifier, error: err.message };
  }

  const { host } = readEnv();
  const url = `${host}/inApps/v1/subscriptions/extend/${encodeURIComponent(id)}`;
  const body = JSON.stringify({
    extendByDays: n,
    extendReasonCode: Number.isInteger(reason) ? reason : REASON_CUSTOMER_SATISFACTION,
    requestIdentifier,
  });

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body,
    }, 10000);
  } catch (err) {
    return { ok: false, status: 0, requestId: requestIdentifier, error: `network: ${err.message}` };
  }

  let data = null;
  try { data = await resp.json(); } catch { data = null; }

  if (!resp.ok || data?.success === false) {
    // Apple's error shape: { errorCode, errorMessage }. Keep both so the
    // ledger note is useful when reconciling by hand.
    const code = data?.errorCode != null ? ` ${data.errorCode}` : '';
    const msg = data?.errorMessage || (data?.success === false ? 'Apple reported success=false' : resp.statusText || 'request failed');
    return { ok: false, status: resp.status, requestId: requestIdentifier, error: `apple ${resp.status}${code}: ${msg}` };
  }

  const effMs = Number(data?.effectiveDate);
  const effectiveDate = Number.isFinite(effMs) && effMs > 0 ? new Date(effMs) : null;
  return { ok: true, status: resp.status, requestId: requestIdentifier, effectiveDate };
}

export { MAX_DAYS_PER_EXTENSION };

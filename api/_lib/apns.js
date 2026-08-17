// APNs (Apple Push Notification service) sender - native iOS pushes.
//
// Zero dependencies on purpose: the only maintained npm APNs clients
// drag in large HTTP/2 wrappers, while everything needed is in
// node:http2 (APNs speaks plain HTTP/2 POST) and node:crypto (the
// provider token is an ES256 JWT signed with the .p8 key). This also
// keeps the serverless bundle small.
//
// Required env (sends silently no-op without them):
//   APNS_TEAM_ID       10-char Apple Developer Team ID
//   APNS_KEY_ID        10-char Key ID of the APNs Auth Key
//   APNS_PRIVATE_KEY   contents of the .p8 file (BEGIN PRIVATE KEY...).
//                      Vercel env vars keep newlines; literal "\n" is
//                      also tolerated.
//   APNS_BUNDLE_ID     defaults to com.getivyos.app
//   APNS_ENV           'production' (default) | 'sandbox'. TestFlight
//                      and App Store builds use PRODUCTION; sandbox is
//                      only for direct-from-Xcode development builds.
//
// Provider-token rules (Apple): tokens must be 20-60 minutes old at
// most; we cache for 45 and re-sign. One token authorizes every send
// for the team, across connections.
import http2 from 'node:http2';
import crypto from 'node:crypto';

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox:    'https://api.sandbox.push.apple.com',
};

export function isApnsConfigured() {
  return !!(process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_PRIVATE_KEY);
}

function privateKeyPem() {
  // Vercel stores multi-line secrets verbatim, but people also paste
  // single-line values with escaped newlines - accept both.
  return String(process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

// ── Provider JWT ─────────────────────────────────────────────────────
let cachedJwt = null;
let cachedJwtAt = 0;
const JWT_TTL_MS = 45 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function buildProviderJwt(now = Date.now()) {
  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID }));
  const claims  = b64url(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }));
  const signing = `${header}.${claims}`;
  // ES256 = ECDSA P-256 + SHA-256, and JWT wants the raw (r||s) 64-byte
  // signature, not ASN.1 DER - dsaEncoding handles that.
  const sig = crypto.sign('sha256', Buffer.from(signing), {
    key: privateKeyPem(),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signing}.${b64url(sig)}`;
}

function providerJwt() {
  const now = Date.now();
  if (!cachedJwt || now - cachedJwtAt > JWT_TTL_MS) {
    cachedJwt = buildProviderJwt(now);
    cachedJwtAt = now;
  }
  return cachedJwt;
}

// ── Payload ──────────────────────────────────────────────────────────
// Maps our internal push payload ({title, body, url, tag}) onto the
// aps dictionary. thread-id groups notifications the way `tag` does on
// web; the custom `url` key is what the Capacitor tap handler routes to.
export function buildApnsBody(payload) {
  return JSON.stringify({
    aps: {
      alert: {
        title: String(payload.title || '').slice(0, 200),
        ...(payload.body ? { body: String(payload.body).slice(0, 500) } : {}),
      },
      sound: 'default',
      ...(payload.tag ? { 'thread-id': String(payload.tag).slice(0, 100) } : {}),
    },
    ...(payload.url ? { url: String(payload.url).slice(0, 500) } : {}),
    ...(payload.data ? { data: payload.data } : {}),
  });
}

// ── Send ─────────────────────────────────────────────────────────────
// Fans a payload out to N device tokens over ONE HTTP/2 connection
// (that's the protocol's whole point). Returns per-token outcomes:
//   [{ token, kind: 'sent' | 'gone' | 'error', status?, reason? }]
// 'gone' = Apple says the token is dead (uninstalled / expired) - the
// caller must delete the row, mirroring web push 404/410 handling.
export async function sendApnsToTokens({ tokens, payload }) {
  if (!isApnsConfigured() || !tokens?.length) return [];
  const env = (process.env.APNS_ENV || 'production') === 'sandbox' ? 'sandbox' : 'production';
  const host = APNS_HOSTS[env];
  const bundleId = process.env.APNS_BUNDLE_ID || 'com.getivyos.app';
  const body = buildApnsBody(payload);
  const jwt = providerJwt();

  const client = http2.connect(host);
  const clientError = new Promise((resolve) => {
    client.on('error', (err) => resolve({ connectionError: err }));
  });

  const sendOne = (token) => new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
      ...(payload.tag ? { 'apns-collapse-id': String(payload.tag).slice(0, 60) } : {}),
      'content-type': 'application/json',
    });
    let status = 0;
    let respBody = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (c) => { respBody += c; });
    req.on('end', () => {
      if (status === 200) return resolve({ token, kind: 'sent' });
      let reason = '';
      try { reason = JSON.parse(respBody).reason || ''; } catch { /* non-JSON */ }
      // 410 Unregistered = token expired. 400 BadDeviceToken usually
      // means env mismatch (sandbox token vs production host) OR a
      // genuinely dead token - either way it will never deliver from
      // this environment, so drop it.
      const gone = status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken';
      resolve({ token, kind: gone ? 'gone' : 'error', status, reason });
    });
    req.on('error', (err) => resolve({ token, kind: 'error', reason: err.message }));
    req.setTimeout(10_000, () => { req.close(); resolve({ token, kind: 'error', reason: 'timeout' }); });
    req.end(body);
  });

  try {
    const results = await Promise.race([
      Promise.all(tokens.map(sendOne)),
      clientError,
    ]);
    if (results?.connectionError) {
      // eslint-disable-next-line no-console
      console.warn('[apns] connection failed:', results.connectionError.message);
      return tokens.map((t) => ({ token: t, kind: 'error', reason: 'connection failed' }));
    }
    return results;
  } finally {
    client.close();
  }
}

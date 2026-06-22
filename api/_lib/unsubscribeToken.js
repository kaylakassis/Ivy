// One-click unsubscribe tokens. Signs a compact payload identifying the
// recipient + email category so the public /api/unsubscribe endpoint can
// flip the right opt-out without requiring the recipient to be logged in.
//
// Three scopes — one per kind of recipient row we mute against:
//   • user      — owners; toggles users.notification_prefs[email_<type>] = false
//   • client    — workspace clients (lookup by clients.id); toggles
//                 clients.notification_prefs[<type>] = false
//   • clientEmail — workspace clients we know only by email (public
//                 booking flow, intake) — toggles for any clients row
//                 matching (workspace_id, lower(email)).
//   • newsletter — newsletter_subscribers; stamps unsubscribed_at.
//
// Token format: `<base64url-payload>.<base64url-hmac>` where the payload
// JSON has shape:
//   { s: scope, i: id|email, w?: workspaceId, t: type|'all', e: exp(unix-sec) }
//
// Signed with UNSUBSCRIBE_SECRET (operator must set it in prod; falls back
// to a derived secret based on RESEND_API_KEY + APP_URL so dev still works).
// Tokens are long-lived (1 year) — the recipient may not click for months,
// and the underlying opt-out is a single-direction flip anyway.
import crypto from 'node:crypto';
import { appUrl } from './tokens.js';

const TOKEN_TTL_SEC = 365 * 24 * 60 * 60; // 1 year

function secretKey() {
  const explicit = process.env.UNSUBSCRIBE_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  // Derived fallback — stable per-deploy so old tokens still verify across
  // restarts as long as RESEND_API_KEY + APP_URL don't change. If the
  // operator rotates RESEND_API_KEY, old unsubscribe links stop working
  // (acceptable trade — they can always click any newer link).
  const seed = `${process.env.RESEND_API_KEY || 'no-key'}|${appUrl()}|ivy-unsubscribe-v1`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function mintUnsubscribeToken({ scope, id, workspaceId, type }) {
  if (!scope || !id) return null;
  if (!['user', 'client', 'clientEmail', 'newsletter'].includes(scope)) return null;
  const payload = {
    s: scope,
    i: String(id),
    ...(workspaceId ? { w: String(workspaceId) } : {}),
    t: type || 'all',
    e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  };
  const json = JSON.stringify(payload);
  const body = b64urlEncode(json);
  const sig = b64urlEncode(
    crypto.createHmac('sha256', secretKey()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let expected;
  try {
    expected = b64urlEncode(
      crypto.createHmac('sha256', secretKey()).update(body).digest(),
    );
  } catch { return null; }
  // Constant-time compare to avoid timing oracles.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.e !== 'number' || payload.e < Math.floor(Date.now() / 1000)) return null;
  if (!['user', 'client', 'clientEmail', 'newsletter'].includes(payload.s)) return null;
  return payload;
}

// Build the public unsubscribe URL for a recipient. Returns null when
// the inputs are insufficient (caller should then omit the List-Unsubscribe
// header rather than ship a broken link).
export function unsubscribeUrlFor({ scope, id, workspaceId, type }) {
  const token = mintUnsubscribeToken({ scope, id, workspaceId, type });
  if (!token) return null;
  return `${appUrl()}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

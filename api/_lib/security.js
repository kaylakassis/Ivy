// Security helpers for API handlers.
//
// Used as a guard at the top of every state-changing endpoint. Blocks requests
// that don't originate from this same site, so even if a user lands on a
// hostile page while logged in, that page can't trigger destructive POST/PATCH/
// DELETE calls against our API on their behalf (CSRF defense-in-depth on top
// of the SameSite=lax session cookie).
import { stampRequestId } from './monitoring.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function siteHost(req) {
  // Vercel sets x-forwarded-host with the request hostname. Fall back to host.
  return (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
}

function originHost(headerValue) {
  if (!headerValue) return '';
  try {
    return new URL(headerValue).host.toLowerCase();
  } catch {
    return '';
  }
}

// Returns true if the request's origin/referer matches the request's own host.
// Returns 403 (and false) if the origin/referer is set and doesn't match.
// If neither is present (e.g. server-to-server, curl, native fetch from same
// origin without origin header), we allow it - the SameSite cookie is still in
// place to block hostile contexts.
export function requireSameOrigin(req, res) {
  // Every authenticated handler routes through here, so it's the right
  // place to stamp the request ID + echo it on the response. Idempotent
  // - repeated calls return the existing ID.
  stampRequestId(req, res);

  if (SAFE_METHODS.has(req.method)) return true;

  const host = siteHost(req);
  if (!host) return true;

  const origin  = originHost(req.headers.origin);
  const referer = originHost(req.headers.referer);

  // If neither header is present, fall back to the SameSite cookie defense.
  if (!origin && !referer) return true;

  // Allow only if at least one of origin/referer matches the request host.
  if (origin === host || referer === host) return true;

  // Native iOS/Android Capacitor shell. The WebView origin is
  // `https://localhost` (iOS) / `https://localhost` or `http://localhost`
  // (Android) - those can never match our API host, but the request is
  // legitimate. We gate on the X-Client-Platform marker AND on Capacitor's
  // fixed localhost origin together: a malicious page on a real
  // localhost-bound dev server can't spoof the platform header from
  // browser JS (custom headers trigger CORS preflight, which our
  // vercel.json only ack's for the Capacitor origins).
  const platform = req.headers['x-client-platform'] || req.headers['X-Client-Platform'];
  if ((platform === 'ios' || platform === 'android') && (origin === 'localhost' || referer === 'localhost')) {
    return true;
  }

  res.status(403).json({ error: 'Forbidden: cross-site request blocked' });
  return false;
}

// Sanitises an error message for the client. In production we don't return raw
// exception text (could leak SQL fragments, file paths, internal IDs). In dev
// we keep the original message so debugging stays easy.
export function safeErrorMessage(err) {
  if (process.env.NODE_ENV === 'production') {
    // Allow our own short, intentional messages through - anything that looks
    // like a stack trace or DB error gets replaced.
    const msg = err?.message || '';
    if (msg && msg.length < 200 && !/(at |stack|postgres|neon|pg_|sql|relation)/i.test(msg)) {
      return msg;
    }
    return 'Server error';
  }
  return err?.message || 'Server error';
}

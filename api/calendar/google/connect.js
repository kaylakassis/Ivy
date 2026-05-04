// GET /api/calendar/google/connect
// Kicks off the Google OAuth flow. Returns an authorization URL the
// frontend immediately redirects to. We embed a CSRF state token tied
// to the user's session so the callback can verify it's the same user.
import crypto from 'node:crypto';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isGoogleConfigured, buildAuthUrl } from '../../_lib/google.js';
import { appUrl } from '../../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    if (!isGoogleConfigured()) {
      return badRequest(res, 'Google Calendar sync is not configured on this deployment yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Vercel env.');
    }
    const user = await requireUser(req, res);
    if (!user) return;

    // CSRF state: random nonce + the user id, signed-ish via HMAC of the
    // session cookie. Simpler approach: just a random token stored in a
    // short-lived cookie, compared on callback. Cookie is httpOnly so JS
    // can't fish it out, and SameSite=Lax keeps it scoped to our domain.
    const state = crypto.randomBytes(24).toString('hex');
    const isProd = process.env.VERCEL_ENV === 'production';
    res.setHeader('Set-Cookie', [
      `gcal_state=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`,
    ]);

    const redirectUri = `${appUrl()}/api/calendar/google/callback`;
    const authUrl = buildAuthUrl({ redirectUri, state });
    return ok(res, { url: authUrl });
  } catch (err) {
    return serverError(res, err);
  }
}

// GET /api/finance/square-oauth-callback?code=...&state=...
// Square redirects here after the owner authorizes. We verify the
// signed state, check it belongs to THIS browser (web) or THIS owner
// (app), exchange the code for tokens, look up the merchant's first
// location, encrypt + persist, and bounce the owner back to the Finance
// page with a status flag.
//
// Binding the callback to the browser matters because the state only
// names a workspace: whoever completes Square's consent screen with that
// URL would otherwise bind THEIR merchant to it. Web flow: the init set
// an HttpOnly `sq_state` nonce cookie and put its sha256 in the state;
// both must be present and match. App flow (state.from === 'app'):
// Safari has no cookie, so the state stays the credential, but when a
// session IS present it must be the owner the state was minted for.
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import crypto from 'node:crypto';
import { exchangeOAuthCode, fetchFirstLocation, persistConnection, squareEnv, squareRedirectUri } from '../_lib/payments/square.js';
import { readSession } from '../_lib/auth.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';
import { connectedPageUrl, SQ_STATE_COOKIE } from '../_lib/connectReturn.js';

function hashesMatch(hexA, hexB) {
  if (!hexA || !hexB || typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readNonceCookie(req) {
  try {
    const parsed = cookie.parse(req.headers?.cookie || '');
    return parsed[SQ_STATE_COOKIE] || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  // The nonce is single-use: clear it whatever happens next.
  res.setHeader('Set-Cookie', cookie.serialize(SQ_STATE_COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
  }));
  // Phone flow (state.from === 'app'): Safari has no Ivy session, so end
  // on the public "back to the app" page rather than /finance.
  let appFlow = false;
  const back = (status, msg) => {
    if (appFlow) {
      res.writeHead(302, { Location: connectedPageUrl('square', status, msg) });
      res.end();
      return;
    }
    const u = new URL(`${appUrl()}/finance`);
    u.searchParams.set('square', status);
    if (msg) u.searchParams.set('msg', msg.slice(0, 200));
    res.writeHead(302, { Location: u.toString() });
    res.end();
  };

  try {
    const { code, state, error } = req.query || {};
    try { appFlow = jwt.decode(String(state || ''))?.from === 'app'; } catch { /* not ours */ }
    if (error) return back('error', String(error));
    if (!code || !state) return back('error', 'Missing code or state');

    let payload;
    try { payload = jwt.verify(String(state), process.env.JWT_SECRET, { algorithms: ['HS256'] }); }
    catch { return back('error', 'State token invalid or expired'); }
    if (payload.kind !== 'square_oauth' || !payload.wid) return back('error', 'State payload mismatch');
    appFlow = payload.from === 'app';

    // Whoever is signed in here must be the owner who started the flow.
    // (Web always has a session on a top-level GET; the app flow usually
    // has none, so this check is skipped when there is nothing to compare.)
    const session = readSession(req);
    if (session?.sub && payload.uid && session.sub !== payload.uid) {
      return back('error', 'This Square link was started from a different account. Please start the connection again from Finance.');
    }

    if (!appFlow) {
      // Web flow: the nonce cookie this browser received at init must hash
      // to the value sealed in the state.
      const nonce = readNonceCookie(req);
      const nonceHash = nonce ? crypto.createHash('sha256').update(nonce).digest('hex') : null;
      if (!payload.nonce || !hashesMatch(nonceHash, payload.nonce)) {
        return back('error', 'This Square link did not come from this browser. Please start the connection again from Finance.');
      }
    }

    // MUST be byte-identical to the redirect_uri the init sent to Square,
    // or the token exchange 4xxs. Shared helper guarantees that.
    const redirectUri = squareRedirectUri();
    const oauthResult = await exchangeOAuthCode({ code, redirectUri });
    const location = await fetchFirstLocation({ accessToken: oauthResult.access_token });
    // No location → /v2/locations call failed or the merchant has no
    // active locations yet. Refuse to mark the workspace "connected"
    // with a NULL location_id - every later checkout/refund call needs
    // it, and silently connecting hides the real error until the owner
    // tries to take a payment.
    if (!location?.id) {
      return back('error', 'Connected to Square but no active location was returned - add a location in your Square dashboard, then reconnect.');
    }
    await persistConnection({
      workspaceId: payload.wid,
      oauthResult,
      location,
      environment: squareEnv(),
      label: location?.business_name || location?.name || 'Square',
    });
    return back('connected');
  } catch (err) {
    return back('error', err.message || 'Connect failed');
  }
}

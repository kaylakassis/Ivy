// GET /api/finance/square-oauth-callback?code=...&state=...
// Square redirects here after the owner authorizes. We verify the
// signed state, exchange the code for tokens, look up the merchant's
// first location, encrypt + persist, and bounce the owner back to the
// Finance page with a status flag.
import jwt from 'jsonwebtoken';
import { exchangeOAuthCode, fetchFirstLocation, persistConnection, squareEnv, squareRedirectUri } from '../_lib/payments/square.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';
import { connectedPageUrl } from '../_lib/connectReturn.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
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
    try { payload = jwt.verify(state, process.env.JWT_SECRET, { algorithms: ['HS256'] }); }
    catch { return back('error', 'State token invalid or expired'); }
    if (payload.kind !== 'square_oauth' || !payload.wid) return back('error', 'State payload mismatch');

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

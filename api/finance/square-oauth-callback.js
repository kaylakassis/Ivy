// GET /api/finance/square-oauth-callback?code=...&state=...
// Square redirects here after the owner authorizes. We verify the
// signed state, exchange the code for tokens, look up the merchant's
// first location, encrypt + persist, and bounce the owner back to the
// Finance page with a status flag.
import jwt from 'jsonwebtoken';
import { exchangeOAuthCode, fetchFirstLocation, persistConnection, squareEnv } from '../_lib/payments/square.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const back = (status, msg) => {
    const u = new URL(`${appUrl()}/finance`);
    u.searchParams.set('square', status);
    if (msg) u.searchParams.set('msg', msg.slice(0, 200));
    res.writeHead(302, { Location: u.toString() });
    res.end();
  };

  try {
    const { code, state, error } = req.query || {};
    if (error) return back('error', String(error));
    if (!code || !state) return back('error', 'Missing code or state');

    let payload;
    try { payload = jwt.verify(state, process.env.JWT_SECRET); }
    catch { return back('error', 'State token invalid or expired'); }
    if (payload.kind !== 'square_oauth' || !payload.wid) return back('error', 'State payload mismatch');

    const redirectUri = `${appUrl()}/api/finance/square-oauth-callback`;
    const oauthResult = await exchangeOAuthCode({ code, redirectUri });
    const location = await fetchFirstLocation({ accessToken: oauthResult.access_token });
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

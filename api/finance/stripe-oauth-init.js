// GET /api/finance/stripe-oauth-init
//
// Owner-only. Redirects the browser to Stripe Connect's OAuth
// authorize page. We sign a short-lived state token tying the
// request to the workspace + a CSRF nonce; the callback endpoint
// verifies the same state before storing the connected account id.
//
// Required env:
//   STRIPE_CONNECT_CLIENT_ID  ca_xxx — your Connect platform client_id
//                             (Stripe Dashboard → Connect → Settings)
//   APP_URL                   used to build the redirect_uri
//   JWT_SECRET                signs the state token (already required
//                             for sessions)
//
// GET (instead of POST) so a plain <a href> works as the Connect link
// — matches the Square + PayPal init endpoints and keeps the
// PaymentProviderCard simple. The state token is the CSRF gate.
import jwt from 'jsonwebtoken';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) {
      return badRequest(res, 'Stripe Connect is not configured on this deploy yet — set STRIPE_CONNECT_CLIENT_ID in Vercel.');
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) return badRequest(res, 'JWT_SECRET is not configured.');

    // 10-minute state token — bound to the workspace so a leaked URL
    // can't connect a different workspace's Stripe.
    const state = jwt.sign(
      { workspaceId, kind: 'stripe-oauth' },
      secret,
      { expiresIn: '10m' },
    );
    const redirectUri = `${appUrl()}/api/finance/stripe-oauth-callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'read_write',
      redirect_uri: redirectUri,
      state,
      'stripe_user[email]':       user.email || '',
      'stripe_user[business_name]': '',
    });
    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    return serverError(res, err);
  }
}

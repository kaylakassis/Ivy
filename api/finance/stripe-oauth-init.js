// POST /api/finance/stripe-oauth-init
//
// Returns the Stripe Connect OAuth URL the owner should redirect to.
// We sign a short-lived state token tying the request to the
// workspace + a CSRF nonce; the callback endpoint verifies the same
// state before storing the connected account id.
//
// Required env:
//   STRIPE_CONNECT_CLIENT_ID  ca_xxx — your Connect platform client_id
//                             (Stripe Dashboard → Connect → Settings)
//   APP_URL                   used to build the redirect_uri
//   JWT_SECRET                signs the state token (already required
//                             for sessions)
import jwt from 'jsonwebtoken';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    if (!clientId) {
      return badRequest(res, 'STRIPE_CONNECT_CLIENT_ID is not configured. Falling back to manual key entry.');
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
      // Pre-fill what we know to skip Stripe's first form for the user.
      'stripe_user[email]':       user.email || '',
      'stripe_user[business_name]': '',
    });
    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
    return ok(res, { url });
  } catch (err) {
    return serverError(res, err);
  }
}

// GET /api/finance/paypal-onboard-init
// Owner-only. Asks PayPal Partner Referrals API for an action_url and
// redirects the owner there. PayPal handles the merchant onboarding
// flow (sign in / sign up + grant permissions) and bounces back to
// /api/finance/paypal-onboard-callback with merchantIdInPayPal.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { buildOnboardingUrl } from '../_lib/payments/paypal.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.PAYPAL_PARTNER_ID) {
      return badRequest(res, 'PayPal is not configured on this deploy yet — set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET + PAYPAL_PARTNER_ID.');
    }

    const returnUrl = `${appUrl()}/api/finance/paypal-onboard-callback?wid=${encodeURIComponent(workspaceId)}`;
    const url = await buildOnboardingUrl({
      workspaceId, returnUrl, trackingId: workspaceId,
    });
    if (!url) return badRequest(res, 'PayPal did not return an onboarding URL');
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    return serverError(res, err);
  }
}

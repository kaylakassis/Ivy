// GET /api/finance/paypal-onboard-init
// Owner-only. Asks PayPal Partner Referrals API for an action_url and
// redirects the owner there. PayPal handles the merchant onboarding
// flow (sign in / sign up + grant permissions) and bounces back to
// /api/finance/paypal-onboard-callback with merchantIdInPayPal.
//
// Reached via a top-level <a href> click, so we redirect back to
// /finance with a query-string error on failure rather than returning
// raw JSON (which would show as a blank page in the browser).
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { buildOnboardingUrl } from '../_lib/payments/paypal.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed, ok, badRequest } from '../_lib/json.js';
import { wantsJson, fromApp, signReturnState } from '../_lib/connectReturn.js';

function back(res, msg) {
  const u = new URL(`${appUrl()}/finance`);
  u.searchParams.set('paypal', 'error');
  if (msg) u.searchParams.set('msg', String(msg).slice(0, 200));
  res.writeHead(302, { Location: u.toString() });
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const asJson = wantsJson(req);
    if (!asJson && !req.headers.authorization
        && (!req.headers.cookie || !/(?:^|;\s*)ivy_session=/.test(req.headers.cookie))) {
      const dest = encodeURIComponent('/finance');
      res.writeHead(302, { Location: `/signin?next=${dest}` });
      res.end();
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.PAYPAL_PARTNER_ID) {
      if (asJson) return badRequest(res, 'PayPal is not set up on this deployment yet.');
      return back(res, 'PayPal is not configured on this deploy yet - admin needs to set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and PAYPAL_PARTNER_ID.');
    }

    const stateParam = fromApp(req)
      ? `&state=${encodeURIComponent(signReturnState({ workspaceId, userId: user.id, kind: 'paypal_return' }))}`
      : '';
    const returnUrl = `${appUrl()}/api/finance/paypal-onboard-callback?wid=${encodeURIComponent(workspaceId)}${stateParam}`;
    const url = await buildOnboardingUrl({
      workspaceId, returnUrl, trackingId: workspaceId,
    });
    if (!url) return asJson ? badRequest(res, 'PayPal did not return an onboarding URL') : back(res, 'PayPal did not return an onboarding URL');
    if (asJson) return ok(res, { url });
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    console.error('[paypal-onboard-init] failed:', err);
    if (wantsJson(req)) return badRequest(res, err.message || 'Could not start PayPal connect');
    return back(res, err.message || 'Could not start PayPal connect');
  }
}

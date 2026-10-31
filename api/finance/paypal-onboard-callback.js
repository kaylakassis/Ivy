// GET /api/finance/paypal-onboard-callback?merchantIdInPayPal=...&state=...&from=web|app
// PayPal redirects here when the owner finishes (or aborts) the
// merchant onboarding flow. We verify the signed state the init put in
// the return URL, confirm the merchant id belongs to THIS onboarding
// (PayPal echoes our tracking_id = workspace id), and persist.
//
// Why so defensive: this is a top-level GET, so the browser sends the
// SameSite=Lax session cookie with it. Without the checks below, an
// attacker who onboarded their own PayPal merchant could send an owner a
// link to this URL carrying the attacker's merchantIdInPayPal, and the
// owner's own session would attach it to the owner's workspace - every
// client payment would then go to the attacker.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { fetchSellerStatus, persistConnection, paypalEnv } from '../_lib/payments/paypal.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';
import { verifyReturnState, connectedPageUrl } from '../_lib/connectReturn.js';

const RESTART = 'Please start the PayPal connection again from Finance.';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  // PayPal's URL params include merchantIdInPayPal and a permissionsGranted
  // flag. Vercel's query parser hands back arrays for repeated params;
  // coerce each value to a single string so nothing downstream sees an
  // array from a crafted ?a=1&a=2 URL.
  const q = req.query || {};
  const first = (v) => Array.isArray(v) ? v[0] : v;
  const state = verifyReturnState(first(q.state), 'paypal_return');
  // Phone flow: our signed state stands in for the session Safari lacks,
  // and the owner ends on the public "back to the app" page. The `from`
  // query param only picks the landing page when the state is unusable.
  const appFlow = state ? state.from === 'app' : first(q.from) === 'app';
  const back = (status, msg) => {
    if (appFlow) {
      res.writeHead(302, { Location: connectedPageUrl('paypal', status, msg) });
      res.end();
      return;
    }
    const u = new URL(`${appUrl()}/finance`);
    u.searchParams.set('paypal', status);
    if (msg) u.searchParams.set('msg', msg.slice(0, 200));
    res.writeHead(302, { Location: u.toString() });
    res.end();
  };

  try {
    const merchantIdInPayPal = first(q.merchantIdInPayPal);
    const permissionsGranted = first(q.permissionsGranted);
    if (!merchantIdInPayPal) return back('error', 'PayPal did not return a merchant id');
    if (permissionsGranted === 'false') return back('error', 'PayPal permissions were not granted');

    // 1. A valid, unexpired state minted by OUR init is required on both
    //    surfaces. No state, or a state for another flow → refuse.
    if (!state) return back('error', `This PayPal link is missing or expired. ${RESTART}`);

    // 2. Web flow: the session must belong to the same owner + workspace
    //    the state was minted for. The state alone is not enough here: a
    //    leaked web state could otherwise be replayed from any browser.
    //    App flow: Safari has no session; the state is the credential.
    let workspaceId;
    if (appFlow) {
      workspaceId = state.workspaceId;
    } else {
      const user = await requireUser(req, res);
      if (!user) return;
      workspaceId = await ensureActiveWorkspace(user, req, res);
      if (!workspaceId) return;
      if (state.workspaceId !== workspaceId || !state.userId || state.userId !== user.id) {
        return back('error', `This PayPal link was started from a different account. ${RESTART}`);
      }
    }

    // 3. Ask PayPal about the merchant and confirm it is the one THIS
    //    workspace's onboarding created: PayPal echoes the tracking_id we
    //    sent at init (buildOnboardingUrl sets it to the workspace id).
    //    Fail closed: if PayPal cannot tell us, we do not connect.
    let sellerStatus = null;
    try { sellerStatus = await fetchSellerStatus({ merchantId: merchantIdInPayPal }); }
    catch (err) {
      console.warn('[paypal-onboard-callback] seller status lookup failed:', err?.message);
      sellerStatus = null;
    }
    if (!sellerStatus) {
      return back('error', 'PayPal could not confirm your account yet. Please try connecting again in a moment.');
    }
    if (String(sellerStatus.tracking_id || '') !== String(workspaceId)) {
      console.warn('[paypal-onboard-callback] tracking_id mismatch for workspace', workspaceId);
      return back('error', `That PayPal account was not set up from this workspace. ${RESTART}`);
    }

    await persistConnection({
      workspaceId,
      merchantId: merchantIdInPayPal,
      environment: paypalEnv(),
      label: sellerStatus?.legal_name || 'PayPal',
      sellerStatus,
    });
    return back('connected');
  } catch (err) {
    return back('error', err.message || 'Connect failed');
  }
}

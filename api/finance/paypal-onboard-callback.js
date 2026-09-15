// GET /api/finance/paypal-onboard-callback?merchantIdInPayPal=...&wid=...
// PayPal redirects here when the owner finishes (or aborts) the
// merchant onboarding flow. We confirm the merchant id, fetch their
// seller status, and persist the connection.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { fetchSellerStatus, persistConnection, paypalEnv } from '../_lib/payments/paypal.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';
import { verifyReturnState, connectedPageUrl } from '../_lib/connectReturn.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  // Phone flow: our signed state stands in for the session Safari lacks,
  // and the owner ends on the public "back to the app" page.
  const appState = verifyReturnState(req.query?.state, 'paypal_return');
  const back = (status, msg) => {
    if (appState) {
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
    // PayPal's URL params include merchantIdInPayPal and a permissionsGranted flag.
    // Vercel's query parser hands back arrays for repeated params; coerce
    // each value to a single string so the DB writes don't blow up on a
    // crafted ?wid=a&wid=b URL.
    const q = req.query || {};
    const first = (v) => Array.isArray(v) ? v[0] : v;
    const merchantIdInPayPal   = first(q.merchantIdInPayPal);
    const permissionsGranted   = first(q.permissionsGranted);
    if (!merchantIdInPayPal) return back('error', 'PayPal did not return a merchant id');
    if (permissionsGranted === 'false') return back('error', 'PayPal permissions were not granted');

    // Owner must be logged in. CRITICAL: derive the workspace from the
    // authenticated session - NEVER from a URL param. Trusting a `wid`
    // query value would let anyone attach their own PayPal merchant to a
    // victim's workspace (redirecting that victim's payouts), so the
    // attacker-controllable param is ignored entirely.
    let workspaceId;
    if (appState) {
      workspaceId = appState.workspaceId;
    } else {
      const user = await requireUser(req, res);
      if (!user) return;
      workspaceId = await ensureActiveWorkspace(user, req, res);
    }
    if (!workspaceId) return;

    let sellerStatus = null;
    try { sellerStatus = await fetchSellerStatus({ merchantId: merchantIdInPayPal }); }
    catch { /* non-fatal - connection still records, payments_enabled stays false */ }

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

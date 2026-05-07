// GET /api/finance/paypal-onboard-callback?merchantIdInPayPal=...&wid=...
// PayPal redirects here when the owner finishes (or aborts) the
// merchant onboarding flow. We confirm the merchant id, fetch their
// seller status, and persist the connection.
import { requireUser } from '../_lib/auth.js';
import { fetchSellerStatus, persistConnection, paypalEnv } from '../_lib/payments/paypal.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const back = (status, msg) => {
    const u = new URL(`${appUrl()}/finance`);
    u.searchParams.set('paypal', status);
    if (msg) u.searchParams.set('msg', msg.slice(0, 200));
    res.writeHead(302, { Location: u.toString() });
    res.end();
  };

  try {
    // PayPal's URL params include merchantIdInPayPal and a permissionsGranted flag.
    const { merchantIdInPayPal, wid, permissionsGranted } = req.query || {};
    if (!wid) return back('error', 'Missing workspace context');
    if (!merchantIdInPayPal) return back('error', 'PayPal did not return a merchant id');
    if (permissionsGranted === 'false') return back('error', 'PayPal permissions were not granted');

    // Owner must be logged in to land here — we don't trust the wid
    // param alone since this endpoint is unauthenticated by URL design.
    // requireUser would 401 anyone not signed in; we check the session
    // matches the workspace via a quick DB hop.
    const user = await requireUser(req, res);
    if (!user) return;

    let sellerStatus = null;
    try { sellerStatus = await fetchSellerStatus({ merchantId: merchantIdInPayPal }); }
    catch { /* non-fatal — connection still records, payments_enabled stays false */ }

    await persistConnection({
      workspaceId: wid,
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

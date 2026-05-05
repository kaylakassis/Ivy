// GET /api/finance/stripe-oauth-callback?code=...&state=...
//
// Stripe redirects here after the owner authorizes the Connect app.
// We verify the state token, exchange the code for an acct_xxx id +
// access token, encrypt + store both, and bounce back to /finance with
// a flash query param so the UI can render a "connected" toast.
//
// On any failure we redirect to /finance?stripe=error to keep the user
// in-app with a readable message instead of a JSON dump.
import jwt from 'jsonwebtoken';
import { sql } from '../_lib/db.js';
import { encrypt } from '../_lib/secrets.js';
import { fetchAccountSummary } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const home = appUrl();
  const safeRedirect = (status, params) => {
    const qs = new URLSearchParams(params).toString();
    res.statusCode = 302;
    res.setHeader('Location', `${home}/finance?${qs}`);
    res.end();
  };

  try {
    const code  = (req.query.code  || '').toString();
    const state = (req.query.state || '').toString();
    const declined = (req.query.error || '').toString();

    if (declined) {
      return safeRedirect(302, { stripe: 'declined', detail: declined.slice(0, 80) });
    }
    if (!code || !state) return safeRedirect(400, { stripe: 'error', detail: 'missing-params' });

    const secret = process.env.JWT_SECRET;
    if (!secret) return safeRedirect(500, { stripe: 'error', detail: 'no-jwt-secret' });

    let claims;
    try { claims = jwt.verify(state, secret); }
    catch { return safeRedirect(400, { stripe: 'error', detail: 'bad-state' }); }
    if (claims.kind !== 'stripe-oauth' || !claims.workspaceId) {
      return safeRedirect(400, { stripe: 'error', detail: 'bad-state' });
    }
    const workspaceId = claims.workspaceId;

    const platformSecret = process.env.STRIPE_PLATFORM_SECRET || process.env.THRYVE_STRIPE_SECRET;
    if (!platformSecret) return safeRedirect(500, { stripe: 'error', detail: 'no-platform-secret' });

    // Exchange the auth code for a connected-account access token.
    // Stripe's token endpoint takes form-urlencoded, NOT JSON.
    const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_secret: platformSecret,
        code,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      return safeRedirect(400, { stripe: 'error', detail: detail.slice(0, 100) || `http-${tokenRes.status}` });
    }
    const tok = await tokenRes.json();
    // tok = { access_token, refresh_token, scope, livemode, stripe_user_id, stripe_publishable_key, ... }

    if (!tok.stripe_user_id || !tok.access_token) {
      return safeRedirect(500, { stripe: 'error', detail: 'incomplete-exchange' });
    }

    // Fetch a friendly label for the connected account.
    let label = tok.stripe_user_id;
    try {
      const summary = await fetchAccountSummary(tok.access_token);
      if (summary?.label) label = summary.label;
    } catch { /* fall back to acct id */ }

    await sql`
      INSERT INTO finance_settings (
        workspace_id, stripe_publishable_key, stripe_secret_encrypted,
        stripe_account_label, stripe_connected_at,
        stripe_connect_user_id, stripe_connect_livemode
      )
      VALUES (
        ${workspaceId},
        ${tok.stripe_publishable_key || null},
        ${encrypt(tok.access_token)},
        ${label},
        NOW(),
        ${tok.stripe_user_id},
        ${!!tok.livemode}
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        stripe_publishable_key   = EXCLUDED.stripe_publishable_key,
        stripe_secret_encrypted  = EXCLUDED.stripe_secret_encrypted,
        stripe_account_label     = EXCLUDED.stripe_account_label,
        stripe_connected_at      = EXCLUDED.stripe_connected_at,
        stripe_connect_user_id   = EXCLUDED.stripe_connect_user_id,
        stripe_connect_livemode  = EXCLUDED.stripe_connect_livemode
    `;

    return safeRedirect(302, { stripe: 'connected' });
  } catch (err) {
    return safeRedirect(500, { stripe: 'error', detail: (err.message || '').slice(0, 100) });
  }
}

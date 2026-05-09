// GET /api/finance/stripe-oauth-callback
//
// Stripe redirects here when the owner finishes (or abandons) the
// hosted Express onboarding form. Unlike Standard OAuth, there's no
// `code` to exchange — the connected account already exists. We just
// re-fetch the account from Stripe, persist its current state, and
// bounce back to /finance with a flash query param.
//
// The owner is signed-in throughout the flow (returnUrl points back at
// our app), so we use requireUser to scope the workspace.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { appUrl } from '../_lib/tokens.js';
import { platformStripeSecret, fetchAccountSummary } from '../_lib/stripe.js';
import { methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const home = appUrl();
  const safeRedirect = (params) => {
    const qs = new URLSearchParams(params).toString();
    res.statusCode = 302;
    res.setHeader('Location', `${home}/finance?${qs}`);
    res.end();
  };

  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const platformKey = platformStripeSecret();
    if (!platformKey) return safeRedirect({ stripe: 'error', detail: 'no-platform-secret' });

    const r = await sql`
      SELECT stripe_connect_user_id
        FROM finance_settings
       WHERE workspace_id = ${workspaceId}
    `;
    const accountId = r.rows[0]?.stripe_connect_user_id;
    if (!accountId) return safeRedirect({ stripe: 'error', detail: 'no-account' });

    // Pull the current state of the connected account. Stripe may have
    // collected partial info — we treat charges_enabled as the bar for
    // "connected enough to receive payments". details_submitted alone
    // means the form was filled out but Stripe hasn't finished verifying.
    let summary;
    try {
      summary = await fetchAccountSummary({
        secretKey: platformKey,
        stripeAccount: accountId,
      });
    } catch (err) {
      return safeRedirect({ stripe: 'error', detail: (err.message || '').slice(0, 100) });
    }

    if (!summary.detailsSubmitted) {
      // Owner abandoned the form. Keep the acct around so the next
      // Connect-button click resumes where they left off.
      return safeRedirect({ stripe: 'incomplete' });
    }

    const status = summary.chargesEnabled ? 'complete' : 'pending';
    await sql`
      UPDATE finance_settings SET
        stripe_account_label     = ${summary.label},
        stripe_connect_livemode  = ${!!summary.livemode},
        stripe_connected_at      = NOW(),
        stripe_onboarding_status = ${status}
      WHERE workspace_id = ${workspaceId}
    `;

    return safeRedirect({
      stripe: status === 'complete' ? 'connected' : 'pending',
    });
  } catch (err) {
    return safeRedirect({ stripe: 'error', detail: (err.message || '').slice(0, 100) });
  }
}

// Resolves the per-workspace Stripe credentials in one shot, returning
// a normalized shape for caller use. Throws when the workspace hasn't
// connected Stripe — every per-tenant Stripe call goes through this so
// the error path is uniform.
//
// Two connection modes are supported transparently:
//
//   • Account Links (Express, current/recommended flow):
//       finance_settings.stripe_connect_user_id is set, but
//       finance_settings.stripe_secret_encrypted is NULL. We act on
//       behalf of the connected account using the platform secret
//       key + Stripe-Account: <acct_id> header.
//
//   • Standard OAuth (legacy flow):
//       finance_settings.stripe_secret_encrypted holds the connected
//       account's own secret key (issued during OAuth token exchange).
//       We use it directly; no Stripe-Account header needed.
//
// Callers receive the same shape — `secretKey` + optional `stripeAccount`
// — and pass both to api/_lib/stripe.js helpers, which already know to
// include the Stripe-Account header only when present.
import { sql } from './db.js';
import { decrypt } from './secrets.js';
import { platformStripeSecret } from './stripe.js';

export async function loadStripeCreds(workspaceId) {
  const r = await sql`
    SELECT stripe_secret_encrypted, stripe_webhook_secret_encrypted,
           stripe_account_label, stripe_connect_user_id, stripe_onboarding_status,
           currency
      FROM finance_settings
     WHERE workspace_id = ${workspaceId}
  `;
  const row = r.rows[0];

  // Account Links / Express path — preferred when an acct id exists,
  // regardless of whether a legacy secret was ever stored.
  if (row?.stripe_connect_user_id && row.stripe_onboarding_status !== 'pending') {
    const platformKey = platformStripeSecret();
    if (!platformKey) {
      const e = new Error('Platform STRIPE_SECRET_KEY is not configured');
      e.code = 'platform_secret_missing';
      throw e;
    }
    return {
      secretKey:      platformKey,
      stripeAccount:  row.stripe_connect_user_id,
      label:          row.stripe_account_label || null,
      connectAccount: row.stripe_connect_user_id,
      currency:       (row.currency || 'USD').toUpperCase(),
      hasWebhook:     !!row.stripe_webhook_secret_encrypted,
    };
  }

  // Legacy paste-your-key / Standard OAuth path — secret stored
  // directly. No Stripe-Account header.
  if (row?.stripe_secret_encrypted) {
    let secretKey;
    try {
      secretKey = decrypt(row.stripe_secret_encrypted);
    } catch {
      const e = new Error('Stripe credentials are misconfigured');
      e.code = 'stripe_credentials_invalid';
      throw e;
    }
    return {
      secretKey,
      stripeAccount:  null,
      label:          row.stripe_account_label || null,
      connectAccount: row.stripe_connect_user_id || null,
      currency:       (row.currency || 'USD').toUpperCase(),
      hasWebhook:     !!row.stripe_webhook_secret_encrypted,
    };
  }

  const e = new Error('Stripe is not connected for this workspace');
  e.code = 'no_stripe_connection';
  throw e;
}

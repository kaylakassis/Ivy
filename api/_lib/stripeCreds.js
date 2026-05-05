// Resolves the per-workspace Stripe credentials + currency in one
// shot, returning a normalized shape for caller use. Throws when the
// workspace hasn't connected Stripe — every per-tenant Stripe call
// goes through this so the error path is uniform.
//
// Stripe Connect (OAuth-onboarded) workspaces and legacy paste-your-
// secret-key workspaces both end up with a usable secret key in
// finance_settings.stripe_secret_encrypted, so callers can treat the
// returned `secretKey` as opaque.
import { sql } from './db.js';
import { decrypt } from './secrets.js';

export async function loadStripeCreds(workspaceId) {
  const r = await sql`
    SELECT stripe_secret_encrypted, stripe_webhook_secret_encrypted,
           stripe_account_label, stripe_connect_user_id, currency
      FROM finance_settings
     WHERE workspace_id = ${workspaceId}
  `;
  const row = r.rows[0];
  if (!row?.stripe_secret_encrypted) {
    const e = new Error('Stripe is not connected for this workspace');
    e.code = 'no_stripe_connection';
    throw e;
  }
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
    label:    row.stripe_account_label || null,
    connectAccount: row.stripe_connect_user_id || null,
    currency: (row.currency || 'USD').toUpperCase(),
    hasWebhook: !!row.stripe_webhook_secret_encrypted,
  };
}

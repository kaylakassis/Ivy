// POST /api/finance/stripe-disconnect
// Clears all Stripe credentials for this workspace. Pending checkout sessions
// already in flight will still settle on Stripe's side, but the workspace
// won't accept new payments until reconnected.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    // Clear both Standard-OAuth (legacy) and Account-Links columns. The
    // acct row on Stripe's side stays put — Stripe doesn't let platforms
    // delete connected Express accounts via API. Reconnecting later
    // will create a fresh acct since this row no longer references it.
    await sql`
      UPDATE finance_settings SET
        stripe_publishable_key          = NULL,
        stripe_secret_encrypted         = NULL,
        stripe_webhook_secret_encrypted = NULL,
        stripe_account_label            = NULL,
        stripe_connected_at             = NULL,
        stripe_connect_user_id          = NULL,
        stripe_connect_livemode         = NULL,
        stripe_onboarding_status        = NULL
      WHERE workspace_id = ${workspaceId}
    `;
    return ok(res, { connected: false });
  } catch (err) {
    return serverError(res, err);
  }
}

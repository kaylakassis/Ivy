// GET /api/finance/stripe-status
// Returns the connection state for the workspace's Stripe integration. Used
// by the Finance UI to decide whether to show "Connect Stripe" vs "Connected"
// and to enable the public Pay-with-card button on outbound invoices.
//
// Never returns the encrypted secrets — only metadata.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT
        stripe_publishable_key,
        stripe_account_label,
        stripe_connected_at,
        stripe_webhook_secret_encrypted IS NOT NULL AS webhook_configured,
        stripe_secret_encrypted          IS NOT NULL AS connected
      FROM finance_settings
      WHERE workspace_id = ${workspaceId}
    `;
    const r = rows[0];
    if (!r || !r.connected) {
      return ok(res, { connected: false });
    }
    return ok(res, {
      connected: true,
      accountLabel: r.stripe_account_label || null,
      publishable: r.stripe_publishable_key || null,
      webhookConfigured: !!r.webhook_configured,
      connectedAt: r.stripe_connected_at,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// POST /api/finance/stripe-connect
//   body: { secretKey, publishableKey, webhookSecret }
// Validates the secret key by calling Stripe /v1/account. On success encrypts
// secret + webhook secret and stores them on the workspace's finance_settings
// row. We never re-emit the plaintext secrets after this point.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { encrypt } from '../_lib/secrets.js';
import { fetchAccountSummary } from '../_lib/stripe.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const secretKey      = String(body.secretKey      || '').trim();
    const publishableKey = String(body.publishableKey || '').trim();
    const webhookSecret  = String(body.webhookSecret  || '').trim();

    if (!secretKey.startsWith('sk_') && !secretKey.startsWith('rk_')) {
      return badRequest(res, 'Secret key must start with sk_ or rk_');
    }
    if (publishableKey && !publishableKey.startsWith('pk_')) {
      return badRequest(res, 'Publishable key must start with pk_');
    }
    if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
      return badRequest(res, 'Webhook secret must start with whsec_');
    }

    // Validate by asking Stripe who this key belongs to. If the key is bogus
    // or the wrong mode, this throws a specific error we can surface.
    let summary;
    try {
      summary = await fetchAccountSummary(secretKey);
    } catch (err) {
      return badRequest(res, `Stripe rejected the secret key: ${err.message}`);
    }

    const encryptedSecret  = encrypt(secretKey);
    const encryptedWebhook = webhookSecret ? encrypt(webhookSecret) : null;

    // Upsert finance_settings - the row may not exist yet for new workspaces.
    await sql`
      INSERT INTO finance_settings (
        workspace_id, stripe_publishable_key, stripe_secret_encrypted,
        stripe_webhook_secret_encrypted, stripe_account_label, stripe_connected_at
      )
      VALUES (
        ${workspaceId}, ${publishableKey || null}, ${encryptedSecret},
        ${encryptedWebhook}, ${summary.label}, NOW()
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        stripe_publishable_key          = EXCLUDED.stripe_publishable_key,
        stripe_secret_encrypted         = EXCLUDED.stripe_secret_encrypted,
        stripe_webhook_secret_encrypted = COALESCE(EXCLUDED.stripe_webhook_secret_encrypted,
                                                   finance_settings.stripe_webhook_secret_encrypted),
        stripe_account_label            = EXCLUDED.stripe_account_label,
        stripe_connected_at             = EXCLUDED.stripe_connected_at
    `;

    return ok(res, {
      connected: true,
      accountLabel: summary.label,
      publishable: publishableKey || null,
      webhookConfigured: Boolean(webhookSecret),
      livemode: summary.livemode,
      connectedAt: new Date().toISOString(),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

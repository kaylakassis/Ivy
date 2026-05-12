// GET  /api/finance/stripe-status   — read connection state
// POST /api/finance/stripe-status   — refresh from Stripe API, persist
//
// GET is the read-only "what's our state" call the Finance UI makes on
// mount. POST re-fetches the connected account from Stripe and updates
// the local row — owners hit this when their card says "Pending" and
// they've since finished verification on Stripe's side (or vice versa).
//
// Never returns the encrypted secrets — only metadata.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { appUrl } from '../_lib/tokens.js';
import { platformStripeSecret, fetchAccountSummary } from '../_lib/stripe.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function handleGet(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const status = await readStatus(workspaceId);
    return ok(res, status);
  } catch (err) {
    return serverError(res, err);
  }
}

// Owner-triggered: re-fetch the connected account from Stripe and
// flip onboarding_status if charges are now enabled. Idempotent —
// safe to call repeatedly.
async function handlePost(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT stripe_connect_user_id
        FROM finance_settings WHERE workspace_id = ${workspaceId}
    `;
    const acctId = rows[0]?.stripe_connect_user_id;
    if (!acctId) {
      // Nothing to refresh — caller just gets the current (empty) state.
      const status = await readStatus(workspaceId);
      return ok(res, status);
    }
    const platformKey = platformStripeSecret();
    if (!platformKey) {
      return serverError(res, new Error('Platform STRIPE_SECRET_KEY not configured'));
    }
    try {
      const summary = await fetchAccountSummary({
        secretKey: platformKey,
        stripeAccount: acctId,
      });
      const status = summary.chargesEnabled ? 'complete' : 'pending';
      await sql`
        UPDATE finance_settings SET
          stripe_account_label     = ${summary.label},
          stripe_connect_livemode  = ${!!summary.livemode},
          stripe_onboarding_status = ${status},
          stripe_connected_at      = COALESCE(stripe_connected_at, NOW())
        WHERE workspace_id = ${workspaceId}
      `;
    } catch (err) {
      // Stripe rejected the lookup — most often the acct id is from a
      // different mode (test vs live key). Surface so the UI can show
      // "your saved acct id doesn't match the current Stripe key —
      // disconnect + reconnect."
      // eslint-disable-next-line no-console
      console.warn('[stripe-status refresh] Stripe rejected:', err.message);
    }
    const status = await readStatus(workspaceId);
    return ok(res, status);
  } catch (err) {
    return serverError(res, err);
  }
}

async function readStatus(workspaceId) {
  const { rows } = await sql`
    SELECT
      stripe_publishable_key,
      stripe_account_label,
      stripe_connected_at,
      stripe_connect_user_id,
      stripe_connect_livemode,
      stripe_onboarding_status,
      stripe_webhook_secret_encrypted IS NOT NULL AS webhook_configured,
      stripe_secret_encrypted          IS NOT NULL AS legacy_secret_present
    FROM finance_settings
    WHERE workspace_id = ${workspaceId}
  `;
  const r = rows[0];
  const webhookUrl = `${appUrl()}/api/webhooks/stripe/${workspaceId}`;
  // "Connected" if either:
  //   • Account-Links flow: acct_xxx persisted, regardless of pending/complete.
  //     Stripe API errors on actual charges if charges_enabled=false;
  //     we don't gate locally so the owner sees real Stripe errors
  //     (which are accurate + actionable) rather than synthetic
  //     "not connected" ones.
  //   • Legacy Standard OAuth: secret key persisted.
  const connectedNew = !!r?.stripe_connect_user_id;
  const connectedOld = !!r?.legacy_secret_present;
  const connected = connectedNew || connectedOld;
  // Pending = Express acct exists but Stripe hasn't yet confirmed
  // charges_enabled. UI surfaces a "Refresh status" + "Continue Stripe
  // verification" affordance.
  const pending = !!(r?.stripe_connect_user_id && r.stripe_onboarding_status !== 'complete');
  if (!connected) {
    return { connected: false, pending: false, webhookUrl };
  }
  return {
    connected: true,
    pending,
    accountLabel: r.stripe_account_label || null,
    publishable: r.stripe_publishable_key || null,
    livemode: !!r.stripe_connect_livemode,
    onboardingStatus: r.stripe_onboarding_status || null,
    webhookConfigured: !!r.webhook_configured,
    connectedAt: r.stripe_connected_at,
    webhookUrl,
  };
}

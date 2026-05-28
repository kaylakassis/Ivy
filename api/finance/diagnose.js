// GET /api/finance/diagnose
//
// Workspace-owner self-serve health check for the payment → app delivery
// pipeline. Answers the question "if a client paid right now, would the
// invoice be marked paid and the revenue land?" without the owner having
// to dig through Vercel envs, Stripe Dashboard webhooks, and the DB.
//
// Cousin to stripe-diagnostic.js (super-admin only, deep Stripe API
// probing). This one is owner-scoped: connect state per provider, the
// signing-secret config for each provider's webhook, the correct
// webhook URL to paste into the provider's dashboard, and a recent-
// activity probe that surfaces invoices stuck mid-flight (a checkout
// session was created but no paid-webhook ever came back — the
// classic "I paid but the app doesn't show it" smoking gun).
//
// Returns a structured report so the Finance UI can render pass/fail
// rows. No secrets, no encrypted payloads — only booleans and
// metadata.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { appUrl } from '../_lib/tokens.js';
import { platformStripeSecret, platformWebhookSecret } from '../_lib/stripe.js';
import { fetchFinanceSettings } from '../_lib/finance.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const fs = await fetchFinanceSettings(workspaceId);
    const provider = fs?.paymentProvider || 'stripe';
    const base = appUrl();

    const checks = [];
    const pass = (name, detail) => checks.push({ name, level: 'ok',   detail });
    const warn = (name, detail) => checks.push({ name, level: 'warn', detail });
    const fail = (name, detail) => checks.push({ name, level: 'fail', detail });

    // -- Stripe ---------------------------------------------------------
    // Two flows: Account-Links (platform webhook) and Standard OAuth
    // (per-workspace webhook). Different signing-secret requirements.
    const connectedStripeNew = !!fs?.stripeConnectUserId;
    const connectedStripeOld = !!fs?.stripeSecretEncrypted;
    const stripeConnected    = connectedStripeNew || connectedStripeOld;
    const stripeFlow         = connectedStripeNew ? 'account-links' : connectedStripeOld ? 'standard-oauth' : null;
    const platformPlatformSecretSet = !!platformStripeSecret();
    const platformWebhookSecretSet  = !!platformWebhookSecret();

    const stripeWebhookUrl = stripeFlow === 'account-links'
      ? `${base}/api/webhooks/stripe-platform`
      : `${base}/api/webhooks/stripe/${workspaceId}`;

    if (provider === 'stripe' || stripeConnected) {
      if (!stripeConnected) {
        fail('Stripe connected',
          'Not connected. Open Finance → Payment provider → Connect Stripe.');
      } else if (stripeFlow === 'account-links') {
        if (fs.stripeOnboardingStatus !== 'complete') {
          warn('Stripe Connect onboarding',
            `Status: ${fs.stripeOnboardingStatus || 'pending'}. Owner must finish Stripe verification before charges work. Click "Continue Stripe verification" in Finance, or POST /api/finance/stripe-status to refresh.`);
        } else {
          pass('Stripe Connect onboarding',
            `${fs.stripeAccountLabel || 'connected'} · ${fs.stripeConnectLivemode ? 'live' : 'test'} mode`);
        }
        if (!platformPlatformSecretSet) {
          fail('STRIPE_SECRET_KEY (platform)',
            'Not set. Required for the Account-Links flow. Set STRIPE_SECRET_KEY in Vercel project env and redeploy.');
        } else {
          pass('STRIPE_SECRET_KEY (platform)', 'Present');
        }
        if (!platformWebhookSecretSet) {
          fail('STRIPE_WEBHOOK_SECRET (platform)',
            `Not set. The Account-Links flow routes every connected workspace through one platform webhook; without this secret, signature verification fails and Stripe stops retrying. Add the platform-webhook signing secret from Stripe Dashboard → Developers → Webhooks (the endpoint pointing at ${stripeWebhookUrl}) to Vercel env as STRIPE_WEBHOOK_SECRET and redeploy.`);
        } else {
          pass('STRIPE_WEBHOOK_SECRET (platform)', 'Present');
        }
        pass('Webhook URL to register in Stripe Dashboard', stripeWebhookUrl);
      } else if (stripeFlow === 'standard-oauth') {
        pass('Stripe connected (legacy Standard OAuth)',
          fs.stripeAccountLabel || 'connected');
        // Legacy flow: signing secret stored per-workspace.
        const { rows: secretRows } = await sql`
          SELECT stripe_webhook_secret_encrypted IS NOT NULL AS has_secret
            FROM finance_settings WHERE workspace_id = ${workspaceId}
        `;
        if (!secretRows[0]?.has_secret) {
          fail('Per-workspace webhook signing secret',
            `Not set. Paste the signing secret from your Stripe Dashboard webhook (endpoint URL ${stripeWebhookUrl}) into Finance → Payment provider → Webhook secret. Without it, every Stripe event 400s and never marks invoices paid.`);
        } else {
          pass('Per-workspace webhook signing secret', 'Present');
        }
        pass('Webhook URL to register in Stripe Dashboard', stripeWebhookUrl);
      }
    }

    // -- Square ---------------------------------------------------------
    const squareConnected = !!fs?.squareCredentialsEncrypted;
    if (provider === 'square' || squareConnected) {
      if (!squareConnected) {
        fail('Square connected', 'Not connected. Open Finance → Payment provider → Connect Square.');
      } else {
        pass('Square connected',
          `${fs.squareAccountLabel || 'connected'} · ${fs.squareEnvironment || 'unknown'} environment`);
      }
      // Signature key is optional but strongly recommended; without it the
      // webhook accepts unsigned events from anyone hitting the URL.
      if (!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
        warn('SQUARE_WEBHOOK_SIGNATURE_KEY',
          'Not set. Square webhooks will be accepted without signature verification — anyone who guesses the URL could mark invoices paid. Set this env var (from Square Dashboard → Webhooks) and redeploy.');
      } else {
        pass('SQUARE_WEBHOOK_SIGNATURE_KEY', 'Present');
      }
      pass('Webhook URL to register in Square Dashboard',
        `${base}/api/webhooks/square/${workspaceId}`);
    }

    // -- PayPal ---------------------------------------------------------
    const paypalConnected = !!fs?.paypalMerchantId;
    if (provider === 'paypal' || paypalConnected) {
      if (!paypalConnected) {
        fail('PayPal connected', 'Not connected. Open Finance → Payment provider → Connect PayPal.');
      } else {
        pass('PayPal connected',
          `${fs.paypalAccountLabel || 'connected'} · ${fs.paypalEnvironment || 'unknown'} environment · payments ${fs.paypalPaymentsEnabled ? 'enabled' : 'pending'}`);
      }
      if (!process.env.PAYPAL_WEBHOOK_ID) {
        fail('PAYPAL_WEBHOOK_ID',
          'Not set. Required for PayPal webhook signature verification — without it every paypal payment event 4xxs and invoices never mark paid. Set PAYPAL_WEBHOOK_ID in Vercel env (from PayPal Developer → Webhooks → Webhook ID) and redeploy.');
      } else {
        pass('PAYPAL_WEBHOOK_ID', 'Present');
      }
      pass('Webhook URL to register in PayPal Developer',
        `${base}/api/webhooks/paypal/${workspaceId}`);
    }

    // -- Recent payment activity ---------------------------------------
    // Two reads scoped to this workspace. The "stuck" set is the
    // smoking gun for webhook delivery failures: an invoice that
    // generated a checkout session (stripe_session_id set) but never
    // moved off status='sent' — i.e. someone clicked Pay, Stripe minted
    // a session, and no webhook ever marked the invoice paid.
    const [recent, stuck] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '7 days')  AS paid_7d,
          COUNT(*) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '30 days') AS paid_30d,
          MAX(paid_at)                                                                       AS last_paid_at,
          (SELECT number FROM invoices
            WHERE workspace_id = ${workspaceId} AND status = 'paid'
            ORDER BY paid_at DESC NULLS LAST LIMIT 1)                                        AS last_paid_number,
          (SELECT paid_method FROM invoices
            WHERE workspace_id = ${workspaceId} AND status = 'paid'
            ORDER BY paid_at DESC NULLS LAST LIMIT 1)                                        AS last_paid_method
        FROM invoices WHERE workspace_id = ${workspaceId}
      `,
      // "Stuck" = a checkout session was minted (stripe_session_id is
      // set, which the public pay endpoint writes) but the invoice is
      // still in a pre-paid status >1 hour later. Older than 1h
      // because the dedup table + Stripe's retry cycle should have
      // landed the webhook by then in the happy path.
      sql`
        SELECT id, number, client_name, status, updated_at, stripe_session_id
          FROM invoices
         WHERE workspace_id = ${workspaceId}
           AND status IN ('sent', 'overdue')
           AND stripe_session_id IS NOT NULL
           AND updated_at < NOW() - INTERVAL '1 hour'
         ORDER BY updated_at DESC
         LIMIT 25
      `,
    ]);

    const r = recent.rows[0] || {};
    const stuckRows = stuck.rows || [];
    if (stuckRows.length > 0) {
      fail('Invoices stuck mid-payment',
        `${stuckRows.length} invoice(s) had a checkout session created but never received a paid-webhook. If any of these were actually paid by the client, the webhook isn't reaching the app. Verify the webhook URL + signing secret above, and check Stripe Dashboard → Developers → Webhooks → (your endpoint) → Recent deliveries for non-2xx responses.`);
    } else if (Number(r.paid_30d) > 0) {
      pass('Invoices stuck mid-payment', 'None.');
    } else {
      pass('Invoices stuck mid-payment', 'None — though no payments in the last 30 days to compare against.');
    }

    const recentActivity = {
      paidLast7d:       Number(r.paid_7d || 0),
      paidLast30d:      Number(r.paid_30d || 0),
      lastPaidAt:       r.last_paid_at instanceof Date ? r.last_paid_at.toISOString() : r.last_paid_at,
      lastPaidNumber:   r.last_paid_number || null,
      lastPaidMethod:   r.last_paid_method || null,
      stuckInvoices: stuckRows.map((row) => ({
        id:                row.id,
        number:            row.number,
        clientName:        row.client_name,
        status:            row.status,
        updatedAt:         row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        stripeSessionId:   row.stripe_session_id,
      })),
    };

    // Overall verdict — fail beats warn beats ok. Drives the banner
    // colour in the Finance UI.
    const levels = checks.map((c) => c.level);
    const overall = levels.includes('fail') ? 'error'
      : levels.includes('warn') ? 'warning'
      : 'ok';

    return ok(res, {
      overall,
      provider,
      appUrl: base,
      stripe: {
        connected: stripeConnected,
        flow: stripeFlow,
        accountLabel: fs?.stripeAccountLabel || null,
        livemode: !!fs?.stripeConnectLivemode,
        onboardingStatus: fs?.stripeOnboardingStatus || null,
        webhookUrl: stripeWebhookUrl,
        platformSecretKeySet: platformPlatformSecretSet,
        platformWebhookSecretSet: platformWebhookSecretSet,
      },
      square: {
        connected: squareConnected,
        accountLabel: fs?.squareAccountLabel || null,
        environment: fs?.squareEnvironment || null,
        webhookUrl: `${base}/api/webhooks/square/${workspaceId}`,
        signatureKeySet: !!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      },
      paypal: {
        connected: paypalConnected,
        accountLabel: fs?.paypalAccountLabel || null,
        environment: fs?.paypalEnvironment || null,
        paymentsEnabled: !!fs?.paypalPaymentsEnabled,
        webhookUrl: `${base}/api/webhooks/paypal/${workspaceId}`,
        webhookIdSet: !!process.env.PAYPAL_WEBHOOK_ID,
      },
      recentActivity,
      checks,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

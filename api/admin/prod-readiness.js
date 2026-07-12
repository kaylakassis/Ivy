// /api/admin/prod-readiness  (admin-only)
//
// Probes the live environment and returns a punch-list of what's
// configured vs missing. Run this from the deployed URL after every
// env-var change to confirm the launch surface is green.
//
// Auth: requireSuperAdmin (same allowlist as /api/admin/*).
//
// Output shape:
//   { ok: boolean, blockers: N, warnings: N, checks: [
//       { key, level: 'ok'|'warn'|'fail', label, detail? },
//     ] }
//
// `level: 'fail'` is a launch BLOCKER - you cannot go live until every
// one of these is green.  `'warn'` means a feature won't work but the
// app boots fine without it (e.g. Twilio missing → SMS off; everything
// else still works).
import { sql } from '../_lib/db.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { ok, methodNotAllowed, serverError } from '../_lib/json.js';

const REQUIRED_LEN = 32;
const DEFAULT_PLACEHOLDERS = new Set([
  '', 'change-me', 'change-me-to-a-long-random-string', 'todo',
  'replace-me', 'xxx', 'secret',
]);

function isDefaultish(v) {
  if (!v) return true;
  return DEFAULT_PLACEHOLDERS.has(String(v).toLowerCase().trim());
}

function check(key, label, level, detail) {
  return { key, label, level, detail };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    const checks = [];

    // ── Core secrets (BLOCKERS) ─────────────────────────────────────
    const jwt = process.env.JWT_SECRET || '';
    if (isDefaultish(jwt)) {
      checks.push(check('jwt_secret', 'JWT_SECRET', 'fail',
        'Not set or still the placeholder. Sessions can be forged. Generate with `openssl rand -hex 32`.'));
    } else if (jwt.length < REQUIRED_LEN) {
      checks.push(check('jwt_secret', 'JWT_SECRET', 'fail',
        `Only ${jwt.length} chars - must be ≥ ${REQUIRED_LEN}. Regenerate with \`openssl rand -hex 32\`.`));
    } else {
      checks.push(check('jwt_secret', 'JWT_SECRET', 'ok', `${jwt.length} chars`));
    }

    const admin = process.env.ADMIN_SECRET || '';
    if (isDefaultish(admin) || admin.length < REQUIRED_LEN) {
      checks.push(check('admin_secret', 'ADMIN_SECRET', 'fail',
        'Not set or too short. Used by /api/admin/* and the cron-secret fallback path.'));
    } else {
      checks.push(check('admin_secret', 'ADMIN_SECRET', 'ok', `${admin.length} chars`));
    }

    const cron = process.env.CRON_SECRET || '';
    if (isDefaultish(cron) || cron.length < REQUIRED_LEN) {
      checks.push(check('cron_secret', 'CRON_SECRET', 'fail',
        "Vercel cron jobs will be rejected with 401 every time. Reminders, dunning, recurring invoices, Stripe reconcile, Ivy nudges - none of them run."));
    } else {
      checks.push(check('cron_secret', 'CRON_SECRET', 'ok', `${cron.length} chars`));
    }

    const secKey = process.env.SECRETS_KEY || '';
    if (isDefaultish(secKey) || secKey.length < REQUIRED_LEN) {
      checks.push(check('secrets_key', 'SECRETS_KEY', 'fail',
        'Required to encrypt at-rest provider tokens (legacy Stripe/PayPal/Google refresh tokens). Without it, /finance/* writes throw.'));
    } else {
      checks.push(check('secrets_key', 'SECRETS_KEY', 'ok', `${secKey.length} chars`));
    }

    // ── App URL (BLOCKER if pointed at localhost in production) ─────
    const appUrl = process.env.APP_URL || process.env.VITE_APP_URL || '';
    if (!appUrl) {
      checks.push(check('app_url', 'APP_URL', 'fail',
        'Not set. Every email link (invoice, reset, booking confirmation) will be broken.'));
    } else if (/localhost|127\.0\.0\.1/.test(appUrl)) {
      checks.push(check('app_url', 'APP_URL', 'fail',
        `Still points at "${appUrl}". Email links will redirect customers to localhost.`));
    } else if (!/^https:\/\//.test(appUrl)) {
      checks.push(check('app_url', 'APP_URL', 'warn',
        `Not HTTPS: "${appUrl}". Browsers will refuse to set the secure session cookie - sign-in will silently fail.`));
    } else {
      checks.push(check('app_url', 'APP_URL', 'ok', appUrl));
    }

    // ── Database connectivity + migration applied (BLOCKER) ─────────
    try {
      const r = await sql`SELECT 1 AS ok`;
      if (r.rows[0]?.ok === 1) {
        // Tables exist?
        const t = await sql`
          SELECT COUNT(*)::int AS n FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name IN ('users','workspaces','clients','invoices','bookings','group_threads')
        `;
        const n = t.rows[0]?.n || 0;
        if (n < 6) {
          checks.push(check('database', 'Database migrations', 'fail',
            `Only ${n}/6 core tables present - run POST /api/admin/migrate with x-admin-secret.`));
        } else {
          checks.push(check('database', 'Database connected + migrated', 'ok'));
        }
      }
    } catch (err) {
      checks.push(check('database', 'Database', 'fail',
        `Connection failed: ${err.message}. Confirm DATABASE_URL points at the production Neon database.`));
    }

    // ── Super-admin email (BLOCKER if you want admin UI access) ─────
    if (!process.env.SUPER_ADMIN_EMAIL) {
      checks.push(check('super_admin', 'SUPER_ADMIN_EMAIL', 'warn',
        "No super-admin email allowlist. You'll need the x-admin-secret header for every admin call. Set this to your account email to auto-promote it on sign-in."));
    } else {
      checks.push(check('super_admin', 'SUPER_ADMIN_EMAIL', 'ok', process.env.SUPER_ADMIN_EMAIL));
    }

    // ── Stripe (BLOCKER for payments + subscription) ────────────────
    const stripeKey = process.env.STRIPE_SECRET_KEY
      || process.env.IVY_STRIPE_SECRET || process.env.STRIPE_PLATFORM_SECRET || '';
    const stripeWebhook = process.env.STRIPE_WEBHOOK_SECRET
      || process.env.IVY_STRIPE_WEBHOOK_SECRET || '';
    if (!stripeKey) {
      checks.push(check('stripe_key', 'STRIPE_SECRET_KEY', 'fail',
        'Required: Ivy billing + Connect won\'t work without it.'));
    } else {
      const mode = stripeKey.startsWith('sk_live_') ? 'LIVE' : 'TEST';
      checks.push(check('stripe_key', 'STRIPE_SECRET_KEY', mode === 'TEST' ? 'warn' : 'ok',
        `${mode} mode`));
    }
    if (!stripeWebhook) {
      checks.push(check('stripe_webhook', 'STRIPE_WEBHOOK_SECRET', 'fail',
        "Connect platform webhook signature verification will fail every delivery → no auto-mark-paid."));
    } else {
      checks.push(check('stripe_webhook', 'STRIPE_WEBHOOK_SECRET', 'ok'));
    }
    // Subscription billing webhook (separate Stripe endpoint, separate
    // signing secret). Falls back to STRIPE_WEBHOOK_SECRET in code, but
    // that only works if you've intentionally configured a single
    // Stripe endpoint listening for both Connect + subscription events
    // - which the LAUNCH.md runbook does not recommend. Warn the
    // operator when the dedicated var is missing so a misrouted secret
    // doesn't silently break the subscription flow.
    if (!process.env.IVY_BILLING_WEBHOOK_SECRET) {
      checks.push(check('billing_webhook', 'IVY_BILLING_WEBHOOK_SECRET', 'warn',
        "Subscription webhook (/api/webhooks/billing) will fall back to STRIPE_WEBHOOK_SECRET. If you configured separate Stripe endpoints per LAUNCH.md §4a, the subscription endpoint will reject events."));
    } else {
      checks.push(check('billing_webhook', 'IVY_BILLING_WEBHOOK_SECRET', 'ok'));
    }
    if (!process.env.STRIPE_CONNECT_CLIENT_ID) {
      checks.push(check('stripe_connect', 'STRIPE_CONNECT_CLIENT_ID', 'warn',
        "Owners can't onboard Stripe Connect Express until this is set."));
    } else {
      checks.push(check('stripe_connect', 'STRIPE_CONNECT_CLIENT_ID', 'ok'));
    }
    if (!process.env.IVY_STRIPE_PRICE_ID) {
      checks.push(check('stripe_price', 'IVY_STRIPE_PRICE_ID', 'fail',
        "Set to the price_xxx from Stripe → Products → your $8.99/week product. Without it, new signups can't reach Stripe Checkout — checkout.js falls back to a no-card trial, so the card-up-front funnel is NOT engaged."));
    } else {
      checks.push(check('stripe_price', 'IVY_STRIPE_PRICE_ID', 'ok'));
    }

    // Funnel summary - one banner that tells the operator at a glance
    // whether the card-up-front trial is wired. Surfaces the no-card
    // fallback condition (where api/billing/checkout grants a no-card
    // trial instead of going to Stripe Checkout) in plain English,
    // since that's the single most common "I configured Stripe but
    // nothing happened" gotcha.
    const cardUpFrontReady = !!stripeKey && !!process.env.IVY_STRIPE_PRICE_ID;
    if (cardUpFrontReady) {
      checks.push(check('funnel', 'Funnel: card-backed trial', 'ok',
        'New signups will be routed through Stripe Checkout to put a card on file before the trial starts (the funnel rework intent).'));
    } else {
      checks.push(check('funnel', 'Funnel: running on NO-CARD fallback', 'fail',
        `Stripe isn't fully configured, so api/billing/checkout grants every new signup a 14-day no-card trial instead of routing them through Stripe Checkout. The app keeps working, but the conversion lift from card-up-front isn't engaged. Set STRIPE_SECRET_KEY${process.env.IVY_STRIPE_PRICE_ID ? '' : ' AND IVY_STRIPE_PRICE_ID'} and redeploy to engage the intended funnel.`));
    }

    // ── Email (BLOCKER for password reset + verification) ───────────
    if (!process.env.RESEND_API_KEY) {
      checks.push(check('email', 'RESEND_API_KEY', 'fail',
        "No outbound email. Password resets, verification emails, invoice emails - all silently fail."));
    } else {
      checks.push(check('email', 'RESEND_API_KEY', 'ok'));
    }
    const from = process.env.EMAIL_FROM || '';
    if (!from) {
      checks.push(check('email_from', 'EMAIL_FROM', 'fail',
        'Required - Resend rejects sends without a verified From address.'));
    } else if (/noreply@|no-reply@/i.test(from)) {
      checks.push(check('email_from', 'EMAIL_FROM', 'warn',
        `"${from}" - Gmail/Outlook deprioritize "noreply" senders. Spam fold likely.`));
    } else {
      checks.push(check('email_from', 'EMAIL_FROM', 'ok', from));
    }

    // ── Push (WARN - feature degrades but app works) ────────────────
    const vapidPub  = process.env.VAPID_PUBLIC_KEY  || '';
    const vapidPriv = process.env.VAPID_PRIVATE_KEY || '';
    if (!vapidPub || !vapidPriv) {
      checks.push(check('push', 'VAPID push keys', 'warn',
        "No web push - Ivy nudges, payment alerts, message notifications etc. go email-only."));
    } else if (!process.env.VAPID_SUBJECT) {
      checks.push(check('push', 'VAPID push keys', 'warn',
        'Keys set but VAPID_SUBJECT missing - some browsers will refuse the subscription. Set to mailto:you@yours.'));
    } else {
      checks.push(check('push', 'VAPID push keys', 'ok'));
    }

    // ── Vercel Blob (WARN - docs/attachments degrade) ───────────────
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      checks.push(check('blob', 'BLOB_READ_WRITE_TOKEN', 'warn',
        "Document uploads + e-signature audit PDFs + message attachments will fail with a 400."));
    } else {
      checks.push(check('blob', 'BLOB_READ_WRITE_TOKEN', 'ok'));
    }

    // ── Ivy (WARN - falls back to deterministic mock) ───────────────
    if (!process.env.ANTHROPIC_API_KEY) {
      checks.push(check('ivy', 'ANTHROPIC_API_KEY', 'warn',
        "Ivy will return canned mock responses instead of reasoning."));
    } else {
      checks.push(check('ivy', 'ANTHROPIC_API_KEY', 'ok'));
    }

    // ── Sentry (NICE-TO-HAVE) ───────────────────────────────────────
    if (process.env.SENTRY_DSN) {
      checks.push(check('sentry', 'SENTRY_DSN', 'ok'));
    } else {
      checks.push(check('sentry', 'SENTRY_DSN', 'warn',
        "No error tracking. Day-one production bugs will go unnoticed unless you tail Vercel logs manually."));
    }

    // ── Optional providers (informational) ──────────────────────────
    const twilio = !!(process.env.IVY_TWILIO_ACCOUNT_SID
      && process.env.IVY_TWILIO_AUTH_TOKEN
      && process.env.IVY_TWILIO_FROM_NUMBER);
    checks.push(check('twilio', 'Twilio (SMS)', twilio ? 'ok' : 'warn',
      twilio ? 'Configured' : 'Optional - SMS features no-op gracefully without it.'));
    const square = !!(process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_APPLICATION_SECRET);
    checks.push(check('square', 'Square', square ? 'ok' : 'warn',
      square ? 'Configured' : 'Optional - workspaces can\'t pick Square checkout without it.'));
    const paypal = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
    checks.push(check('paypal', 'PayPal', paypal ? 'ok' : 'warn',
      paypal ? 'Configured' : "Optional - workspaces can't pick PayPal checkout without it."));
    const google = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    checks.push(check('google', 'Google Calendar OAuth', google ? 'ok' : 'warn',
      google ? 'Configured' : 'Optional - busy-sync feature degrades to manual entry without it.'));

    // ── Process flags ───────────────────────────────────────────────
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      checks.push(check('node_env', 'NODE_ENV', 'warn',
        `Currently "${nodeEnv}" - production error sanitization is OFF. Stack traces will leak to API responses.`));
    } else {
      checks.push(check('node_env', 'NODE_ENV', 'ok', 'production'));
    }

    const blockers = checks.filter((c) => c.level === 'fail').length;
    const warnings = checks.filter((c) => c.level === 'warn').length;
    return ok(res, {
      ok: blockers === 0,
      blockers,
      warnings,
      goLive: blockers === 0
        ? 'Ready. All required config present. Run a live smoke test before flipping public.'
        : `${blockers} blocker(s) remaining - not safe to launch yet.`,
      checks,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

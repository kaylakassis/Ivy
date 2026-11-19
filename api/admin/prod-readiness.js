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
import { MODEL_PRICES } from '../_lib/ivyPricing.js';
import { buildProviderJwt } from '../_lib/apns.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { ok, methodNotAllowed, serverError } from '../_lib/json.js';
import { probeProvider, globalIvyCeiling } from '../_lib/ivy.js';
import { appleConfigMissing, appleEnvironment, mintToken } from '../_lib/appStoreServer.js';
import { OPS_ALERT_CRON, opsAlertRecipient } from '../_lib/opsAlerts.js';
import { ivyPostalAddress, ivyPostalAddressSource } from '../_lib/postalAddress.js';

const REQUIRED_LEN = 32;
const DEFAULT_PLACEHOLDERS = new Set([
  '', 'change-me', 'change-me-to-a-long-random-string', 'todo',
  'replace-me', 'xxx', 'secret',
]);

function isDefaultish(v) {
  if (!v) return true;
  return DEFAULT_PLACEHOLDERS.has(String(v).toLowerCase().trim());
}

// "Neon, us-east-2" from the connection address: only the provider and the
// region, never the address itself.
export function databaseLocation(url) {
  let host = '';
  try { host = new URL(String(url).replace(/^postgres(ql)?:\/\//, 'http://')).hostname; } catch { return 'address not readable'; }
  const neon = host.match(/\.([a-z]{2}-[a-z]+-\d)\.(aws|azure|gcp)\.neon\.tech$/) || host.match(/\.([a-z0-9-]+)\.(aws|azure|gcp)\.neon\.tech$/);
  if (neon) return `Neon, region ${neon[1]} (${neon[2].toUpperCase()})`;
  if (/neon\.tech$/.test(host)) return 'Neon (region not in the address)';
  if (/^(localhost|127\.0\.0\.1)$/.test(host)) return 'this machine';
  return 'not a Neon address';
}

function check(key, label, level, detail) {
  return { key, label, level, detail };
}

// ── Required items, reusable without an HTTP request ───────────────
// The hourly operator check (api/cron/ops-alerts.js) runs these same
// functions and emails the operator when any of them reports 'fail', so
// a regression is noticed before anyone opens this page.

// Core secrets + app URL.
export function coreConfigChecks() {
  const checks = [];
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
  return checks;
}

// Database connectivity + core tables.
export async function databaseCheck() {
  const checks = [];
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
  return checks[0] || check('database', 'Database', 'fail', 'The connectivity probe returned no row.');
}

// Outbound email provider.
export function emailChecks() {
  const checks = [];
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
  return checks;
}

export async function requiredChecks() {
  return [...coreConfigChecks(), await databaseCheck(), ...emailChecks()];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    // Core secrets, app URL (BLOCKERS) and database (BLOCKER).
    const checks = [...coreConfigChecks(), await databaseCheck()];

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
        "Set to the price_xxx from Stripe → Products → your $8.99/week product. Without it, new signups can't reach Stripe Checkout, and checkout.js falls back to a no-card trial, so the card-up-front funnel is NOT engaged."));
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
    checks.push(...emailChecks());

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
      checks.push(check('ivy', 'AI model API key', 'warn',
        "Ivy will return canned mock responses instead of reasoning."));
    } else {
      checks.push(check('ivy', 'AI model API key', 'ok'));
    }

    // ── Sentry (NICE-TO-HAVE) ───────────────────────────────────────
    if (process.env.SENTRY_DSN) {
      checks.push(check('sentry', 'SENTRY_DSN', 'ok'));
    } else {
      checks.push(check('sentry', 'SENTRY_DSN', 'warn',
        "No error tracking. Day-one production bugs will go unnoticed unless you tail Vercel logs manually."));
    }

    // ── Operator alerts (WARN) ──────────────────────────────────────
    // The hourly ops-alerts cron emails the operator when Ivy replies
    // fail, a cron goes quiet, webhooks are rejected, or a required item
    // above regresses. Green means someone is set to receive those emails
    // and the check has actually run recently.
    try {
      const recipient = opsAlertRecipient();
      const last = (await sql`SELECT finished_at FROM cron_runs WHERE name = ${OPS_ALERT_CRON} AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).rows[0];
      const active = (await sql`SELECT key, last_title FROM ops_alert_state WHERE active = TRUE ORDER BY first_seen_at`).rows;
      const ageMs = last ? Date.now() - new Date(last.finished_at).getTime() : null;
      const recent = ageMs != null && ageMs < 3 * 3600e3;
      const activeNote = active.length === 0
        ? 'No conditions active.'
        : `${active.length} condition${active.length === 1 ? '' : 's'} active: ${active.map((a) => a.last_title || a.key).join('; ')}.`;
      if (!recipient) {
        checks.push(check('ops_alerts', 'Operator alerts', 'warn',
          `Nobody receives alert emails. Set OPS_ALERT_EMAIL (or SUPER_ADMIN_EMAIL) so Ivy failures, quiet crons and webhook rejections reach you by email. ${activeNote}`));
      } else if (!last) {
        checks.push(check('ops_alerts', 'Operator alerts', 'warn',
          `Emails would go to ${recipient}, but the hourly ops-alerts cron has not run yet. Check CRON_SECRET and the cron list in vercel.json. ${activeNote}`));
      } else if (!recent) {
        checks.push(check('ops_alerts', 'Operator alerts', 'warn',
          `Emails go to ${recipient}, but the last ops-alerts run was ${Math.round(ageMs / 3600e3)} hours ago (expected hourly). Check the Vercel cron logs. ${activeNote}`));
      } else {
        checks.push(check('ops_alerts', 'Operator alerts', 'ok',
          `Emails go to ${recipient}. Last check ${Math.max(1, Math.round(ageMs / 60e3))} min ago. ${activeNote}`));
      }
    } catch (e) {
      checks.push(check('ops_alerts', 'Operator alerts', 'warn', `could not check: ${e.message}`));
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
    const ppMissing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_PARTNER_ID', 'PAYPAL_WEBHOOK_ID'].filter((k) => !process.env[k]);
    const ppEnv = (process.env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase();
    checks.push(check('paypal', 'PayPal', ppMissing.length === 0 ? (ppEnv === 'live' ? 'ok' : 'warn') : 'warn',
      ppMissing.length === 0
        ? (ppEnv === 'live' ? 'Configured (live). Owners can connect PayPal and clients can pay with PayPal, Venmo, Pay Later and cards.' : `Configured but PAYPAL_ENVIRONMENT is "${ppEnv}": real clients cannot pay until it is "live".`)
        : `Optional. Missing ${ppMissing.join(', ')}; owners cannot connect PayPal until these are set (see docs/paypal-setup.md).`));
    const google = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    checks.push(check('google', 'Google Calendar OAuth', google ? 'ok' : 'warn',
      google ? 'Configured' : 'Optional - busy-sync feature degrades to manual entry without it.'));

    // ── App Store Server API (WARN - Apple referral rewards bank) ──
    // Used to add free weeks to iPhone subscriptions (referral rewards).
    // Mint a token locally to prove the key parses and signs; no call to
    // Apple is made here.
    const appleMissing = appleConfigMissing();
    if (appleMissing.length) {
      checks.push(check('apple_server_api', 'App Store Server API', 'warn',
        `Missing ${appleMissing.join(', ')}. Referral free weeks for iPhone subscribers stay banked until this is set (see docs/referrals-apple.md).`));
    } else {
      try {
        const token = mintToken();
        const kid = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).kid;
        checks.push(check('apple_server_api', 'App Store Server API', 'ok',
          `Token minted with key ${kid} (${appleEnvironment()} environment, bundle ${process.env.APP_STORE_BUNDLE_ID || process.env.APNS_BUNDLE_ID || 'ai.joinivy.app'}).`));
      } catch (e) {
        checks.push(check('apple_server_api', 'App Store Server API', 'fail',
          `Vars are set but a token could not be minted: ${e.message}. Check that APP_STORE_PRIVATE_KEY is the full .p8 contents.`));
      }
    }

    // ── Process flags ───────────────────────────────────────────────
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      checks.push(check('node_env', 'NODE_ENV', 'warn',
        `Currently "${nodeEnv}" - production error sanitization is OFF. Stack traces will leak to API responses.`));
    } else {
      checks.push(check('node_env', 'NODE_ENV', 'ok', 'production'));
    }

    // ── Ivy assistant - a real one-token call, not an env probe ──
    // Recent failed live replies (what the owner saw as "couldn't put
    // together an answer"), with the real reason for each.
    try {
      const f = await sql`SELECT status, error_name, message, created_at, workspace_id
                            FROM ivy_failures WHERE created_at > NOW() - INTERVAL '24 hours'
                           ORDER BY created_at DESC LIMIT 200`;
      const n = f.rows.length;
      const sample = f.rows.slice(0, 5).map((r) =>
        `${new Date(r.created_at).toISOString().slice(11, 16)}Z ${r.status || '-'} ${r.error_name || ''}: ${String(r.message || '').slice(0, 140)}`);
      checks.push(check('ai_failures', 'Ivy failed replies (24h)', n === 0 ? 'ok' : n < 5 ? 'warn' : 'fail',
        n === 0 ? 'none' : `${n} failed repl${n === 1 ? 'y' : 'ies'} · latest: ${sample.join(' | ')}`));
    } catch (e) {
      checks.push(check('ai_failures', 'Ivy failed replies (24h)', 'warn', `could not read: ${e.message}`));
    }
    // What Ivy actually costs, from the tokens we recorded (30 days), priced
    // per model so the operator can see cost per message and per workspace.
    try {
      const PRICE = MODEL_PRICES;
      const u = await sql`
        SELECT model, SUM(input_tokens)::bigint AS inp, SUM(output_tokens)::bigint AS outp,
               SUM(cache_read_tokens)::bigint AS cr, SUM(cache_creation_tokens)::bigint AS cw,
               SUM(request_count)::bigint AS msgs, COUNT(DISTINCT workspace_id)::int AS ws
          FROM ivy_usage WHERE day > CURRENT_DATE - 30 GROUP BY model`;
      let cost = 0, msgs = 0, unknown = [];
      const parts = { reload: 0, reread: 0, fresh: 0, reply: 0 };
      const wsSet = new Set();
      for (const r of u.rows) {
        const key = Object.keys(PRICE).find((k) => String(r.model || '').startsWith(k));
        msgs += Number(r.msgs);
        if (!key) { unknown.push(r.model); continue; }
        const [pi, po, pcr, pcw] = PRICE[key];
        cost += (Number(r.inp) * pi + Number(r.outp) * po + Number(r.cr) * pcr + Number(r.cw) * pcw) / 1e6;
        parts.reload += Number(r.cw) * pcw / 1e6;
        parts.reread += Number(r.cr) * pcr / 1e6;
        parts.fresh  += Number(r.inp) * pi / 1e6;
        parts.reply  += Number(r.outp) * po / 1e6;
      }
      // Where the money went. "Reloading" is the one-off charge to load Ivy's
      // instructions after nobody has used her for an hour; it shrinks as a
      // share when more people use her, because one load then serves everyone.
      const pct = (x) => (cost > 0 ? Math.round((x / cost) * 100) : 0);
      const where = cost > 0
        ? ` Where it went: ${pct(parts.reload)}% reloading Ivy's instructions after a quiet hour, ${pct(parts.reread)}% reusing them, ${pct(parts.fresh)}% new input, ${pct(parts.reply)}% replies.`
        : '';
      const wsCount = Number((await sql`SELECT COUNT(DISTINCT workspace_id)::int AS n FROM ivy_usage WHERE day > CURRENT_DATE - 30`).rows[0]?.n || 0);
      const perMsg = msgs ? cost / msgs : 0;
      checks.push(check('ai_cost', 'Ivy cost (30 days)', 'ok',
        msgs === 0 ? 'No Ivy messages in the last 30 days.'
          : `$${cost.toFixed(2)} for ${msgs} messages across ${wsCount} workspace${wsCount === 1 ? '' : 's'} = $${perMsg.toFixed(4)} per message, $${(wsCount ? cost / wsCount : 0).toFixed(2)} per workspace.${where}${unknown.length ? ` Unpriced model(s): ${unknown.join(', ')}.` : ''}`));
    } catch (e) {
      checks.push(check('ai_cost', 'Ivy cost (30 days)', 'warn', `could not compute: ${e.message}`));
    }
    // How far this server is from the database. Every query is its own
    // round trip, and a screen makes many (the dashboard about 78), so a
    // server on another continent makes every screen slow. The load test
    // measured 0.1s for a booking page with the database next door and 1.5s
    // with it 80ms away. Shows where the database is, which server answered,
    // and what one round trip actually costs from here.
    try {
      const where = databaseLocation(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
      const times = [];
      for (let i = 0; i < 5; i++) { const t0 = Date.now(); await sql`SELECT 1`; times.push(Date.now() - t0); }
      times.sort((x, y) => x - y);
      const ms = times[2];
      const served = process.env.VERCEL_REGION || 'this machine';
      checks.push(check('db_distance', 'Database distance', ms > 40 ? 'warn' : 'ok',
        `Database: ${where}. This request was answered by the server in ${served}, and one round trip to the database took ${ms} ms (the middle of 5 tries). `
        + (ms > 40
          ? 'That is far: people served from this region wait for every query to cross that distance. Run the servers in the region next to the database (the "regions" list in vercel.json).'
          : 'That is close, which is what you want. A different result when you open this page from another part of the world means some servers are far from the database.')));
    } catch (e) {
      checks.push(check('db_distance', 'Database distance', 'warn', `could not measure: ${e.message}`));
    }
    // The platform-wide daily ceiling on Ivy. When it is reached Ivy stops
    // answering for EVERYONE until the next day (UTC), so the operator needs
    // to see how close a normal day and the busiest recent day come to it.
    // It counts new input plus replies (not the reused instructions).
    try {
      const c = await globalIvyCeiling();
      const d = await sql`
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
               COALESCE(SUM(request_count), 0)::bigint AS msgs
          FROM ivy_usage WHERE day > CURRENT_DATE - 30`;
      const peak = await sql`
        SELECT day::text AS day, SUM(input_tokens + output_tokens)::bigint AS tokens, SUM(request_count)::bigint AS msgs
          FROM ivy_usage WHERE day > CURRENT_DATE - 30
         GROUP BY day ORDER BY SUM(input_tokens + output_tokens) DESC LIMIT 1`;
      const n = (x) => Number(x || 0).toLocaleString('en-US');
      const share = (used, cap) => (cap > 0 ? Math.round((Number(used) / cap) * 100) : 0);
      const perMsg = Number(d.rows[0]?.msgs) > 0 ? Number(d.rows[0].tokens) / Number(d.rows[0].msgs) : 0;
      const room = c.tokenCap > 0 && perMsg > 0 ? Math.floor(c.tokenCap / perMsg) : null;
      const limit = (cap, isSet, name) => (cap > 0
        ? `${n(cap)} (${isSet ? `set in Vercel as ${name}` : `the built-in default; add ${name} in Vercel to change it`})`
        : `off (${name} is set to 0)`);
      const todayPct = Math.max(share(c.usage.tokens, c.tokenCap), share(c.usage.requests, c.requestCap));
      const p = peak.rows[0];
      const peakPct = p ? Math.max(share(p.tokens, c.tokenCap), share(p.msgs, c.requestCap)) : 0;
      const detail = [
        `Today: ${n(c.usage.requests)} messages and ${n(c.usage.tokens)} counted tokens (${todayPct}% of the ceiling).`,
        p ? `Busiest day in the last 30: ${n(p.msgs)} messages (${peakPct}%).` : null,
        room != null ? `At the recent average of ${n(Math.round(perMsg))} counted tokens a message, the ceiling allows about ${n(Math.min(room, c.requestCap > 0 ? c.requestCap : room))} messages a day across all businesses.` : null,
        `Token limit: ${limit(c.tokenCap, c.tokenCapSet, 'IVY_GLOBAL_DAILY_TOKEN_CAP')}. Message limit: ${limit(c.requestCap, c.requestCapSet, 'IVY_GLOBAL_DAILY_REQUEST_CAP')}.`,
        'When it is reached, Ivy stops answering for everyone until midnight UTC.',
      ].filter(Boolean).join(' ');
      checks.push(check('ai_ceiling', 'Ivy daily ceiling', Math.max(todayPct, peakPct) >= 70 ? 'warn' : 'ok', detail));
    } catch (e) {
      checks.push(check('ai_ceiling', 'Ivy daily ceiling', 'warn', `could not compute: ${e.message}`));
    }
    // The mailing address on Ivy's own emails, as it is actually printed.
    checks.push(check('postal_address', 'Mailing address on Ivy emails', 'ok', `${ivyPostalAddress()} (${ivyPostalAddressSource()})`));
    // iPhone push: config + a provider token we can mint + whether any phone
    // has actually registered. TestFlight and App Store builds use Apple's
    // PRODUCTION push environment; "sandbox" is only for Xcode debug runs.
    try {
      // APNS_BUNDLE_ID is optional: api/_lib/apns.js defaults it to ai.joinivy.app.
      const apnsMissing = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY'].filter((k) => !process.env[k]);
      const apnsEnv = (process.env.APNS_ENV || 'production') === 'sandbox' ? 'sandbox' : 'production';
      const tok = await sql`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE COALESCE(last_used_at, created_at) > NOW() - INTERVAL '7 days')::int AS recent FROM push_device_tokens WHERE platform = 'ios'`;
      const n = tok.rows[0]?.n || 0, recent = tok.rows[0]?.recent || 0;
      if (apnsMissing.length) {
        checks.push(check('apns', 'iPhone push (APNs)', 'fail', `Missing ${apnsMissing.join(', ')}. Phones register tokens (${n} on file) but nothing can be sent.`));
      } else {
        let minted = true, mintErr = '';
        try { buildProviderJwt(); } catch (e) { minted = false; mintErr = e.message; }
        const envNote = apnsEnv === 'sandbox' ? ' APNS_ENV is "sandbox": pushes to TestFlight and App Store installs will be rejected (BadDeviceToken); set it to "production".' : '';
        checks.push(check('apns', 'iPhone push (APNs)', !minted ? 'fail' : (apnsEnv === 'sandbox' || n === 0) ? 'warn' : 'ok',
          !minted ? `Vars are set but the key could not sign a token: ${mintErr}`
            : `Configured (${apnsEnv}), key ${process.env.APNS_KEY_ID}, bundle ${process.env.APNS_BUNDLE_ID || 'ai.joinivy.app'}. ${n} iPhone${n === 1 ? '' : 's'} registered, ${recent} active in the last 7 days.${n === 0 ? ' No phone has registered yet: open the app, allow notifications when asked.' : ''}${envNote}`));
      }
    } catch (e) {
      checks.push(check('apns', 'iPhone push (APNs)', 'warn', `could not check: ${e.message}`));
    }
    const ai = await probeProvider();
    checks.push(check('ai_model', 'Ivy assistant (AI model)', ai.ok ? 'ok' : 'fail',
      ai.ok
        ? `answered in ${ai.ms}ms`
        : `Ivy is answering with canned replies because ${ai.error}.`));

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

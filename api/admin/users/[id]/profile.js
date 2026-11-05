// GET /api/admin/users/:id/profile[?include=stripe]
//
// The super-admin's profile sheet for one person (Admin > Users > Manage):
// account (sign-ins, 2-step, roles, deletion), devices (iPhone app or web,
// push), subscription (plain-language state, source, trial and dunning),
// business (name, link, category, location, setup checklist, connections),
// usage COUNTS, acquisition, and a few "health" hints.
//
// PRIVACY CONTRACT (same as /metrics): nothing here identifies the
// owner's own clients. Counts, dates and booleans only: no client names,
// emails or phone numbers, no message, note, invoice or document text, and
// no IP addresses. The only free text returned is the owner's own answers
// about their business (how they heard about Ivy, who referred them).
//
// ?include=stripe adds a live lookup of the owner's Ivy subscription in
// Stripe (plan price, what they have paid Ivy so far, first payment). It is
// separate so the sheet opens instantly; a Stripe failure only blanks that
// part. Never called for Apple subscribers (Apple keeps those records).
//
// Super-admin only (requireSuperAdmin), same-origin, GET only.
import { sql } from '../../../_lib/db.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { requireSuperAdmin, emailIsSuperAdmin } from '../../../_lib/admin.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';
import { missingRequiredAnswers } from '../../../_lib/onboardingAnswers.js';
import { computeSetupStatus } from '../../../_lib/setupStatus.js';
import { getMonthlyUsage } from '../../../_lib/ivy.js';
import { isWorkspaceActive } from '../../../_lib/clientPortal.js';
import { platformStripeSecret, stripeFetch } from '../../../_lib/stripe.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
// Accounts soft-deleted from Account settings are removed for good by
// db-prune 30 days later (see users.deleted_at in schema.js).
const ACCOUNT_PURGE_DAYS = 30;

const n = (r) => Number(r?.rows?.[0]?.n || 0);
const iso = (v) => (v ? new Date(v).toISOString() : null);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// A sub-query that fails (older database, missing table) degrades to its
// fallback instead of failing the whole sheet.
const safe = (p, fallback) => Promise.resolve(p).catch(() => fallback);
const NO_ROWS = { rows: [] };

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const id = String(req.query?.id || '');
    if (!UUID_RE.test(id)) return notFound(res, 'User not found');

    const u = (await sql`
      SELECT id, email, name, user_type, is_tester, created_at, email_verified_at,
             last_login_at, last_active_at, last_active_platform,
             totp_enrolled_at, mfa_email_enabled_at, deleted_at, onboarding_state
        FROM users WHERE id = ${id}
    `).rows[0];
    if (!u) return notFound(res, 'User not found');

    if (String(req.query?.include || '') === 'stripe') {
      return ok(res, { stripe: await stripeSummary(id) });
    }

    const [wsRes, clientRes, helperRes, loginsRes, lastLoginRes, devRes, webPushRes] = await Promise.all([
      // Oldest business, the one the app uses (same as the Users list).
      sql`
        SELECT w.id, w.created_at, w.onboarded_at, w.subscription_status, w.subscription_source,
               w.trial_ends_at, w.trial_started_at, w.subscription_period_end, w.cancel_at_period_end,
               w.comp_until, w.comp_note, w.converted_at, w.stripe_customer_id, w.stripe_subscription_id,
               w.apple_product_id, w.subscription_past_due_since, w.subscription_failed_attempts,
               w.subscription_suspended_at, w.data_deletion_at, w.data_purged_at,
               COUNT(*) OVER ()::int AS workspace_count
          FROM workspaces w
         WHERE w.owner_id = ${id}
         ORDER BY w.created_at ASC, w.id ASC
         LIMIT 1
      `,
      safe(sql`SELECT COUNT(*)::int AS n FROM clients WHERE user_id = ${id}`, NO_ROWS),
      safe(sql`SELECT COUNT(*)::int AS n FROM staff_members
                WHERE user_id = ${id} AND active = TRUE AND revoked_at IS NULL`, NO_ROWS),
      safe(sql`SELECT COUNT(*)::int AS n FROM audit_events
                WHERE actor_user_id = ${id} AND action = 'auth.login'
                  AND created_at >= NOW() - INTERVAL '30 days'`, NO_ROWS),
      safe(sql`SELECT created_at, user_agent, meta->>'platform' AS platform
                 FROM audit_events
                WHERE actor_user_id = ${id} AND action = 'auth.login'
                ORDER BY created_at DESC LIMIT 1`, NO_ROWS),
      safe(sql`SELECT COUNT(*)::int AS n, MAX(COALESCE(last_used_at, created_at)) AS last
                 FROM push_device_tokens WHERE user_id = ${id}`, NO_ROWS),
      safe(sql`SELECT COUNT(*)::int AS n, MAX(COALESCE(last_used_at, created_at)) AS last
                 FROM push_subscriptions WHERE user_id = ${id}`, NO_ROWS),
    ]);
    const w = wsRes.rows[0] || null;
    const now = Date.now();
    const lastSeen = latest(u.last_active_at, u.last_login_at);
    const lastLogin = lastLoginRes.rows[0] || null;
    const isSuperAdmin = emailIsSuperAdmin(u.email) || u.user_type === 'super_admin';

    const account = {
      name: u.name || null,
      email: u.email,
      emailVerifiedAt: iso(u.email_verified_at),
      createdAt: iso(u.created_at),
      lastLoginAt: iso(u.last_login_at),
      lastActiveAt: iso(lastSeen),
      // auth.login audit rows. Sign-ins only: the iPhone app stays signed
      // in, so a daily app user can show few sign-ins.
      logins30d: n(loginsRes),
      twoStep: {
        app: !!u.totp_enrolled_at,
        email: !!u.mfa_email_enabled_at,
      },
      roles: {
        owner: !!w,
        client: n(clientRes) > 0,
        helper: n(helperRes) > 0,
        tester: !!u.is_tester,
        superAdmin: isSuperAdmin,
        userType: u.user_type || 'regular',
      },
      deletedAt: iso(u.deleted_at),
      purgeAt: u.deleted_at ? new Date(new Date(u.deleted_at).getTime() + ACCOUNT_PURGE_DAYS * DAY).toISOString() : null,
    };

    const devices = {
      // Stamped with last_active_at by requireUser ('web' | 'ios' | 'android').
      lastUsedOn: platformLabel(u.last_active_platform),
      lastSignIn: lastLogin ? {
        at: iso(lastLogin.created_at),
        device: describeDevice(lastLogin.user_agent, lastLogin.platform),
      } : null,
      // The iPhone app does not report its version number to the server.
      appVersion: null,
      iphonePush: { devices: n(devRes), lastUsedAt: iso(devRes.rows[0]?.last) },
      webPush: { browsers: n(webPushRes), lastUsedAt: iso(webPushRes.rows[0]?.last) },
    };

    if (!w) {
      return ok(res, {
        account, devices,
        subscription: null, business: null, usage: null, acquisition: null,
        health: healthHints({ u, lastSeen, now, w: null }),
        privacyNote: PRIVACY_NOTE,
      });
    }

    const wsId = w.id;
    const [cs, prof, fin, site, setup, counts, rev, ivyMonth, ivyLast, refRes] = await Promise.all([
      safe(sql`SELECT biz_name, slug, category, google_connected_at,
                      (google_refresh_token_encrypted IS NOT NULL) AS google_linked
                 FROM calendar_settings WHERE workspace_id = ${wsId}`, NO_ROWS),
      safe(sql`SELECT * FROM workspace_profile WHERE workspace_id = ${wsId}`, NO_ROWS),
      safe(sql`SELECT stripe_secret_encrypted IS NOT NULL AS stripe_legacy,
                      stripe_connect_user_id IS NOT NULL AS stripe_connect,
                      stripe_onboarding_status, payment_provider,
                      (square_credentials_encrypted IS NOT NULL OR square_connected_at IS NOT NULL) AS square,
                      (paypal_merchant_id IS NOT NULL OR paypal_connected_at IS NOT NULL) AS paypal
                 FROM finance_settings WHERE workspace_id = ${wsId}`, NO_ROWS),
      safe(sql`SELECT launched, published_at, custom_domain IS NOT NULL AS has_domain
                 FROM websites WHERE workspace_id = ${wsId}`, NO_ROWS),
      safe(computeSetupStatus({ userId: id, workspaceId: wsId, emailVerifiedAt: u.email_verified_at }), null),
      usageCounts(wsId),
      safe(sql`SELECT total FROM workspace_revenue WHERE workspace_id = ${wsId}`, NO_ROWS),
      safe(getMonthlyUsage(wsId), null),
      safe(sql`SELECT MAX(updated_at) AS last FROM ivy_usage WHERE workspace_id = ${wsId}`, NO_ROWS),
      safe(sql`
        SELECT 'affiliate' AS kind, a.code
          FROM affiliate_uses au JOIN affiliates a ON a.id = au.affiliate_id
         WHERE au.referred_user_id = ${id}
        UNION ALL
        SELECT 'friend' AS kind, r.code
          FROM referrals r
         WHERE r.referred_user_id = ${id}
        LIMIT 1
      `, NO_ROWS),
    ]);
    const c = cs.rows[0] || {};
    const p = prof.rows[0] || null;
    const f = fin.rows[0] || {};
    const site0 = site.rows[0] || null;
    const st = (u.onboarding_state && typeof u.onboarding_state === 'object') ? u.onboarding_state : {};

    const subscription = describeSubscription(w, u, now);
    const setupItems = Array.isArray(setup?.items) ? setup.items : [];

    const business = {
      name: c.biz_name || null,
      slug: c.slug || null,
      category: c.category || null,
      locationState: p?.location_state || null,
      locationCountry: p?.location_country || null,
      createdAt: iso(w.created_at),
      onboardedAt: iso(w.onboarded_at),
      setup: setup ? {
        done: setupItems.filter((i) => i.done).length,
        total: setupItems.length,
        complete: !!setup.complete,
        // Labels + done only (the dashboard's own wording).
        items: setupItems.map((i) => ({ id: i.id, label: i.label, done: !!i.done, required: !!i.required })),
      } : null,
      websitePublished: !!(site0?.launched && site0?.published_at),
      websitePublishedAt: site0?.launched ? iso(site0?.published_at) : null,
      customDomain: !!site0?.has_domain,
      payments: {
        stripe: !!f.stripe_legacy || (!!f.stripe_connect && f.stripe_onboarding_status === 'complete'),
        stripeStarted: !!f.stripe_connect && f.stripe_onboarding_status !== 'complete',
        square: !!f.square,
        paypal: !!f.paypal,
        provider: f.payment_provider || null,
      },
      googleCalendar: !!(c.google_linked || c.google_connected_at),
      workspaceCount: Number(w.workspace_count || 1),
    };

    const usage = {
      ...counts,
      revenueThroughIvy: Number(rev.rows[0]?.total || 0),
      ivy: {
        messagesThisMonth: ivyMonth ? ivyMonth.messages : null,
        allowance: ivyMonth ? ivyMonth.allowance : null,
        lastUsedAt: iso(ivyLast.rows[0]?.last),
      },
    };

    const missing = missingRequiredAnswers(p);
    const acquisition = {
      heardFrom: idsOf(p?.heard_from_ids, p?.heard_from),
      heardFromOther: p?.heard_from_other || null,
      referralName: p?.referral_name || null,
      signupReferral: refRes.rows[0] ? { kind: refRes.rows[0].kind, code: refRes.rows[0].code } : null,
      switchFrom: typeof st.switchFrom === 'string' ? st.switchFrom : null,
      requiredMissing: missing,
    };

    return ok(res, {
      account, devices, subscription, business, usage, acquisition,
      health: healthHints({ u, lastSeen, now, w, subscription, usage, business, missing }),
      privacyNote: PRIVACY_NOTE,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

const PRIVACY_NOTE = 'Counts and dates only. No client names, contact details, messages or notes cross this endpoint.';

const idsOf = (jsonb, legacy) => {
  const a = arr(jsonb);
  if (a.length) return a;
  return legacy ? [legacy] : [];
};

function latest(...vals) {
  let best = null;
  for (const v of vals) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (!Number.isNaN(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best);
}

async function usageCounts(wsId) {
  // Sample data (clients.source = 'demo') is left out everywhere, like the
  // dashboard checklist. Counts only.
  const [clients, bkAll, bk30, bkUpcoming, bkLast, invSent, invPaid, services, programs, helpers] = await Promise.all([
    safe(sql`SELECT COUNT(*)::int AS n FROM clients
              WHERE workspace_id = ${wsId} AND source IS DISTINCT FROM 'demo'`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN clients cl ON cl.id = b.client_id
              WHERE b.workspace_id = ${wsId} AND cl.source IS DISTINCT FROM 'demo'`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN clients cl ON cl.id = b.client_id
              WHERE b.workspace_id = ${wsId} AND cl.source IS DISTINCT FROM 'demo'
                AND b.created_at >= NOW() - INTERVAL '30 days'`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM bookings b LEFT JOIN clients cl ON cl.id = b.client_id
              WHERE b.workspace_id = ${wsId} AND cl.source IS DISTINCT FROM 'demo'
                AND b.cancelled_at IS NULL AND b.date >= CURRENT_DATE`, NO_ROWS),
    safe(sql`SELECT MAX(b.created_at) AS last FROM bookings b LEFT JOIN clients cl ON cl.id = b.client_id
              WHERE b.workspace_id = ${wsId} AND cl.source IS DISTINCT FROM 'demo'`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
              WHERE i.workspace_id = ${wsId} AND i.status <> 'draft' AND cl.source IS DISTINCT FROM 'demo'`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM invoices i LEFT JOIN clients cl ON cl.id = i.client_id
              WHERE i.workspace_id = ${wsId} AND i.status = 'paid' AND cl.source IS DISTINCT FROM 'demo'`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM services WHERE workspace_id = ${wsId}`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM programs WHERE workspace_id = ${wsId}`, NO_ROWS),
    safe(sql`SELECT COUNT(*)::int AS n FROM staff_members
              WHERE workspace_id = ${wsId} AND active = TRUE AND revoked_at IS NULL`, NO_ROWS),
  ]);
  return {
    clients: n(clients),
    bookings: { all: n(bkAll), last30d: n(bk30), upcoming: n(bkUpcoming), lastCreatedAt: iso(bkLast.rows[0]?.last) },
    invoices: { sent: n(invSent), paid: n(invPaid) },
    services: n(services),
    programs: n(programs),
    helpers: n(helpers),
  };
}

// Plain-language subscription state. The UI turns { state, date } into
// words in the viewer's own time zone ("Trial, ends Nov 18").
function describeSubscription(w, u, now) {
  const t = (v) => (v ? new Date(v).getTime() : null);
  const status = w.subscription_status || 'inactive';
  const source = w.subscription_source === 'apple'
    ? 'apple'
    : (w.stripe_subscription_id || w.stripe_customer_id ? 'stripe' : null);
  const base = {
    status,
    source,
    active: isWorkspaceActive(w),
    trialStartedAt: iso(w.trial_started_at),
    trialEndsAt: iso(w.trial_ends_at),
    periodEndsAt: iso(w.subscription_period_end),
    cancelAtPeriodEnd: !!w.cancel_at_period_end,
    convertedAt: iso(w.converted_at),
    pastDueSince: iso(w.subscription_past_due_since),
    failedAttempts: Number(w.subscription_failed_attempts || 0),
    suspendedAt: iso(w.subscription_suspended_at),
    compUntil: iso(w.comp_until),
    compNote: w.comp_note || null,
    appleProductId: w.apple_product_id || null,
    hasStripeCustomer: !!w.stripe_customer_id,
    // A card (Stripe subscription) or an Apple subscription is on file.
    paymentMethodOnFile: !!w.stripe_subscription_id || w.subscription_source === 'apple',
    dataDeletionAt: (!isWorkspaceActive(w) && w.data_deletion_at) ? iso(w.data_deletion_at) : null,
    dataPurgedAt: iso(w.data_purged_at),
  };
  let state = 'inactive';
  let date = null;
  if (u.user_type === 'sponsored' || u.user_type === 'beta') {
    state = u.user_type; // free access by account type
  } else if (w.comp_until && t(w.comp_until) > now) {
    state = 'comped'; date = iso(w.comp_until);
  } else if (status === 'trialing') {
    state = t(w.trial_ends_at) > now ? 'trial' : 'trial_ended'; date = iso(w.trial_ends_at);
  } else if (status === 'active') {
    if (w.cancel_at_period_end) { state = 'cancelling'; date = iso(w.subscription_period_end); }
    else if (t(w.subscription_period_end) > now) { state = 'active'; date = iso(w.subscription_period_end); }
    else { state = 'lapsed'; date = iso(w.subscription_period_end); }
  } else if (status === 'past_due') {
    state = 'past_due'; date = iso(w.subscription_past_due_since);
  } else if (status === 'suspended') {
    state = 'suspended'; date = iso(w.subscription_suspended_at);
  } else if (status === 'cancelled' || status === 'canceled') {
    state = 'cancelled'; date = iso(w.subscription_period_end);
  }
  return { ...base, state, date };
}

function healthHints({ u, lastSeen, now, w, subscription, usage, business, missing }) {
  const out = [];
  const days = (ms) => Math.floor(ms / DAY);
  if (!lastSeen) {
    if (now - new Date(u.created_at).getTime() > DAY) out.push({ level: 'warn', text: 'Has not used Ivy since signing up' });
  } else {
    const idle = days(now - lastSeen.getTime());
    if (idle >= 14) out.push({ level: 'warn', text: `No login or activity in ${idle} days` });
  }
  if (!u.email_verified_at) out.push({ level: 'info', text: 'Email not verified' });
  if (!w) return out;

  if (subscription.state === 'trial' && !subscription.paymentMethodOnFile) {
    const left = Math.ceil((new Date(subscription.trialEndsAt).getTime() - now) / DAY);
    if (left <= 3) out.push({ level: 'warn', text: `Trial ends in ${left} day${left === 1 ? '' : 's'} and no payment method` });
  }
  if (subscription.state === 'past_due') out.push({ level: 'warn', text: 'Payment failed, subscription is past due' });
  if (subscription.state === 'cancelling') out.push({ level: 'warn', text: 'Cancelled, access ends at the end of this period' });
  if (business.workspaceCount > 1) out.push({ level: 'warn', text: `${business.workspaceCount} businesses on this account` });
  if (missing.length) out.push({ level: 'info', text: `Missing ${missing.length} required onboarding answer${missing.length === 1 ? '' : 's'}` });
  if (!business.onboardedAt) out.push({ level: 'info', text: 'Has not finished onboarding' });
  if (usage.services === 0) out.push({ level: 'info', text: "Hasn't added a service" });
  if (usage.clients === 0) out.push({ level: 'info', text: 'No clients yet' });
  else if (usage.bookings.last30d === 0) out.push({ level: 'info', text: 'No new bookings in the last 30 days' });
  if (!business.payments.stripe && !business.payments.square && !business.payments.paypal) {
    out.push({ level: 'info', text: 'No way to take card payments yet' });
  }
  const ivy = usage.ivy;
  if (ivy.allowance && ivy.messagesThisMonth >= ivy.allowance * 0.9) {
    out.push({ level: 'info', text: 'Close to the Ivy message limit this month' });
  }
  return out;
}

function platformLabel(p) {
  if (p === 'ios') return 'iPhone app';
  if (p === 'android') return 'Android app';
  if (p === 'web') return 'Web browser';
  return null;
}

// A short, human device label from a sign-in's user agent. Bounded,
// anchor-free regexes only (no backtracking blowups on hostile input).
export function describeDevice(uaRaw, platform) {
  const ua = String(uaRaw || '').slice(0, 500);
  const iosVer = (/OS (\d{1,2})_(\d{1,2})/.exec(ua) || []).slice(1, 3).join('.');
  if (platform === 'ios') return `iPhone app${iosVer ? ` (iOS ${iosVer})` : ''}`;
  if (platform === 'android') return 'Android app';
  if (!ua) return null;
  const apple = /iPhone|iPad|iPod/.test(ua);
  const os = /iPad/.test(ua) ? 'iPad'
    : /iPhone|iPod/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (/Instagram/.test(ua)) return `Instagram's browser${os ? ` on ${os}` : ''}`;
  if (/FBAN|FBAV/.test(ua)) return `Facebook's browser${os ? ` on ${os}` : ''}`;
  if (/TikTok|musical_ly|BytedanceWebview/.test(ua)) return `TikTok's browser${os ? ` on ${os}` : ''}`;
  // The iPhone app's web view looks like Safari without the "Safari/" token.
  if (apple && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) return `iPhone app${iosVer ? ` (iOS ${iosVer})` : ''}`;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown browser';
}

// Live Stripe lookup of the owner's Ivy subscription (never a client's
// payment). Amounts are what the customer was charged by Ivy.
async function stripeSummary(userId) {
  const w = (await sql`
    SELECT stripe_customer_id, stripe_subscription_id, subscription_source
      FROM workspaces WHERE owner_id = ${userId}
     ORDER BY created_at ASC, id ASC LIMIT 1
  `).rows[0];
  if (!w || w.subscription_source === 'apple') return { available: false, reason: 'apple-or-none' };
  if (!w.stripe_customer_id) return { available: false, reason: 'no-customer' };
  const secretKey = platformStripeSecret();
  if (!secretKey) return { available: false, reason: 'not-configured' };
  try {
    const [inv, sub] = await Promise.all([
      stripeFetch(`/invoices?customer=${encodeURIComponent(w.stripe_customer_id)}&status=paid&limit=100`, { secretKey }),
      w.stripe_subscription_id
        ? stripeFetch(`/subscriptions/${encodeURIComponent(w.stripe_subscription_id)}`, { secretKey }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const paid = (Array.isArray(inv?.data) ? inv.data : []).filter((i) => Number(i?.amount_paid) > 0);
    const currencies = new Set(paid.map((i) => String(i.currency || 'usd').toLowerCase()));
    const paidAt = (i) => Number(i?.status_transitions?.paid_at || i?.created || 0);
    const first = paid.reduce((m, i) => (m == null || paidAt(i) < paidAt(m) ? i : m), null);
    const item = sub?.items?.data?.[0];
    const price = item?.price || item?.plan || null;
    return {
      available: true,
      payments: paid.length,
      moreThanListed: !!inv?.has_more,
      lifetimePaid: paid.reduce((s, i) => s + Number(i.amount_paid || 0), 0) / 100,
      currency: currencies.size === 1 ? [...currencies][0] : (currencies.size ? 'mixed' : 'usd'),
      firstPaymentAt: first ? new Date(paidAt(first) * 1000).toISOString() : null,
      plan: price ? {
        amount: price.unit_amount != null ? Number(price.unit_amount) / 100 : (price.amount != null ? Number(price.amount) / 100 : null),
        currency: price.currency || null,
        interval: price.recurring?.interval || price.interval || null,
        intervalCount: Number(price.recurring?.interval_count || price.interval_count || 1),
      } : null,
      cardOnFile: !!(sub?.default_payment_method || sub?.default_source),
    };
  } catch {
    return { available: false, reason: 'stripe-error' };
  }
}

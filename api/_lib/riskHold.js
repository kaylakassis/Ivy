// Fraud protection: risk holds, risk events and the Admin > Risk list.
//
// A RISK HOLD takes a business offline for everyone: its public booking,
// website and shop pages show the "no longer available" card, every
// checkout is refused, and the owner's app is locked with a plain "on
// hold" message. It lives in its own columns (workspaces.risk_hold_*), not
// in the subscription state, so no billing webhook can lift it. It is
// placed when Stripe REJECTS the business's connected account, or by an
// admin; only an admin lifts it. Nothing is deleted.
//
// Stripe merely RESTRICTING an account (identity check not finished, a
// routine review) does not place a hold: Stripe pauses that account's
// payments itself, and honest businesses hit those states too. Those are
// flagged in the risk list for a person to look at.
import { sql } from './db.js';
import { sendEmail, emailShell } from './email.js';
import { opsAlertRecipient } from './opsAlerts.js';
import { platformStripeSecret, fetchAccountSummary } from './stripe.js';
import { DISPOSABLE_EMAIL_DOMAINS } from './disposableEmail.js';
import { appUrl } from './tokens.js';

export const HOLD_CODE = 'account_on_hold';
export const HOLD_MESSAGE = 'This account is on hold while we review it. Email hello@joinivy.ai and we will sort it out.';

// Stripe's requirements.disabled_reason, in plain words.
export function stripeReasonLabel(reason) {
  const r = String(reason || '');
  if (r === 'rejected.fraud') return 'Stripe rejected this account for suspected fraud';
  if (r === 'rejected.terms_of_service') return 'Stripe rejected this account for breaking its terms';
  if (r === 'rejected.listed') return 'Stripe rejected this account (it matched a prohibited list)';
  if (r.startsWith('rejected.')) return 'Stripe rejected this account';
  if (r === 'under_review') return 'Stripe is reviewing this account';
  if (r === 'listed') return 'Stripe has restricted this account while it checks a prohibited list';
  if (r === 'platform_paused') return 'Payments are paused on this Stripe account';
  if (r.startsWith('requirements.')) return 'Stripe is waiting for identity or business details';
  return r ? 'Stripe has this account disabled' : null;
}
export const isStripeRejection = (reason) => String(reason || '').startsWith('rejected.');
// Disabled for a reason that deserves a human look (not just paperwork).
export const isStripeConcern = (reason) => ['under_review', 'listed', 'platform_paused'].includes(String(reason || ''));

export async function recordRiskEvent(workspaceId, kind, detail = {}) {
  if (!workspaceId || !kind) return;
  try {
    await sql`INSERT INTO risk_events (workspace_id, kind, detail) VALUES (${workspaceId}, ${String(kind).slice(0, 60)}, ${JSON.stringify(detail || {})}::jsonb)`;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[risk] event not recorded:', e.message);
  }
}

export async function riskHoldOf(workspaceId) {
  if (!workspaceId) return null;
  const { rows } = await sql`SELECT risk_hold_at, risk_hold_reason, risk_hold_source FROM workspaces WHERE id = ${workspaceId}`;
  const r = rows[0];
  return r?.risk_hold_at ? { at: r.risk_hold_at, reason: r.risk_hold_reason || null, source: r.risk_hold_source || null } : null;
}
export async function isOnRiskHold(workspaceId) {
  return !!(await riskHoldOf(workspaceId));
}

// 403 for anything a held business (or its clients) tries to do.
export function holdForbidden(res) {
  return res.status(403).json({ error: HOLD_MESSAGE, code: HOLD_CODE });
}

async function gateEvict(workspaceId) {
  // Lazy import: workspaceGate pulls in the auth stack; callers such as
  // webhooks and crons do not need it loaded up front.
  try { (await import('./workspaceGate.js')).evictWorkspaceGateCache(workspaceId); } catch { /* cache expires in 60s anyway */ }
}

// Place a hold. Idempotent: a business already on hold keeps its first
// date, reason and source. Operator accounts are never held (an admin
// cannot lock themselves out, and Stripe cannot do it to them either).
// Returns { ok, placed, reason? }.
export async function placeRiskHold({ workspaceId, reason, source = 'admin', actor = null, detail = {}, notify = true }) {
  if (!workspaceId) return { ok: false, reason: 'missing-workspace' };
  const why = String(reason || '').trim().slice(0, 300) || 'Held for review';
  const src = source === 'stripe' ? 'stripe' : 'admin';
  const { rows } = await sql`
    UPDATE workspaces w SET risk_hold_at = NOW(), risk_hold_reason = ${why}, risk_hold_source = ${src}
      FROM users u
     WHERE w.id = ${workspaceId} AND u.id = w.owner_id
       AND w.risk_hold_at IS NULL
       AND COALESCE(u.user_type, '') <> 'super_admin'
     RETURNING w.id, w.name, u.email AS owner_email, u.name AS owner_name`;
  if (!rows.length) {
    const cur = (await sql`SELECT w.risk_hold_at, u.user_type FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${workspaceId}`).rows[0];
    if (!cur) return { ok: false, reason: 'not-found' };
    if (cur.user_type === 'super_admin') return { ok: false, reason: 'operator-account' };
    return { ok: true, placed: false };
  }
  await gateEvict(workspaceId);
  await recordRiskEvent(workspaceId, 'hold_placed', { source: src, reason: why, by: actor || null, ...detail });
  if (notify && src === 'stripe') {
    await notifyAdminOfHold({ workspaceId, row: rows[0], reason: why }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[risk] hold email failed:', e.message);
    });
  }
  return { ok: true, placed: true };
}

export async function releaseRiskHold({ workspaceId, actor = null }) {
  if (!workspaceId) return { ok: false, reason: 'missing-workspace' };
  const { rows } = await sql`
    UPDATE workspaces SET risk_hold_at = NULL, risk_hold_reason = NULL, risk_hold_source = NULL, risk_reviewed_at = NOW()
     WHERE id = ${workspaceId} AND risk_hold_at IS NOT NULL
     RETURNING id`;
  if (!rows.length) return { ok: true, released: false };
  await gateEvict(workspaceId);
  await recordRiskEvent(workspaceId, 'hold_released', { by: actor || null });
  return { ok: true, released: true };
}

// "Looks fine": hides the business from the list until something new is
// flagged after now.
export async function markRiskReviewed({ workspaceId, actor = null }) {
  const { rows } = await sql`UPDATE workspaces SET risk_reviewed_at = NOW() WHERE id = ${workspaceId} RETURNING id`;
  if (!rows.length) return { ok: false, reason: 'not-found' };
  await recordRiskEvent(workspaceId, 'reviewed', { by: actor || null });
  return { ok: true };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function notifyAdminOfHold({ row, reason }) {
  const to = opsAlertRecipient();
  if (!to) return;
  const name = row.name || row.owner_name || 'A business';
  const html = emailShell({
    heading: 'A business was taken offline',
    body: `
      <p><strong>${esc(name)}</strong> (${esc(row.owner_email || 'no email')}) has been put on hold automatically.</p>
      <p><strong>Why:</strong> ${esc(reason)}.</p>
      <p>Its booking, website and payment pages are off and the owner's app is locked. Nothing was deleted. If this looks like a mistake you can lift the hold in Admin, under Risk.</p>`,
    ctaText: 'Open the risk list',
    ctaUrl: `${appUrl()}/admin?tab=risk`,
    footer: 'You are getting this because you run Ivy. Holds placed by hand do not send this email.',
  });
  await sendEmail({
    to,
    subject: `On hold: ${String(name).slice(0, 80)}`,
    html,
    text: `${name} (${row.owner_email || 'no email'}) has been put on hold automatically. Why: ${reason}. Its booking, website and payment pages are off and the owner's app is locked. Nothing was deleted. Lift the hold in Admin, under Risk: ${`${appUrl()}/admin?tab=risk`}`,
  });
}

// Apply what Stripe says about a connected account. Called from the
// platform webhook (account.updated), the daily reconcile and "Check
// Stripe now". Stores the reason; a rejection places a hold; a review or
// restriction is flagged once per change.
export async function applyStripeAccountStatus({ workspaceId, accountId, disabledReason, summary = null }) {
  if (!workspaceId) return { changed: false };
  // New-business payment limits follow the same answer from Stripe: they
  // lift the moment the account is verified (api/_lib/newBusinessLimits.js).
  if (summary) {
    try {
      const { applyIdentityState } = await import('./newBusinessLimits.js');
      await applyIdentityState({ workspaceId, summary });
    } catch { /* limits stay as they were */ }
  }
  const reason = disabledReason ? String(disabledReason).slice(0, 80) : null;
  const prev = (await sql`SELECT stripe_disabled_reason FROM finance_settings WHERE workspace_id = ${workspaceId}`).rows[0];
  const before = prev?.stripe_disabled_reason || null;
  if (before !== reason) {
    await sql`UPDATE finance_settings SET stripe_disabled_reason = ${reason} WHERE workspace_id = ${workspaceId}`;
  }
  if (isStripeRejection(reason)) {
    if (before !== reason) await recordRiskEvent(workspaceId, 'stripe_rejected', { reason, account: accountId || null });
    const held = await placeRiskHold({
      workspaceId, source: 'stripe', reason: stripeReasonLabel(reason), detail: { stripe_reason: reason, account: accountId || null },
    });
    return { changed: before !== reason, held: !!held.placed, reason };
  }
  if (isStripeConcern(reason) && before !== reason) {
    await recordRiskEvent(workspaceId, 'stripe_restricted', { reason, account: accountId || null });
  }
  return { changed: before !== reason, held: false, reason };
}

// Ask Stripe about every connected account (newest first, bounded) and
// apply the answers. Catches a rejection whose webhook never arrived.
export async function syncStripeAccountStatuses({ limit = 300, deadlineMs = 20000 } = {}) {
  const key = platformStripeSecret();
  if (!key) return { ok: false, reason: 'no-platform-key', checked: 0, held: 0, failed: 0 };
  const started = Date.now();
  const { rows } = await sql`
    SELECT fs.workspace_id, fs.stripe_connect_user_id
      FROM finance_settings fs
      JOIN workspaces w ON w.id = fs.workspace_id
     WHERE fs.stripe_connect_user_id IS NOT NULL
     ORDER BY w.created_at DESC
     LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 300))}`;
  let checked = 0, held = 0, failed = 0;
  for (const r of rows) {
    if (Date.now() - started > deadlineMs) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const summary = await fetchAccountSummary({ secretKey: key, stripeAccount: r.stripe_connect_user_id });
      // eslint-disable-next-line no-await-in-loop
      const out = await applyStripeAccountStatus({ workspaceId: r.workspace_id, accountId: r.stripe_connect_user_id, disabledReason: summary.disabledReason, summary });
      checked++;
      if (out.held) held++;
    } catch {
      failed++;
    }
  }
  return { ok: true, checked, held, failed, total: rows.length, complete: checked + failed >= rows.length };
}

// ── The Admin > Risk list ─────────────────────────────────────────────
const FAILED_WINDOW_HOURS = 24;
const FAILED_THRESHOLD = 3;

// Businesses on hold, plus businesses with at least one flag that has not
// been reviewed since. Newest first within each group.
export async function listRiskAccounts({ limit = 200 } = {}) {
  const { rows } = await sql`
    WITH fails AS (
      SELECT workspace_id, COUNT(*)::int AS n, MAX(created_at) AS last_at
        FROM risk_events
       WHERE kind IN ('payment_failed', 'payment_blocked')
         AND created_at > NOW() - (${FAILED_WINDOW_HOURS}::int * INTERVAL '1 hour')
       GROUP BY workspace_id
    ),
    capped AS (
      SELECT workspace_id, COUNT(*)::int AS n, MAX(created_at) AS last_at
        FROM risk_events
       WHERE kind = 'limit_blocked'
         AND created_at > NOW() - (${FAILED_WINDOW_HOURS}::int * INTERVAL '1 hour')
       GROUP BY workspace_id
    )
    SELECT w.id AS workspace_id, w.name AS workspace_name, w.created_at, w.subscription_status,
           w.risk_hold_at, w.risk_hold_reason, w.risk_hold_source, w.risk_reviewed_at,
           u.id AS owner_id, u.email, u.name AS owner_name, u.email_verified_at, u.signup_country, u.user_type,
           cs.biz_name, cs.slug,
           fs.stripe_connect_user_id, fs.stripe_onboarding_status, fs.stripe_disabled_reason, fs.stripe_identity_state,
           COALESCE(f.n, 0) AS failed_payments, f.last_at AS failed_last_at,
           COALESCE(c.n, 0) AS capped_payments, c.last_at AS capped_last_at
      FROM workspaces w
      JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN finance_settings fs ON fs.workspace_id = w.id
      LEFT JOIN fails f ON f.workspace_id = w.id
      LEFT JOIN capped c ON c.workspace_id = w.id
     WHERE COALESCE(u.user_type, '') <> 'super_admin'
       AND (
            w.risk_hold_at IS NOT NULL
         OR (u.signup_country IS NOT NULL AND u.signup_country <> 'US')
         OR split_part(lower(u.email), '@', 2) = ANY(${DISPOSABLE_EMAIL_DOMAINS})
         OR COALESCE(f.n, 0) >= ${FAILED_THRESHOLD}
         OR COALESCE(c.n, 0) >= 1
         OR fs.stripe_disabled_reason LIKE 'rejected.%'
         OR fs.stripe_disabled_reason IN ('under_review', 'listed', 'platform_paused')
         OR (fs.stripe_connect_user_id IS NOT NULL AND u.email_verified_at IS NULL
             AND w.created_at > NOW() - INTERVAL '60 days')
       )
     ORDER BY (w.risk_hold_at IS NOT NULL) DESC, w.created_at DESC
     LIMIT ${Math.max(1, Math.min(500, Number(limit) || 200))}`;
  const out = [];
  for (const r of rows) {
    const flags = [];
    const reviewed = r.risk_reviewed_at ? new Date(r.risk_reviewed_at).getTime() : 0;
    const created = new Date(r.created_at).getTime();
    // A flag is "fresh" when it could not have been seen at the last review.
    const add = (id, label, at) => flags.push({ id, label, fresh: !reviewed || (at ? new Date(at).getTime() > reviewed : created > reviewed) });
    if (isStripeRejection(r.stripe_disabled_reason) || isStripeConcern(r.stripe_disabled_reason)) add('stripe', stripeReasonLabel(r.stripe_disabled_reason), null);
    if (r.failed_payments >= FAILED_THRESHOLD) add('failed_payments', `${r.failed_payments} failed or blocked card payments in the last ${FAILED_WINDOW_HOURS} hours`, r.failed_last_at);
    if (r.capped_payments >= 1) add('over_limit', `Tried ${r.capped_payments} card ${r.capped_payments === 1 ? 'payment' : 'payments'} over the new-business limits in the last ${FAILED_WINDOW_HOURS} hours`, r.capped_last_at);
    if (r.signup_country && r.signup_country !== 'US') add('outside_us', `Signed up from outside the US (${r.signup_country})`, null);
    if (DISPOSABLE_EMAIL_DOMAINS.includes(String(r.email || '').toLowerCase().split('@')[1] || '')) add('throwaway_email', 'Uses a throwaway email address', null);
    // Only for recent sign-ups: plenty of long-standing honest businesses
    // connected Stripe before this rule existed.
    if (r.stripe_connect_user_id && !r.email_verified_at && created > Date.now() - 60 * 86400e3) add('unverified_email', 'Connected Stripe without confirming their email', null);
    const held = !!r.risk_hold_at;
    // Stripe flags stay fresh until the reason changes; everything else
    // is hidden once reviewed.
    const stripeFlag = flags.find((f) => f.id === 'stripe');
    const visible = held || flags.some((f) => f.fresh) || (stripeFlag && isStripeRejection(r.stripe_disabled_reason));
    if (!visible) continue;
    out.push({
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      businessName: r.biz_name || r.workspace_name || r.owner_name || 'Unnamed business',
      ownerName: r.owner_name || null,
      email: r.email,
      emailVerified: !!r.email_verified_at,
      signupCountry: r.signup_country || null,
      createdAt: r.created_at,
      subscriptionStatus: r.subscription_status || 'inactive',
      bookingSlug: r.slug || null,
      stripeConnected: !!r.stripe_connect_user_id,
      stripeStatus: r.stripe_disabled_reason ? stripeReasonLabel(r.stripe_disabled_reason) : (r.stripe_connect_user_id ? (r.stripe_onboarding_status === 'complete' ? 'Payments on' : 'Not finished setting up') : null),
      // Card payments capped until Stripe verifies the account.
      paymentsLimited: r.stripe_identity_state === 'unverified',
      held,
      holdAt: r.risk_hold_at || null,
      holdReason: r.risk_hold_reason || null,
      holdSource: r.risk_hold_source || null,
      reviewedAt: r.risk_reviewed_at || null,
      flags: flags.map(({ id, label }) => ({ id, label })),
    });
  }
  return out;
}

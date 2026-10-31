// Programs: selling extras. Coupons, free trials, cohorts and bundles.
//
// Coupons are checked HERE, server-side, every time (the public "Apply a
// code" check and again at checkout). The matching coupon on the
// business's connected payment account is created once (and again only if
// the business connects a different account) and passed to Checkout as
// discounts[0][coupon], so the owner's payment dashboard shows the same
// coupon and its redemptions. A code that does not fit the program, has
// expired, was switched off or has been used up always gets the same
// answer, so nobody can probe which codes exist for other programs.
import { sql } from './db.js';
import { stripeFetch } from './stripe.js';
import { zonedTimeToUtcMs, todayISOInZone, isValidTimeZone } from './tz.js';
import { isUuid } from './programs.js';

export const INVALID_CODE = "This code isn't valid for this program.";
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function normalizeCouponCode(s) {
  const c = String(s || '').trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

export async function workspaceTimezone(workspaceId) {
  const tz = (await sql`SELECT timezone FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0]?.timezone;
  return isValidTimeZone(tz) ? tz : 'UTC';
}

// ── coupons ──────────────────────────────────────────────────────────
// Owner input → DB columns. Returns { value } or { error }.
export function cleanCouponInput(body, { currency = 'usd' } = {}) {
  const code = normalizeCouponCode(body.code);
  if (!code) return { error: 'Use 3 to 32 letters, numbers, dashes or underscores for the code.' };
  const kind = body.kind === 'amount' ? 'amount' : 'percent';
  const out = { code, kind, percent_off: null, amount_off_cents: null, currency: null };
  if (kind === 'percent') {
    const pct = Math.round(Number(body.percentOff));
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) return { error: 'Percent off must be between 1 and 100.' };
    out.percent_off = pct;
  } else {
    const cents = Math.round(Number(body.amountOffCents));
    if (!Number.isFinite(cents) || cents < 1 || cents > 100_000_00) return { error: 'Enter how much to take off.' };
    out.amount_off_cents = cents;
    out.currency = String(currency || 'usd').toLowerCase();
  }
  out.duration = body.duration === 'forever' ? 'forever' : 'once';
  if (body.expiresAt) {
    const t = new Date(body.expiresAt);
    if (Number.isNaN(t.getTime())) return { error: 'That expiry date is not valid.' };
    if (t.getTime() <= Date.now()) return { error: 'Pick an expiry date in the future.' };
    out.expires_at = t.toISOString();
  } else out.expires_at = null;
  if (body.maxRedemptions != null && body.maxRedemptions !== '') {
    const n = Math.round(Number(body.maxRedemptions));
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) return { error: 'Max uses must be 1 or more, or blank for no limit.' };
    out.max_redemptions = n;
  } else out.max_redemptions = null;
  out.program_id = body.programId ? String(body.programId) : null;
  if (out.program_id && !isUuid(out.program_id)) return { error: 'Program not found.' };
  return { value: out };
}

export function serializeCoupon(c, extra = {}) {
  return {
    id: c.id, code: c.code, programId: c.program_id || null, kind: c.kind,
    percentOff: c.percent_off == null ? null : Number(c.percent_off),
    amountOffCents: c.amount_off_cents == null ? null : Number(c.amount_off_cents),
    duration: c.duration, expiresAt: c.expires_at || null,
    maxRedemptions: c.max_redemptions == null ? null : Number(c.max_redemptions),
    active: !!c.active, createdAt: c.created_at, ...extra,
  };
}

export const couponLabel = (c) => (c.kind === 'percent' ? `${c.percent_off}% off` : `$${(Number(c.amount_off_cents) / 100).toFixed(2)} off`);

// What the coupon takes off a price (cents), never more than the price.
export function couponDiscountCents(c, priceCents) {
  const p = Math.max(0, Math.round(Number(priceCents) || 0));
  if (!c) return 0;
  if (c.kind === 'percent') return Math.min(p, Math.round((p * Number(c.percent_off)) / 100));
  return Math.min(p, Number(c.amount_off_cents) || 0);
}

export async function redemptionCount(couponId) {
  return (await sql`SELECT COUNT(*)::int AS n FROM program_coupon_redemptions WHERE coupon_id = ${couponId}`).rows[0]?.n || 0;
}

// The coupon behind `code` if it can be used on this program right now,
// else null. Scoped to the program's business; a per-program coupon only
// works on its own program.
export async function findValidCoupon({ program, code, currency = null, now = new Date() }) {
  const c = normalizeCouponCode(code);
  if (!c || !program) return null;
  const row = (await sql`
    SELECT * FROM program_coupons
     WHERE workspace_id = ${program.workspace_id} AND code = ${c} AND active
       AND (program_id IS NULL OR program_id = ${program.id})
     LIMIT 1`).rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return null;
  if (row.kind === 'amount' && currency && row.currency && row.currency.toLowerCase() !== String(currency).toLowerCase()) return null;
  if (row.max_redemptions != null && (await redemptionCount(row.id)) >= Number(row.max_redemptions)) return null;
  return row;
}

// The coupon on the connected account. Created on first use (or again if
// the business has since connected a different account). Idempotent per
// (coupon, account), so two racing checkouts get the same coupon back.
export async function ensureStripeCoupon({ coupon, creds }) {
  if (coupon.stripe_coupon_id && coupon.stripe_account === (creds.stripeAccount || null)) return coupon.stripe_coupon_id;
  const body = { duration: coupon.duration === 'forever' ? 'forever' : 'once', name: coupon.code.slice(0, 40), 'metadata[ivy_coupon_id]': coupon.id, 'metadata[purpose]': 'program' };
  if (coupon.kind === 'percent') body.percent_off = Number(coupon.percent_off);
  else { body.amount_off = Number(coupon.amount_off_cents); body.currency = coupon.currency || 'usd'; }
  if (coupon.max_redemptions != null) body.max_redemptions = Number(coupon.max_redemptions);
  if (coupon.expires_at) body.redeem_by = Math.floor(new Date(coupon.expires_at).getTime() / 1000);
  const made = await stripeFetch('/coupons', {
    method: 'POST', secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, body,
    idempotencyKey: `ivy-program-coupon-${coupon.id}-${creds.stripeAccount || 'own'}`,
  });
  await sql`UPDATE program_coupons SET stripe_coupon_id = ${made.id}, stripe_account = ${creds.stripeAccount || null}, updated_at = NOW()
            WHERE id = ${coupon.id} AND workspace_id = ${coupon.workspace_id}`;
  return made.id;
}

export async function recordRedemption({ workspaceId, couponId, programId, clientId, ref, discountCents = 0 }) {
  if (!couponId || !ref) return false;
  const r = await sql`
    INSERT INTO program_coupon_redemptions (workspace_id, coupon_id, program_id, client_id, ref, discount_cents)
    VALUES (${workspaceId}, ${couponId}, ${programId}, ${clientId}, ${ref}, ${Math.max(0, Math.round(discountCents || 0))})
    ON CONFLICT (coupon_id, ref) DO NOTHING RETURNING id`;
  return r.rows.length > 0;
}

// ── trials ───────────────────────────────────────────────────────────
// A subscription program with trial days offers one free trial per person
// per program: not if this email already had one, and not for someone who
// was a member before.
export async function trialEligible({ program, email, clientId = null }) {
  if (!program || program.billing === 'one_time' || !program.trial_days) return false;
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const used = (await sql`SELECT 1 FROM program_trials WHERE program_id = ${program.id} AND email = ${e} LIMIT 1`).rows[0];
  if (used) return false;
  if (clientId) {
    const before = (await sql`SELECT 1 FROM program_enrollments WHERE program_id = ${program.id} AND client_id = ${clientId} LIMIT 1`).rows[0];
    if (before) return false;
  }
  return true;
}

// ── cohorts ──────────────────────────────────────────────────────────
// Owner input → columns. start_date is a calendar day in the business's
// timezone; starts_at is midnight of that day there.
export function cleanCohortInput(body, tz, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const n = String(body.name || '').trim().slice(0, 120);
    if (!n) return { error: 'Give the cohort a name.' };
    out.name = n;
  }
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
  if (!partial || body.startDate !== undefined) {
    if (!isDate(body.startDate)) return { error: 'Pick a start date.' };
    out.start_date = body.startDate;
    out.starts_at = new Date(zonedTimeToUtcMs(body.startDate, 0, tz)).toISOString();
  }
  if (!partial || body.enrollmentClosesOn !== undefined) {
    if (body.enrollmentClosesOn && !isDate(body.enrollmentClosesOn)) return { error: 'That enrollment close date is not valid.' };
    out.enrollment_closes_on = body.enrollmentClosesOn || null;
  }
  if (!partial || body.capacity !== undefined) {
    const c = body.capacity == null || body.capacity === '' ? null : Math.round(Number(body.capacity));
    if (c != null && (!Number.isFinite(c) || c < 1 || c > 100000)) return { error: 'Capacity must be 1 or more, or blank for no limit.' };
    out.capacity = c;
  }
  return { value: out };
}

const dateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));

export function serializeCohort(c, { members = 0, today = null } = {}) {
  const closes = dateStr(c.enrollment_closes_on) || dateStr(c.start_date);
  const full = c.capacity != null && members >= Number(c.capacity);
  const open = !full && (!today || today <= closes);
  return {
    id: c.id, name: c.name, startDate: dateStr(c.start_date), startsAt: c.starts_at,
    enrollmentClosesOn: dateStr(c.enrollment_closes_on), closesOn: closes,
    capacity: c.capacity == null ? null : Number(c.capacity), members, full, open,
    spotsLeft: c.capacity == null ? null : Math.max(0, Number(c.capacity) - members),
  };
}

// Cohorts of a program with how many active members each has.
export async function loadCohorts(programId, workspaceId) {
  return (await sql`
    SELECT c.id, c.program_id, c.workspace_id, c.name, c.starts_at, c.capacity, c.created_at,
           c.start_date::text AS start_date, c.enrollment_closes_on::text AS enrollment_closes_on,
           (SELECT COUNT(*)::int FROM program_enrollments e
                  WHERE e.cohort_id = c.id AND e.status IN ('active','past_due') AND (e.expires_at IS NULL OR e.expires_at > NOW())) AS members
      FROM program_cohorts c
     WHERE c.program_id = ${programId} AND c.workspace_id = ${workspaceId} AND c.deleted_at IS NULL
     ORDER BY c.starts_at ASC, c.created_at ASC`).rows;
}

// Cohorts a buyer can join today, soonest first.
export async function openCohorts(program, now = new Date()) {
  const tz = await workspaceTimezone(program.workspace_id);
  const today = todayISOInZone(tz, now);
  return (await loadCohorts(program.id, program.workspace_id))
    .map((c) => serializeCohort(c, { members: c.members, today }))
    .filter((c) => c.open);
}

// The cohort a new member goes into: the one they picked (if it is open)
// or the next open one. { cohort } or { error }.
export async function pickCohort(program, requestedId = null, now = new Date()) {
  const open = await openCohorts(program, now);
  if (!open.length) return { error: 'Enrollment is closed right now. Check back soon for the next start date.' };
  if (requestedId) {
    const c = open.find((x) => x.id === String(requestedId));
    if (!c) return { error: 'That start date is no longer open. Please pick another.' };
    return { cohort: c };
  }
  return { cohort: open[0] };
}

// ── bundles ──────────────────────────────────────────────────────────
// The package attached to a one-time program, if it is still one of the
// business's active packages.
export async function bundleFor(program) {
  if (!program || program.billing !== 'one_time' || !program.bundle_package_id || !program.bundle_mode) return null;
  const pkg = (await sql`SELECT id, name, description, session_count, price, expiry_days, service_ids, active FROM packages
                          WHERE id = ${program.bundle_package_id} AND workspace_id = ${program.workspace_id}`).rows[0];
  if (!pkg || pkg.active === false) return null;
  return { mode: program.bundle_mode, pkg };
}

export function serializeBundle(b) {
  if (!b) return null;
  return {
    mode: b.mode, packageId: b.pkg.id, name: b.pkg.name, description: b.pkg.description || '',
    sessions: Number(b.pkg.session_count) || 0, priceCents: Math.round(Number(b.pkg.price || 0) * 100),
    expiryDays: b.pkg.expiry_days == null ? null : Number(b.pkg.expiry_days),
  };
}

// Grants the package that came with a program purchase. Exactly once per
// checkout session (unique bundle_session_id). The row carries no payment
// ids of its own: the money is on the program purchase (price_cents = the
// whole checkout), so revenue never counts it twice and a refund of the
// purchase cancels it (revokeProgramPurchaseForRefund).
export async function grantBundlePackage({ workspaceId, clientId, packageId, sessionId, enrollmentId, priceCents = 0 }) {
  if (!packageId || !sessionId || !isUuid(packageId)) return { granted: false, reason: 'no package' };
  const pkg = (await sql`SELECT id, name, service_ids, session_count, expiry_days FROM packages WHERE id = ${packageId} AND workspace_id = ${workspaceId}`).rows[0];
  if (!pkg) return { granted: false, reason: 'package not found' };
  const credits = Math.max(1, Number(pkg.session_count) || 1);
  const expiresAt = pkg.expiry_days ? new Date(Date.now() + Number(pkg.expiry_days) * 86400_000).toISOString() : null;
  const r = await sql`
    INSERT INTO client_packages (workspace_id, client_id, package_id, name, service_ids, credits_total, credits_remaining, price, expires_at, status,
                                 program_enrollment_id, bundle_session_id)
    VALUES (${workspaceId}, ${clientId}, ${pkg.id}, ${pkg.name}, ${pkg.service_ids || []}, ${credits}, ${credits}, ${Math.max(0, priceCents) / 100}, ${expiresAt}, 'active',
            ${enrollmentId}, ${sessionId})
    ON CONFLICT (bundle_session_id) WHERE bundle_session_id IS NOT NULL DO NOTHING
    RETURNING id`;
  return { granted: r.rows.length > 0, name: pkg.name, credits };
}

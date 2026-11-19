// Fraud protection: card payment limits for a business Stripe has not
// finished verifying yet.
//
// The pattern this stops: a fake business connects Stripe with a stolen or
// made-up identity and pushes card payments through before Stripe's checks
// catch up. Until Stripe has what it asked for and has turned payouts on,
// a business's card payments are capped: how big one payment can be, how
// many it can start in 24 hours, and how much in total in 24 hours. The
// caps lift by themselves the moment Stripe verifies the account, and
// never come back for that business.
//
// Who is limited: only Stripe accounts Ivy created (Express) whose state
// is 'unverified' (finance_settings.stripe_identity_state). New accounts
// start there. Accounts that existed before this rule have no state until
// Stripe is asked about them (a webhook, the daily check, or "Check Stripe
// now"), so nobody is capped by a guess. PayPal, Square and a business's
// own Stripe keys are not affected.
//
// Enforced in one place for every Stripe call (stripeFetch in stripe.js)
// plus the two checkouts that talk to Stripe directly, so no payment path
// can skip it.
import { sql } from './db.js';
import { recordRiskEvent } from './riskHold.js';
import { notifyOwnerSafe } from './push.js';

export const LIMIT_CODE = 'new_business_limit';
export const DEFAULT_LIMITS = { enabled: true, maxPaymentCents: 50000, maxDailyCount: 10, maxDailyCents: 150000 };
// Hard bounds on what an admin can set (dollars are entered in the UI).
const BOUNDS = { maxPaymentCents: [100, 5000000], maxDailyCount: [1, 500], maxDailyCents: [100, 20000000] };

// What the person paying sees. It says nothing about why.
export const PAYER_MESSAGE = 'This business cannot take this payment online yet. Please contact them to arrange payment.';

export class NewBusinessLimitError extends Error {
  constructor(reason) {
    super(PAYER_MESSAGE);
    this.name = 'NewBusinessLimitError';
    this.code = LIMIT_CODE;
    this.status = 403;
    this.reason = reason;
  }
}

const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function cleanLimits(input, base = DEFAULT_LIMITS) {
  const out = { ...base };
  const src = input && typeof input === 'object' ? input : {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  for (const k of Object.keys(BOUNDS)) {
    if (src[k] == null || src[k] === '') continue;
    const n = Math.round(Number(src[k]));
    if (!Number.isFinite(n)) continue;
    out[k] = Math.max(BOUNDS[k][0], Math.min(BOUNDS[k][1], n));
  }
  return out;
}

let cache = null; // { at, value }
export function clearLimitsCache() { cache = null; }

export async function getLimits() {
  if (cache && Date.now() - cache.at < 30000 && process.env.IVY_DISABLE_HOTCACHE !== '1') return cache.value;
  let value = { ...DEFAULT_LIMITS };
  try {
    const { rows } = await sql`SELECT new_business_limits FROM app_settings WHERE id = 1`;
    if (rows[0]?.new_business_limits) value = cleanLimits(rows[0].new_business_limits);
  } catch { /* pre-migration: defaults */ }
  cache = { at: Date.now(), value };
  return value;
}

export async function setLimits(input) {
  const next = cleanLimits(input, await getLimits());
  await sql`UPDATE app_settings SET new_business_limits = ${JSON.stringify(next)}::jsonb WHERE id = 1`;
  clearLimitsCache();
  return next;
}

// In plain words, for the owner and the admin screen.
export function describeLimits(l) {
  return `up to ${money(l.maxPaymentCents)} per card payment, ${l.maxDailyCount} card payments in 24 hours, and ${money(l.maxDailyCents)} in total in 24 hours`;
}

// ── Has Stripe verified this account? ─────────────────────────────────
// "Verified" = Stripe has everything it has asked for so far and has
// turned both payments and payouts on.
export function isStripeVerified(summary) {
  return !!(summary && summary.chargesEnabled && summary.payoutsEnabled && !summary.disabledReason && Number(summary.requirementsDue || 0) === 0);
}

// Record what Stripe says. Once verified, always verified (Stripe asking
// an established business for a routine update never re-caps it).
//
// An account from before this rule (no state yet) is judged more gently
// the first time: if Stripe is paying it out and has not disabled it, it
// is an established business and counts as verified even with a routine
// request outstanding. A new account must have nothing outstanding.
export async function applyIdentityState({ workspaceId, summary }) {
  if (!workspaceId || !summary) return null;
  const strict = isStripeVerified(summary) ? 'verified' : 'unverified';
  const gentle = summary.chargesEnabled && summary.payoutsEnabled && !summary.disabledReason ? 'verified' : 'unverified';
  const { rows } = await sql`
    UPDATE finance_settings SET
      stripe_identity_state = CASE
        WHEN stripe_identity_state = 'verified' THEN 'verified'
        WHEN stripe_identity_state IS NULL THEN ${gentle}
        ELSE ${strict} END,
      stripe_verified_at = CASE
        WHEN stripe_verified_at IS NOT NULL THEN stripe_verified_at
        WHEN stripe_identity_state IS NULL AND ${gentle} = 'verified' THEN NOW()
        WHEN stripe_identity_state = 'unverified' AND ${strict} = 'verified' THEN NOW()
        ELSE NULL END
     WHERE workspace_id = ${workspaceId}
     RETURNING stripe_identity_state`;
  return rows[0]?.stripe_identity_state || null;
}

// ── The check ─────────────────────────────────────────────────────────
async function limitedWorkspace({ workspaceId, stripeAccount }) {
  const { rows } = workspaceId
    ? await sql`SELECT workspace_id, stripe_identity_state, stripe_connect_user_id FROM finance_settings WHERE workspace_id = ${workspaceId}`
    : await sql`SELECT workspace_id, stripe_identity_state, stripe_connect_user_id FROM finance_settings WHERE stripe_connect_user_id = ${stripeAccount} LIMIT 1`;
  const r = rows[0];
  if (!r || !r.stripe_connect_user_id || r.stripe_identity_state !== 'unverified') return null;
  return r.workspace_id;
}

async function usage(workspaceId) {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM((detail->>'amount_cents')::bigint), 0)::bigint AS cents
      FROM risk_events
     WHERE workspace_id = ${workspaceId} AND kind = 'limited_payment'
       AND created_at > NOW() - INTERVAL '24 hours'`;
  return { count: rows[0].n, cents: Number(rows[0].cents) };
}

// Would this payment be allowed? Never writes. { ok, limited, reason? }.
export async function previewNewBusinessPayment({ workspaceId = null, stripeAccount = null, amountCents = 0 }) {
  const limits = await getLimits();
  if (!limits.enabled) return { ok: true, limited: false };
  const ws = await limitedWorkspace({ workspaceId, stripeAccount });
  if (!ws) return { ok: true, limited: false };
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (amount > limits.maxPaymentCents) return { ok: false, limited: true, reason: 'size', workspaceId: ws, limits, amount };
  const used = await usage(ws);
  if (used.count + 1 > limits.maxDailyCount) return { ok: false, limited: true, reason: 'count', workspaceId: ws, limits, amount };
  if (used.cents + amount > limits.maxDailyCents) return { ok: false, limited: true, reason: 'total', workspaceId: ws, limits, amount };
  return { ok: true, limited: true, workspaceId: ws, limits, amount };
}

const REASON_WORDS = {
  size: (l) => `it was over ${money(l.maxPaymentCents)}`,
  count: (l) => `you have reached ${l.maxDailyCount} card payments in 24 hours`,
  total: (l) => `it would take you over ${money(l.maxDailyCents)} in 24 hours`,
};

// Check and record. Throws NewBusinessLimitError when the payment is not
// allowed (and tells the owner why, at most once an hour); otherwise
// counts the attempt toward the 24-hour limits.
export async function enforceNewBusinessPayment({ workspaceId = null, stripeAccount = null, amountCents = 0, kind = 'payment' }) {
  const v = await previewNewBusinessPayment({ workspaceId, stripeAccount, amountCents });
  if (!v.limited) return v;
  if (v.ok) {
    await recordRiskEvent(v.workspaceId, 'limited_payment', { amount_cents: v.amount, kind });
    return v;
  }
  await recordRiskEvent(v.workspaceId, 'limit_blocked', { amount_cents: v.amount, reason: v.reason, kind });
  try {
    const recent = await sql`
      SELECT COUNT(*)::int AS n FROM risk_events
       WHERE workspace_id = ${v.workspaceId} AND kind = 'limit_blocked' AND created_at > NOW() - INTERVAL '1 hour'`;
    if (recent.rows[0].n <= 1) {
      notifyOwnerSafe({
        workspaceId: v.workspaceId,
        type: 'payments',
        payload: {
          title: 'A card payment was not taken',
          body: `A ${money(v.amount)} card payment was stopped because ${REASON_WORDS[v.reason](v.limits)}. These limits lift as soon as Stripe finishes verifying your account. Open Money to finish.`,
          url: '/finance',
          tag: 'new-business-limit',
        },
      });
    }
  } catch { /* the notice is a courtesy */ }
  throw new NewBusinessLimitError(v.reason);
}

// ── Reading the amount out of a Stripe request ────────────────────────
// stripeFetch calls this for every POST. Returns the cents a call would
// move, or null when the call moves no money (set-up sessions, look-ups).
export function stripeCallAmount(path, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (path === '/payment_intents') {
    const n = Math.round(Number(b.amount));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (path === '/checkout/sessions') {
    if (b.mode === 'setup') return null;
    let total = 0;
    for (const [k, v] of Object.entries(b)) {
      const m = /^line_items\[(\d+)\]\[price_data\]\[unit_amount\]$/.exec(k);
      if (!m) continue;
      const qty = Math.max(1, Math.round(Number(b[`line_items[${m[1]}][quantity]`]) || 1));
      const unit = Math.round(Number(v));
      if (Number.isFinite(unit) && unit > 0) total += unit * qty;
    }
    // A subscription priced by a saved Stripe price has no amount here; it
    // still counts as one payment toward the daily number.
    return total;
  }
  return null;
}

// For the owner's Finance screen: are limits on for this business, and
// what are they?
export async function ownerLimitNotice(workspaceId) {
  const limits = await getLimits();
  if (!limits.enabled) return null;
  const ws = await limitedWorkspace({ workspaceId });
  if (!ws) return null;
  return {
    active: true,
    maxPaymentCents: limits.maxPaymentCents,
    maxDailyCount: limits.maxDailyCount,
    maxDailyCents: limits.maxDailyCents,
    text: `Until Stripe finishes verifying your account, you can take ${describeLimits(limits)}. The limits lift on their own once Stripe is done.`,
  };
}

// In a checkout's catch block: answer a limit refusal in the payer's
// words (403) and say it was handled.
export function answeredLimitRefusal(res, err) {
  if (!err || err.code !== LIMIT_CODE) return false;
  res.status(403).json({ error: PAYER_MESSAGE, code: LIMIT_CODE });
  return true;
}

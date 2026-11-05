// Guards that keep an owner from paying for Ivy twice, and from getting a
// second free trial.
//
//   checkoutBlock()            should a new web checkout be refused because
//                              the workspace already pays (Stripe or Apple)?
//   stripeBillingOnFile()      is the workspace billed through Stripe right
//                              now (the iPhone app must not sell it Apple)?
//   ensureIvyCustomer()        exactly one Stripe customer per workspace
//   classifyIncomingStripeSub() webhook / sync backstop: is this Stripe
//                              subscription the workspace's own, a stale
//                              event, or a second live subscription?
//   resolveExtraStripeSub()    what we do about a second subscription
//                              (see the comment on it for the rules)
//   hasUsedTrial() / recordTrialClaim*()
//                              one free trial per person, surviving account
//                              deletion (billing_trial_claims)
//
// Every write is scoped to one workspace id. Stripe calls carry idempotency
// keys so a retried webhook cannot cancel or create anything twice.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { normalizeAccountEmail } from './auth.js';
import { stripeFetch } from './stripe.js';
import { reportError } from './monitoring.js';

// Stripe subscription states that can still take money.
export const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due']);
// Workspace states that mean "a Stripe subscription is on file and may be
// running". 'suspended' is ours (dunning), the Stripe side can still be
// past_due and retrying.
const STRIPE_ON_FILE_STATUSES = new Set(['active', 'trialing', 'past_due', 'suspended']);
const APPLE_RUNNING_STATUSES = new Set(['active', 'trialing', 'past_due']);

export const APPLE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
export const MANAGE_BILLING_PATH = '/account#billing';

function periodRunning(ws, now) {
  const end = ws?.subscription_period_end ? new Date(ws.subscription_period_end).getTime() : null;
  return end == null || end > now;
}

// Apple (RevenueCat) is billing this workspace and the paid period has not
// ended. Auto-renew being off does not matter here: the period is paid for,
// so a web plan bought now would overlap it.
export function appleBillingRunning(ws, now = Date.now()) {
  return !!ws && ws.subscription_source === 'apple'
    && APPLE_RUNNING_STATUSES.has(ws.subscription_status)
    && periodRunning(ws, now);
}

// A Stripe subscription is on file and the workspace state says it may be
// running. DB only (no Stripe call), so it is cheap enough for the iPhone
// app's identify call on every launch.
export function stripeBillingOnFile(ws) {
  return !!ws && (ws.subscription_source || 'stripe') !== 'apple'
    && !!ws.stripe_subscription_id
    && STRIPE_ON_FILE_STATUSES.has(ws.subscription_status);
}

// The web plan on file is currently giving access (trial not over, period
// not ended, or past due and still being retried). A dunning-suspended
// workspace is not running: it may move to Apple, and the RevenueCat
// webhook then stops the leftover Stripe subscription.
export function stripePlanRunning(ws, now = Date.now()) {
  if (!stripeBillingOnFile(ws)) return false;
  const st = ws.subscription_status;
  if (st === 'past_due') return true;
  if (st === 'trialing') return !ws.trial_ends_at || new Date(ws.trial_ends_at).getTime() > now;
  if (st === 'active') return periodRunning(ws, now);
  return false;
}

// GET a subscription; null when Stripe says it does not exist.
export async function fetchSubscriptionOrNull(secretKey, subscriptionId, { expandInvoice = false } = {}) {
  if (!subscriptionId) return null;
  try {
    const q = expandInvoice ? '?expand[0]=latest_invoice' : '';
    return await stripeFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}${q}`, { secretKey });
  } catch (err) {
    if (err.status === 404 || err.stripeCode === 'resource_missing') return null;
    throw err;
  }
}

// ── Web checkout guard ──────────────────────────────────────────────

// Returns null when a new checkout may go ahead, otherwise
// { code, provider, message, manageUrl } explaining where the existing plan
// is managed. The Stripe branch confirms with Stripe before refusing, so a
// workspace whose webhook was missed (row still says active, Stripe says
// cancelled) is never locked out of paying again.
export async function checkoutBlock({ ws, secretKey, now = Date.now() }) {
  if (!ws) return null;
  if (appleBillingRunning(ws, now)) {
    return {
      code: 'billed_by_apple',
      provider: 'apple',
      manageUrl: APPLE_SUBSCRIPTIONS_URL,
      message: 'Your Ivy plan is billed through Apple, so there is nothing to pay here. To change or cancel it, open Settings on your iPhone, tap your name, then Subscriptions.',
    };
  }
  if (stripeBillingOnFile(ws)) {
    const live = await fetchSubscriptionOrNull(secretKey, ws.stripe_subscription_id);
    if (live && LIVE_STRIPE_STATUSES.has(live.status)) {
      let message = 'You already have an Ivy plan, so we did not start a second one. Open Manage billing to change or cancel it.';
      if (live.status === 'past_due') {
        message = 'Your Ivy plan is still open, but the last payment did not go through. Open Manage billing to update your card instead of starting a new plan.';
      } else if (live.cancel_at_period_end) {
        message = 'Your Ivy plan is set to end, but it is still yours. Open Manage billing to keep it going instead of starting a new plan.';
      }
      return { code: 'already_subscribed', provider: 'stripe', manageUrl: MANAGE_BILLING_PATH, message };
    }
    return null;
  }
  // Granted access with no Stripe object (admin "active" accounts, beta):
  // the original rule, kept.
  if (ws.subscription_status === 'active' && periodRunning(ws, now)) {
    return {
      code: 'already_subscribed',
      provider: 'ivy',
      manageUrl: MANAGE_BILLING_PATH,
      message: 'Your Ivy plan is already active, so there is nothing to pay right now.',
    };
  }
  return null;
}

// ── One Stripe customer per workspace ───────────────────────────────

// Returns the workspace's Stripe customer id, creating it once. Checkout
// used to pass only customer_email, which makes Stripe mint a fresh
// customer for every session; two checkouts before the first webhook landed
// meant two customers. The idempotency key collapses parallel creates into
// one customer, and the conditional UPDATE keeps whichever id was stored
// first.
export async function ensureIvyCustomer({ secretKey, workspaceId, email, name }) {
  const cur = await sql`SELECT stripe_customer_id FROM workspaces WHERE id = ${workspaceId}`;
  if (cur.rows[0]?.stripe_customer_id) return cur.rows[0].stripe_customer_id;
  const body = {
    'metadata[workspace_id]': workspaceId,
    'metadata[purpose]': 'ivy_subscription',
  };
  if (email) body.email = email;
  if (name) body.name = String(name).slice(0, 200);
  const customer = await stripeFetch('/customers', {
    method: 'POST', secretKey, body, idempotencyKey: `ivy-customer:${workspaceId}`,
  });
  const upd = await sql`
    UPDATE workspaces SET stripe_customer_id = ${customer.id}
     WHERE id = ${workspaceId} AND stripe_customer_id IS NULL
     RETURNING stripe_customer_id
  `;
  if (upd.rows[0]?.stripe_customer_id) return upd.rows[0].stripe_customer_id;
  const again = await sql`SELECT stripe_customer_id FROM workspaces WHERE id = ${workspaceId}`;
  return again.rows[0]?.stripe_customer_id || customer.id;
}

// ── Second-subscription backstop ────────────────────────────────────

export async function loadBillingRow(workspaceId) {
  if (!workspaceId) return null;
  const { rows } = await sql`
    SELECT id, owner_id, subscription_status, subscription_source, subscription_period_end,
           cancel_at_period_end, stripe_customer_id, stripe_subscription_id, trial_ends_at,
           trial_started_at, converted_at
      FROM workspaces WHERE id = ${workspaceId}
  `;
  return rows[0] || null;
}

// Decide what an incoming Stripe subscription (webhook or post-checkout
// sync) means for its workspace:
//   { action: 'track' }      it is the workspace's subscription (or the
//                            old one is gone): apply it as before
//   { action: 'ignore' }     an event for some other, already-dead
//                            subscription: must not overwrite the live one
//   { action: 'duplicate' }  a second live plan; resolveExtraStripeSub has
//                            dealt with it and the workspace is left alone
// viaCheckout: the event is a completed checkout (or its sync), the only
// thing that may move an Apple-billed workspace over to Stripe.
export async function classifyIncomingStripeSub({ ws, sub, secretKey, viaCheckout = false, now = Date.now() }) {
  if (!ws || !sub?.id) return { action: 'track' };
  if (ws.stripe_subscription_id === sub.id) return { action: 'track' };
  const incomingLive = LIVE_STRIPE_STATUSES.has(sub.status) || sub.status === 'incomplete';

  if (ws.subscription_source === 'apple') {
    // Paying Apple with auto-renew on, and a web plan just went through
    // too: that is double billing. Apple's charge cannot be undone from
    // here, so the web plan is the one to stop.
    if (viaCheckout && incomingLive && appleBillingRunning(ws, now) && !ws.cancel_at_period_end) {
      const conflict = await resolveExtraStripeSub({
        workspaceId: ws.id, kind: 'apple_and_stripe', keptRef: 'apple', extraSubId: sub.id, secretKey,
        note: 'A web plan was bought while the Apple subscription was still renewing.',
      });
      return { action: 'duplicate', conflict };
    }
    return { action: 'track' };
  }

  if (ws.stripe_subscription_id) {
    const tracked = await fetchSubscriptionOrNull(secretKey, ws.stripe_subscription_id);
    if (tracked && LIVE_STRIPE_STATUSES.has(tracked.status)) {
      if (!incomingLive) return { action: 'ignore', reason: 'other subscription is not live' };
      const conflict = await resolveExtraStripeSub({
        workspaceId: ws.id, kind: 'duplicate_stripe_subscription', keptRef: tracked.id, extraSubId: sub.id, secretKey,
        note: 'A second web plan started while the first was still running.',
      });
      return { action: 'duplicate', conflict };
    }
  }
  return { action: 'track' };
}

// Has this subscription actually collected money? Trials and incomplete
// first payments have not. Anything we cannot prove is unpaid counts as
// paid, which only ever makes the automatic action gentler.
async function subscriptionHasCharged(sub, secretKey) {
  if (!sub) return true;
  if (sub.status === 'trialing' || sub.status === 'incomplete') return false;
  let inv = sub.latest_invoice;
  if (inv && typeof inv === 'string') {
    inv = await stripeFetch(`/invoices/${encodeURIComponent(inv)}`, { secretKey }).catch(() => null);
  }
  if (!inv || typeof inv !== 'object') return true;
  return Number(inv.amount_paid || 0) > 0;
}

// What happens to a second subscription, decided once per subscription
// (billing_conflicts is unique on kind + extra_ref, so redelivered events
// and the sync endpoint cannot act twice):
//   - it has not taken any money yet (free trial, unfinished first
//     payment): cancel it immediately. Nothing to refund, the owner keeps
//     the plan they already had. action 'cancelled_unpaid', resolved.
//   - it has taken money: never refund automatically. Turn its renewal off
//     so it can never charge again, and raise it for a person to decide on
//     a refund. action 'cancel_at_period_end', open until it ends.
//   - Stripe refused either call: action 'flagged', open.
// Every case is logged to monitoring and, while open, sent by the hourly
// ops alert email.
export async function resolveExtraStripeSub({ workspaceId, kind, keptRef, extraSubId, secretKey, note }) {
  const claim = await sql`
    INSERT INTO billing_conflicts (workspace_id, kind, kept_ref, extra_ref, action, detail)
    VALUES (${workspaceId}, ${kind}, ${keptRef || null}, ${extraSubId}, 'pending', ${note || null})
    ON CONFLICT (kind, extra_ref) DO NOTHING
    RETURNING id
  `;
  if (claim.rows.length === 0) {
    const prev = await sql`SELECT id, action FROM billing_conflicts WHERE kind = ${kind} AND extra_ref = ${extraSubId}`;
    return { id: prev.rows[0]?.id || null, action: prev.rows[0]?.action || 'pending', repeated: true };
  }
  const conflictId = claim.rows[0].id;
  let action = 'flagged';
  let detail = note || '';
  try {
    const extra = await fetchSubscriptionOrNull(secretKey, extraSubId, { expandInvoice: true });
    if (!extra || (!LIVE_STRIPE_STATUSES.has(extra.status) && extra.status !== 'incomplete')) {
      action = 'already_ended';
    } else if (!(await subscriptionHasCharged(extra, secretKey))) {
      await stripeFetch(`/subscriptions/${encodeURIComponent(extraSubId)}`, {
        method: 'DELETE', secretKey, idempotencyKey: `ivy-dup-cancel:${extraSubId}`,
      });
      action = 'cancelled_unpaid';
    } else {
      await stripeFetch(`/subscriptions/${encodeURIComponent(extraSubId)}`, {
        method: 'POST', secretKey, body: { cancel_at_period_end: 'true' },
        idempotencyKey: `ivy-dup-stop:${extraSubId}`,
      });
      action = 'cancel_at_period_end';
      detail = `${detail} It had already taken a payment: renewal is off, check whether a refund is owed.`.trim();
    }
  } catch (err) {
    action = 'flagged';
    detail = `${detail} Could not stop it automatically (${String(err?.message || err).slice(0, 160)}). Cancel it in Stripe and check whether a refund is owed.`.trim();
  }
  const resolved = action === 'cancelled_unpaid' || action === 'already_ended';
  await sql`
    UPDATE billing_conflicts
       SET action = ${action}, detail = ${detail.slice(0, 1000)},
           resolved_at = CASE WHEN ${resolved} THEN NOW() ELSE NULL END
     WHERE id = ${conflictId}
  `;
  reportError(new Error(`Double billing caught (${kind}): ${action}`), {
    workspaceId,
    extra: { kind, keptRef, extraSubId, action },
  });
  return { id: conflictId, action };
}

// Daily sweep (billing-reconcile): any OTHER live subscription on the same
// Stripe customer is raised for a person to look at. Catches duplicates
// that predate the webhook check, or were made outside checkout (no
// workspace metadata). Nothing is cancelled from here: without the
// webhook's context we cannot be sure which plan the owner meant to keep.
// Returns how many new cases were raised.
export async function flagOtherLiveSubscriptions({ workspaceId, trackedSub, secretKey }) {
  const customer = typeof trackedSub?.customer === 'object' ? trackedSub.customer?.id : trackedSub?.customer;
  if (!customer || !LIVE_STRIPE_STATUSES.has(trackedSub.status)) return 0;
  const list = await stripeFetch(`/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`, { secretKey });
  let raised = 0;
  for (const other of list?.data || []) {
    if (!other?.id || other.id === trackedSub.id || !LIVE_STRIPE_STATUSES.has(other.status)) continue;
    if (other.cancel_at_period_end) continue; // already set to stop; nothing more will be charged
    const ins = await sql`
      INSERT INTO billing_conflicts (workspace_id, kind, kept_ref, extra_ref, action, detail)
      VALUES (${workspaceId}, 'duplicate_stripe_subscription', ${trackedSub.id}, ${other.id}, 'flagged',
              'Found by the daily billing check: this customer has another live subscription. Nothing was changed automatically.')
      ON CONFLICT (kind, extra_ref) DO NOTHING
      RETURNING id
    `;
    if (ins.rows.length) {
      raised++;
      reportError(new Error('Double billing found by the daily check'), {
        workspaceId, extra: { keptRef: trackedSub.id, extraSubId: other.id },
      });
    }
  }
  return raised;
}

// The extra subscription has ended (deleted / canceled event): close any
// open conflict about it so the ops alert resolves.
export async function closeConflictsForSubscription(subscriptionId) {
  if (!subscriptionId) return;
  await sql`
    UPDATE billing_conflicts SET resolved_at = NOW()
     WHERE resolved_at IS NULL AND extra_ref = ${subscriptionId}
  `.catch(() => {});
}

// ── One free trial per person ───────────────────────────────────────

// SHA-256 of the normalised address, with the "+deleted-<id>" mangle that
// account deletion applies taken back out, so deleting the account and
// signing up again with the same email finds the old claim. The schema
// backfill computes the same value in SQL. Gmail dots and +aliases are
// not folded (they are real, distinct addresses).
export function trialEmailKey(email) {
  const e = normalizeAccountEmail(email).replace(/\+deleted-[0-9a-f-]+@/, '@');
  if (!e || !e.includes('@')) return null;
  return crypto.createHash('sha256').update(e, 'utf8').digest('hex');
}

export async function hasUsedTrial(email) {
  const key = trialEmailKey(email);
  if (!key) return false;
  const { rows } = await sql`SELECT 1 FROM billing_trial_claims WHERE email_hash = ${key} LIMIT 1`;
  return rows.length > 0;
}

// Best-effort: never fails the billing event that calls it.
export async function recordTrialClaim({ email, workspaceId, source }) {
  const key = trialEmailKey(email);
  if (!key) return;
  await sql`
    INSERT INTO billing_trial_claims (email_hash, workspace_id, source)
    VALUES (${key}, ${workspaceId || null}, ${String(source || 'unknown').slice(0, 40)})
    ON CONFLICT (email_hash) DO NOTHING
  `.catch((e) => console.warn('[billingGuard] trial claim not recorded:', e.message));
}

export async function recordTrialClaimForWorkspace(workspaceId, source) {
  if (!workspaceId) return;
  try {
    const { rows } = await sql`
      SELECT u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${workspaceId}
    `;
    if (rows[0]?.email) await recordTrialClaim({ email: rows[0].email, workspaceId, source });
  } catch (e) {
    console.warn('[billingGuard] trial claim lookup failed:', e.message);
  }
}

// Helpers for membership tier templates + per-client subscription state.
import { sql } from './db.js';

export const VALID_INTERVAL = new Set(['week', 'month', 'quarter', 'year']);
export const VALID_STATUS = new Set(['active', 'past_due', 'cancelled', 'incomplete']);

export function serializeMembership(row) {
  if (!row) return null;
  return {
    id:           row.id,
    name:         row.name,
    description:  row.description || '',
    priceCents:   Number(row.price_cents || 0),
    interval:     row.interval,
    perks:        row.perks || [],
    active:       !!row.active,
    displayOrder: row.display_order || 0,
    // Stripe-readiness — UI shows a warning when a membership exists
    // without a connected Stripe price.
    stripeReady:  !!row.stripe_price_id,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

export function serializeClientMembership(row) {
  if (!row) return null;
  return {
    id:               row.id,
    clientId:         row.client_id,
    membershipId:     row.membership_id,
    membershipName:   row.membership_name,
    priceCents:       Number(row.price_cents || 0),
    interval:         row.interval,
    status:           row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    startedAt:        row.started_at,
    cancelledAt:      row.cancelled_at,
  };
}

export function cleanMembershipInput(body) {
  const out = {};
  const name = (body.name || '').toString().trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > 200) return { ok: false, error: 'name too long' };
  out.name = name;
  out.description = body.description ? String(body.description).slice(0, 4000) : null;

  const priceCents = Number.isInteger(body.priceCents)
    ? body.priceCents
    : Math.round(Number(body.priceCents || 0));
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 1_000_000_00) {
    return { ok: false, error: 'priceCents must be a non-negative integer' };
  }
  out.priceCents = priceCents;

  const interval = (body.interval || 'month').toString();
  if (!VALID_INTERVAL.has(interval)) return { ok: false, error: 'invalid interval' };
  out.interval = interval;

  out.perks = Array.isArray(body.perks)
    ? body.perks.map((p) => String(p).slice(0, 200)).filter(Boolean).slice(0, 20)
    : [];
  out.active = body.active !== false;
  out.displayOrder = Number.isInteger(body.displayOrder) ? body.displayOrder : 0;

  return { ok: true, sanitized: out };
}

// ─── Subscription state reconciliation (used by webhook handlers) ────
//
// Maps Stripe's subscription.status enum onto our compact set. Shared
// across the per-workspace webhook (legacy Standard OAuth) and the
// platform-level webhook (Account-Links) so they don't drift.
export function mapSubStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled') return 'cancelled';
  if (s === 'incomplete' || s === 'incomplete_expired') return 'incomplete';
  return 'active';
}

// Take a Stripe subscription object + the workspace_id it belongs to
// and reconcile client_memberships. Returns:
//   'ok'      — applied
//   'race'    — subscription row hasn't reached us yet (checkout-completed
//               flow will pick it up)
//   'mismatch'— cross-tenant event, dropped
//   'invalid' — no subscription id
export async function applySubscriptionState({ workspaceId, sub }) {
  const subId = sub?.id;
  if (!subId) return 'invalid';
  const ours = await sql`
    SELECT id, workspace_id FROM client_memberships
     WHERE stripe_subscription_id = ${subId}
     LIMIT 1
  `;
  if (ours.rows.length === 0) return 'race';
  if (ours.rows[0].workspace_id !== workspaceId) return 'mismatch';

  const status = mapSubStatus(sub.status);
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end;
  const cpeMs = sub.current_period_end ? sub.current_period_end * 1000 : null;
  const cancelledAt = (status === 'cancelled') ? new Date().toISOString() : null;
  await sql`
    UPDATE client_memberships SET
      status = ${status},
      cancel_at_period_end = ${cancelAtPeriodEnd},
      current_period_end = ${cpeMs ? new Date(cpeMs).toISOString() : null},
      cancelled_at = COALESCE(cancelled_at, ${cancelledAt}),
      updated_at = NOW()
    WHERE stripe_subscription_id = ${subId} AND workspace_id = ${workspaceId}
  `;
  return 'ok';
}

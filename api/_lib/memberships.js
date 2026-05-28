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
//   'ok'      — applied (update)
//   'created' — applied (insert) when checkout.session.completed hadn't
//               landed yet and the subscription event arrived first
//   'race'    — subscription row hasn't reached us AND the sub carries
//               insufficient metadata to upsert (checkout.session.completed
//               flow will pick it up if/when it arrives)
//   'mismatch'— cross-tenant event, dropped
//   'invalid' — no subscription id
//
// The upsert path closes a race: Stripe doesn't guarantee that
// checkout.session.completed lands before customer.subscription.created.
// When the sub arrives first we'd previously skip and the row would
// never materialize if the session event later failed to deliver,
// leaving a live Stripe subscription that THRYVE never tracked.
// `subscription_data.metadata` is stamped by createMembershipCheckoutSession
// with workspace_id/membership_id/client_id/purpose, giving us enough
// to safely materialize the row from the subscription event alone.
export async function applySubscriptionState({ workspaceId, sub }) {
  const subId = sub?.id;
  if (!subId) return 'invalid';
  const ours = await sql`
    SELECT id, workspace_id FROM client_memberships
     WHERE stripe_subscription_id = ${subId}
     LIMIT 1
  `;

  const status = mapSubStatus(sub.status);
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end;
  const cpeMs = sub.current_period_end ? sub.current_period_end * 1000 : null;
  const cpeIso = cpeMs ? new Date(cpeMs).toISOString() : null;
  const cancelledAt = (status === 'cancelled') ? new Date().toISOString() : null;

  if (ours.rows.length === 0) {
    // No row yet — try to materialize from subscription metadata.
    const md = sub.metadata || {};
    const mdWorkspaceId = md.workspace_id;
    const membershipId = md.membership_id;
    const clientId = md.client_id;
    if (md.purpose !== 'membership' || !membershipId || !clientId) {
      return 'race';
    }
    if (mdWorkspaceId && mdWorkspaceId !== workspaceId) return 'mismatch';

    // Validate both the tier and the client belong to this workspace
    // before insert. The FKs would prevent cross-tenant inserts anyway,
    // but failing loud here keeps the webhook response informative.
    const tier = (await sql`
      SELECT id, name, price_cents, interval FROM memberships
       WHERE id = ${membershipId} AND workspace_id = ${workspaceId}
    `).rows[0];
    if (!tier) return 'race';
    const client = (await sql`
      SELECT id FROM clients
       WHERE id = ${clientId} AND workspace_id = ${workspaceId}
    `).rows[0];
    if (!client) return 'race';

    // ON CONFLICT covers the case where checkout.session.completed
    // lands between the SELECT above and this INSERT — defense against
    // the same race we're fixing.
    await sql`
      INSERT INTO client_memberships (
        workspace_id, client_id, membership_id,
        membership_name, price_cents, interval,
        stripe_subscription_id, status,
        cancel_at_period_end, current_period_end, cancelled_at
      ) VALUES (
        ${workspaceId}, ${clientId}, ${tier.id},
        ${tier.name}, ${tier.price_cents}, ${tier.interval},
        ${subId}, ${status},
        ${cancelAtPeriodEnd}, ${cpeIso}, ${cancelledAt}
      )
      ON CONFLICT (stripe_subscription_id) DO UPDATE SET
        status = EXCLUDED.status,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        current_period_end = EXCLUDED.current_period_end,
        cancelled_at = COALESCE(client_memberships.cancelled_at, EXCLUDED.cancelled_at),
        updated_at = NOW()
    `;
    return 'created';
  }

  if (ours.rows[0].workspace_id !== workspaceId) return 'mismatch';

  await sql`
    UPDATE client_memberships SET
      status = ${status},
      cancel_at_period_end = ${cancelAtPeriodEnd},
      current_period_end = ${cpeIso},
      cancelled_at = COALESCE(cancelled_at, ${cancelledAt}),
      updated_at = NOW()
    WHERE stripe_subscription_id = ${subId} AND workspace_id = ${workspaceId}
  `;
  return 'ok';
}

// Helpers for membership tier templates + per-client subscription state.
import { sql } from './db.js';
import { fetchStripeCustomer } from './stripe.js';

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

// Pulls the active price id off a Stripe Subscription object. Modern
// API exposes it on items.data[0].price.id; the legacy plan.id is kept
// as a fallback for older event payloads. Returns null when neither
// is present (e.g. malformed event).
export function extractSubPriceId(sub) {
  const item = sub?.items?.data?.[0];
  const priceFromItems = item?.price?.id || (typeof item?.price === 'string' ? item.price : null);
  if (priceFromItems) return priceFromItems;
  const planId = sub?.plan?.id || (typeof sub?.plan === 'string' ? sub.plan : null);
  return planId || null;
}

// Take a Stripe subscription object + the workspace_id it belongs to
// and reconcile client_memberships. Returns:
//   'ok'        — applied (update)
//   'created'   — applied (insert) when checkout.session.completed hadn't
//                 landed yet and the subscription event arrived first
//   'retiered'  — update + tier resync (Stripe-side plan change)
//   'race'      — subscription row hasn't reached us AND the sub carries
//                 insufficient info to upsert (no Ivy OS metadata, and
//                 customer/price don't resolve to anything in this
//                 workspace either)
//   'mismatch'  — cross-tenant event, dropped
//   'invalid'   — no subscription id
//
// Two upsert paths close two races / gaps:
//
// (a) Stripe doesn't guarantee that checkout.session.completed lands
//     before customer.subscription.created. When the sub arrives first
//     and carries subscription_data.metadata stamped by
//     createMembershipCheckoutSession (workspace_id/membership_id/
//     client_id/purpose), we materialize the row from the sub event.
//
// (b) Subscriptions created from the Stripe Dashboard don't carry
//     Ivy OS metadata at all. If the sub's customer maps to a clients
//     row in this workspace AND the price maps to a memberships.
//     stripe_price_id, we still materialize — owners who set up
//     recurring billing through Stripe directly shouldn't have their
//     revenue disappear from Finance.
//
// Plan changes (UI or Stripe Dashboard) re-sync the tier snapshot
// (membership_id/name/price_cents/interval) when the active price
// id changes — 'retiered' is returned so the webhook can log it.
//
// stripeContext (optional): { secretKey, stripeAccount } passed by the
// webhook layer so the Dashboard-originated path can fetch a missing
// customer from Stripe and auto-provision a clients row. Omit it in
// pure-unit tests; tests that exercise the auto-provision branch
// pass it.
export async function applySubscriptionState({ workspaceId, sub, stripeContext }) {
  const subId = sub?.id;
  if (!subId) return 'invalid';
  const ours = await sql`
    SELECT id, workspace_id, membership_id FROM client_memberships
     WHERE stripe_subscription_id = ${subId}
     LIMIT 1
  `;

  const status = mapSubStatus(sub.status);
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end;
  const cpeMs = sub.current_period_end ? sub.current_period_end * 1000 : null;
  const cpeIso = cpeMs ? new Date(cpeMs).toISOString() : null;
  const cancelledAt = (status === 'cancelled') ? new Date().toISOString() : null;
  const priceId = extractSubPriceId(sub);
  const customerId = typeof sub?.customer === 'string'
    ? sub.customer
    : sub?.customer?.id || null;

  if (ours.rows.length === 0) {
    // Path (a): row materialized from subscription_data.metadata.
    const md = sub.metadata || {};
    const mdWorkspaceId = md.workspace_id;
    const membershipId = md.membership_id;
    const clientIdFromMd = md.client_id;
    const hasIvyMetadata = md.purpose === 'membership' && membershipId && clientIdFromMd;
    if (hasIvyMetadata) {
      if (mdWorkspaceId && mdWorkspaceId !== workspaceId) return 'mismatch';
      const tier = (await sql`
        SELECT id, name, price_cents, interval FROM memberships
         WHERE id = ${membershipId} AND workspace_id = ${workspaceId}
      `).rows[0];
      const client = tier ? (await sql`
        SELECT id FROM clients
         WHERE id = ${clientIdFromMd} AND workspace_id = ${workspaceId}
      `).rows[0] : null;
      if (tier && client) {
        await sql`
          INSERT INTO client_memberships (
            workspace_id, client_id, membership_id,
            membership_name, price_cents, interval,
            stripe_subscription_id, status,
            cancel_at_period_end, current_period_end, cancelled_at
          ) VALUES (
            ${workspaceId}, ${client.id}, ${tier.id},
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
    }

    // Path (b): Stripe-Dashboard-originated subscription with no Ivy OS
    // metadata. Match the customer to a clients row and the price to a
    // memberships tier — both must resolve unambiguously within this
    // workspace, otherwise we ignore. This is the same scope as case
    // (a) — we never insert across workspaces.
    if (!customerId || !priceId) return 'race';
    const tier = (await sql`
      SELECT id, name, price_cents, interval FROM memberships
       WHERE stripe_price_id = ${priceId} AND workspace_id = ${workspaceId}
       LIMIT 1
    `).rows[0];
    if (!tier) return 'race';

    let client = (await sql`
      SELECT id FROM clients
       WHERE stripe_customer_id = ${customerId} AND workspace_id = ${workspaceId}
       LIMIT 1
    `).rows[0];

    // Auto-provision: subscription created from Stripe Dashboard
    // against a customer Ivy OS has never seen. Fetch the customer
    // from Stripe to get email/name, then find-or-create a clients
    // row scoped to this workspace and link the Stripe customer id.
    // Requires stripeContext from the webhook (platform secret +
    // connected account id); if it's not supplied, fall back to
    // 'race' so the next event with context can resolve it.
    if (!client && stripeContext?.secretKey) {
      let cust;
      try {
        cust = await fetchStripeCustomer({
          secretKey: stripeContext.secretKey,
          stripeAccount: stripeContext.stripeAccount,
          customerId,
        });
      } catch {
        return 'race';
      }
      const email = (cust?.email || '').toString().toLowerCase().trim();
      if (!email) return 'race';
      // Match an existing client by email first (the owner may have
      // added the contact in Ivy OS before the Stripe-side subscription)
      // — that's a stronger link than always inserting a new row.
      const byEmail = (await sql`
        SELECT id FROM clients
         WHERE workspace_id = ${workspaceId} AND email = ${email}
         LIMIT 1
      `).rows[0];
      if (byEmail) {
        await sql`
          UPDATE clients SET stripe_customer_id = ${customerId}
           WHERE id = ${byEmail.id} AND workspace_id = ${workspaceId}
             AND stripe_customer_id IS NULL
        `;
        client = byEmail;
      } else {
        const ins = await sql`
          INSERT INTO clients (workspace_id, name, email, stage, source, stripe_customer_id)
          VALUES (${workspaceId}, ${cust.name || email}, ${email}, 'active', 'membership', ${customerId})
          RETURNING id
        `;
        client = ins.rows[0];
      }
    }
    if (!client) return 'race';

    await sql`
      INSERT INTO client_memberships (
        workspace_id, client_id, membership_id,
        membership_name, price_cents, interval,
        stripe_subscription_id, status,
        cancel_at_period_end, current_period_end, cancelled_at
      ) VALUES (
        ${workspaceId}, ${client.id}, ${tier.id},
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

  // Plan-change resync: if the active price id maps to a different
  // membership tier than the one currently stamped on this row, update
  // the snapshot fields too. Same workspace-scoped lookup as path (b).
  let retiered = false;
  if (priceId) {
    const newTier = (await sql`
      SELECT id, name, price_cents, interval FROM memberships
       WHERE stripe_price_id = ${priceId} AND workspace_id = ${workspaceId}
       LIMIT 1
    `).rows[0];
    if (newTier && newTier.id !== ours.rows[0].membership_id) {
      await sql`
        UPDATE client_memberships SET
          membership_id   = ${newTier.id},
          membership_name = ${newTier.name},
          price_cents     = ${newTier.price_cents},
          interval        = ${newTier.interval}
        WHERE stripe_subscription_id = ${subId} AND workspace_id = ${workspaceId}
      `;
      retiered = true;
    }
  }

  await sql`
    UPDATE client_memberships SET
      status = ${status},
      cancel_at_period_end = ${cancelAtPeriodEnd},
      current_period_end = ${cpeIso},
      cancelled_at = COALESCE(cancelled_at, ${cancelledAt}),
      updated_at = NOW()
    WHERE stripe_subscription_id = ${subId} AND workspace_id = ${workspaceId}
  `;
  return retiered ? 'retiered' : 'ok';
}

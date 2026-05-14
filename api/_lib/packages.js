// Shared helpers for the packages + client_packages tables.

export function serializePackage(row) {
  if (!row) return null;
  return {
    id:             row.id,
    name:           row.name,
    description:    row.description || '',
    serviceIds:     row.service_ids || [],
    sessionCount:   row.session_count,
    price:          Number(row.price || 0),
    expiryDays:     row.expiry_days,
    active:         !!row.active,
    visibility:     row.visibility || 'public',
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}

// Client-scoped package — what the client (and the booking flow) sees.
// Adds the friendly status label + days-until-expiry for the UI.
export function serializeClientPackage(row, opts = {}) {
  if (!row) return null;
  const expiresAt = row.expires_at;
  const daysToExpiry = expiresAt
    ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;
  return {
    id:                row.id,
    clientId:          opts.includeClientId ? row.client_id : undefined,
    packageId:         row.package_id,
    name:              row.name,
    serviceIds:        row.service_ids || [],
    creditsTotal:      row.credits_total,
    creditsRemaining:  row.credits_remaining,
    price:             Number(row.price || 0),
    invoiceId:         row.invoice_id,
    expiresAt,
    daysToExpiry,
    status:            row.status,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

// True if this package can absorb a booking for the given service. Used
// at booking time to validate that a credit consumption is allowed.
export function packageCoversService(cp, serviceId) {
  if (!cp || cp.status !== 'active' || cp.credits_remaining <= 0) return false;
  if (cp.expires_at && new Date(cp.expires_at).getTime() < Date.now()) return false;
  // Empty service_ids = covers every service in the workspace.
  if (!cp.service_ids || cp.service_ids.length === 0) return true;
  return cp.service_ids.includes(serviceId);
}

import { sql } from './db.js';

// Atomically decrement a credit. Returns:
//   { ok: true,  exhausted: bool, creditsRemaining: int }  on success
//   { ok: false }                                          when the
//     package isn't valid for the consumption — caller should refuse
//     the booking or fall back to standard pay-per-session billing.
//
// `exhausted` is true when this decrement was the one that flipped the
// status to 'exhausted'. Useful for triggering the "you're out of
// sessions" notification at exactly the right moment.
//
// All gating conditions live in the WHERE clause so two concurrent
// bookings can't double-spend the last credit. status flips to
// 'exhausted' in the same statement when remaining hits 0.
export async function consumeCredit({ workspaceId, clientPackageId, clientId, serviceId }) {
  const { rows } = await sql`
    UPDATE client_packages SET
      credits_remaining = credits_remaining - 1,
      status = CASE WHEN credits_remaining - 1 = 0 THEN 'exhausted' ELSE status END,
      updated_at = NOW()
    WHERE id = ${clientPackageId}
      AND workspace_id = ${workspaceId}
      AND client_id = ${clientId}
      AND status = 'active'
      AND credits_remaining > 0
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (cardinality(service_ids) = 0 OR ${serviceId}::uuid = ANY(service_ids))
    RETURNING id, credits_remaining, status
  `;
  if (rows.length === 0) return { ok: false };
  return {
    ok: true,
    exhausted: rows[0].status === 'exhausted',
    creditsRemaining: rows[0].credits_remaining,
  };
}

// Refund a credit when a booking that consumed one is cancelled. Best-
// effort: a missing / cancelled package is a no-op (the audit-trail
// link on the booking is enough).
export async function restoreCredit({ workspaceId, clientPackageId }) {
  if (!clientPackageId) return;
  await sql`
    UPDATE client_packages SET
      credits_remaining = LEAST(credits_remaining + 1, credits_total),
      status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END,
      updated_at = NOW()
    WHERE id = ${clientPackageId} AND workspace_id = ${workspaceId}
  `;
}

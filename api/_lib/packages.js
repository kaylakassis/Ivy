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

// Client-scoped package - what the client (and the booking flow) sees.
// Adds the friendly status label + days-until-expiry for the UI.
export function serializeClientPackage(row, opts = {}) {
  if (!row) return null;
  const expiresAt = row.expires_at;
  const daysToExpiry = expiresAt
    ? Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null;
  const state = packageState(row);
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
    // Refunds: cumulative cents sent back so far, and whether the bundle
    // was paid online (so it can be refunded from Ivy at all).
    refundedCents:     Number(row.refunded_cents || 0),
    paidOnline:        !!row.stripe_payment_intent,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
    // Added fields (older apps ignore them). `state` is the one word every
    // screen uses: active | used_up | expired | ended. `canBook` mirrors
    // the server-side gate in consumeCredit.
    state,
    canBook:           state === 'active',
    lastSession:       state === 'active' && Number(row.credits_remaining) === 1,
    anyService:        !row.service_ids || row.service_ids.length === 0,
    // The template this was bought from, when it can still be bought
    // online from the booking page ("Buy again"). Null otherwise.
    buyAgainPackageId: row.template_buyable ? (row.package_id || null) : null,
    // Counts for "3 left · 1 booked". creditsRemaining already excludes
    // booked sessions in both modes (a booking always holds its session,
    // so nobody can book more than they have). sessionsBooked = visits
    // booked with the package that haven't happened yet (or, for a
    // business that uses sessions on completion, haven't been marked
    // complete / no-show yet). Only sent when the query computed it.
    ...(Array.isArray(row.service_names) ? { serviceNames: row.service_names } : {}),
    ...(row.sessions_booked != null ? {
      sessionsBooked: Number(row.sessions_booked) || 0,
      sessionsUsed: Math.max(0, Number(row.credits_total) - Number(row.credits_remaining) - (Number(row.sessions_booked) || 0)),
    } : {}),
    ...(row.sessions_held != null ? { sessionsHeld: Number(row.sessions_held) || 0 } : {}),
  };
}

// SQL select-list fragment (fixed text, no input) counting the booked,
// not-yet-used sessions of client_packages aliased `cp`:
//   booking mode (or older bookings): upcoming, not cancelled, not done
//   completion mode: not cancelled, not completed, not a no-show
// Names of the services a package covers (empty = any service).
export const SERVICE_NAMES_SQL = `(
  SELECT COALESCE(array_agg(sv.name ORDER BY sv.name), '{}')
    FROM services sv
   WHERE sv.workspace_id = cp.workspace_id AND sv.id = ANY(cp.service_ids)
) AS service_names`;

export const SESSIONS_BOOKED_SQL = `(
  SELECT COUNT(*)::int FROM bookings bk
   WHERE bk.client_package_id = cp.id
     AND bk.workspace_id = cp.workspace_id
     AND bk.cancelled_at IS NULL
     AND bk.no_show_at IS NULL
     AND bk.completion_log = '{}'::jsonb
     AND (bk.package_use_mode = 'completion' OR bk.date >= CURRENT_DATE)
) AS sessions_booked`;

// Of those, the ones booked under "use sessions when completed" (held,
// count once the visit is marked complete).
export const SESSIONS_HELD_SQL = `(
  SELECT COUNT(*)::int FROM bookings bk
   WHERE bk.client_package_id = cp.id
     AND bk.workspace_id = cp.workspace_id
     AND bk.cancelled_at IS NULL
     AND bk.no_show_at IS NULL
     AND bk.completion_log = '{}'::jsonb
     AND bk.package_use_mode = 'completion'
) AS sessions_held`;

// The business's setting: when does a package session count as used?
// 'booking' (default) or 'completion'. Stamped onto each package booking
// so later setting changes never rewrite existing bookings.
export async function packageUseModeFor(workspaceId) {
  try {
    const { rows } = await sql`SELECT package_use_on FROM calendar_settings WHERE workspace_id = ${workspaceId}`;
    return rows[0]?.package_use_on === 'completion' ? 'completion' : 'booking';
  } catch {
    return 'booking';
  }
}

// Has the session of this (package) booking been used? Booking mode: as
// soon as it was booked. Completion mode: once the visit was marked
// complete or a no-show. Used to decide whether a cancel gives it back.
export function bookingSessionUsed(booking) {
  if (!booking?.client_package_id) return false;
  if (booking.package_use_mode !== 'completion') return true;
  const log = booking.completion_log && typeof booking.completion_log === 'object' ? booking.completion_log : {};
  return !!booking.no_show_at || Object.keys(log).length > 0;
}

// The one-word state of a client package, derived from status, the
// remaining count and the expiry date (status is never flipped to
// 'expired' by a job, so the date is the source of truth).
//   ended    cancelled or refunded by the business
//   used_up  no sessions left
//   expired  past its use-by date
//   active   can be booked
export function packageState(row, now = Date.now()) {
  if (!row) return 'ended';
  if (row.status === 'cancelled') return 'ended';
  if (Number(row.credits_remaining) <= 0 || row.status === 'exhausted') return 'used_up';
  if (row.status === 'expired') return 'expired';
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

// Why a package cannot pay for a booking of `serviceId`, as a stable code
// the apps can branch on, or null when it can. Order matters: a used-up
// package says "used up" even if it also expired.
// Pass { checkService: false } to check only used up / expired / ended.
export function packageBlockCode(cp, serviceId, { checkService = true } = {}) {
  const state = packageState(cp);
  if (state === 'ended') return 'package_inactive';
  if (state === 'used_up') return 'package_used_up';
  if (state === 'expired') return 'package_expired';
  if (!checkService) return null;
  const scoped = cp.service_ids || [];
  if (scoped.length > 0 && !scoped.includes(serviceId)) return 'package_service_not_covered';
  return null;
}

// What the client reads for each refusal. Plain, short, no dashes.
const CLIENT_COPY = {
  package_used_up: "You've used all your sessions. Buy this package again or see other services.",
  package_expired: 'This package has expired. Buy it again or see other services.',
  package_inactive: 'This package is no longer active. See other services or message the business.',
  package_service_not_covered: "This package doesn't cover that service. Pick a service it covers, or book and pay as usual.",
  package_not_found: 'Package not found.',
  package_recurring_unsupported: 'A package session covers one visit. Book each visit on its own.',
};
// What the owner reads (they book on the client's behalf).
const OWNER_COPY = {
  package_used_up: 'This package is used up (0 sessions left). Offer the client a new one from their client page, or book without the package.',
  package_expired: 'This package has expired. Offer the client a new one from their client page, or book without the package.',
  package_inactive: 'This package was cancelled. Book without the package, or offer a new one.',
  package_service_not_covered: "This package doesn't cover that service. Pick a service it covers, or book without the package.",
  package_not_found: "That package doesn't belong to this client.",
  package_recurring_unsupported: 'A package session covers one visit, so it cannot pay for a repeating booking. Turn off Repeats, or book each visit on its own.',
};
export function packageErrorMessage(code, audience = 'client') {
  const copy = audience === 'owner' ? OWNER_COPY : CLIENT_COPY;
  return copy[code] || copy.package_inactive;
}

// Everything a screen needs to offer "Buy again" / "See all services"
// after a refusal: whether the original template can still be bought
// online, and the business's booking page handle.
export async function loadRepurchase({ workspaceId, packageId }) {
  const out = { packageId: null, bookingSlug: null, bookingUrl: null, buyAgainUrl: null };
  try {
    const { rows } = await sql`
      SELECT cs.slug,
             p.id AS template_id,
             (p.active AND p.visibility = 'public' AND p.price > 0) AS buyable
        FROM calendar_settings cs
        LEFT JOIN packages p ON p.id = ${packageId || null}::uuid AND p.workspace_id = cs.workspace_id
       WHERE cs.workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return out;
    out.bookingSlug = r.slug || null;
    if (r.slug) out.bookingUrl = `/book/${encodeURIComponent(r.slug)}`;
    if (r.buyable && r.template_id && r.slug) {
      out.packageId = r.template_id;
      out.buyAgainUrl = `/book/${encodeURIComponent(r.slug)}?buy=${encodeURIComponent(r.template_id)}`;
    }
  } catch { /* the refusal still goes out without the links */ }
  return out;
}

// Send a package refusal: the existing `error` string (old apps show it)
// plus a stable `code`, the package's live counts, and repurchase links.
export async function sendPackageRefusal(res, { code, cp, audience = 'client', status = 400 }) {
  const body = { error: packageErrorMessage(code, audience), code };
  if (cp) {
    body.package = {
      id: cp.id,
      name: cp.name,
      creditsRemaining: Number(cp.credits_remaining),
      creditsTotal: Number(cp.credits_total),
      state: packageState(cp),
    };
    if (code !== 'package_not_found') {
      body.repurchase = await loadRepurchase({ workspaceId: cp.workspace_id, packageId: cp.package_id });
    }
  }
  return res.status(status).json(body);
}

// Re-read a package after a refused atomic decrement, so the refusal
// names the real reason (most often: someone else just took the last one).
export async function refusalForFailedConsume(res, { workspaceId, clientPackageId, clientId, serviceId, audience }) {
  const { rows } = await sql`
    SELECT * FROM client_packages
     WHERE id = ${clientPackageId} AND workspace_id = ${workspaceId}
  `;
  const cp = rows[0];
  if (!cp || (clientId && cp.client_id !== clientId)) {
    return sendPackageRefusal(res, { code: 'package_not_found', cp: null, audience });
  }
  const code = packageBlockCode(cp, serviceId) || 'package_used_up';
  return sendPackageRefusal(res, { code, cp, audience });
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
//     package isn't valid for the consumption - caller should refuse
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

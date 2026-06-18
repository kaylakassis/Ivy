// POST /api/me/packages/:id/book
//
// Client-portal endpoint: spends N credits from this package on N new
// bookings in one atomic transaction. Two body shapes supported:
//
// Recurring (single weekday or monthly cadence):
//   { serviceId, recurrence: 'weekly'|'biweekly'|'monthly',
//     firstDate, startMin, endMin, occurrences }
//
// One-off (N independent dates):
//   { serviceId, slots: [{ date, startMin, endMin }, ...] }
//
// Each slot is validated independently against:
//   • availability (workspace general + service-specific override)
//   • conflict with existing bookings/blocks (with buffer)
//   • workspace min-notice + max-advance settings
//   • workspace timezone (so notice/horizon math matches what the
//     visitor sees in the slot grid)
//
// Credit consumption is upfront - all N at once, or none. A later
// cancellation refunds 1 credit per occurrence (existing restoreCredit
// path on api/me/bookings/[id].js).
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { readBody } from '../../../_lib/body.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { myClientIds, ids } from '../../../_lib/clientPortal.js';
import {
  hasConflict, withinAvailability, slotEpochMs, serializeBooking,
} from '../../../_lib/calendar.js';
import { packageCoversService } from '../../../_lib/packages.js';
import { notifyNewBooking } from '../../../_lib/bookingNotify.js';
import { notifyPackageExhausted } from '../../../_lib/packageNotify.js';
import { syncOnBookingCreated } from '../../../_lib/googleSync.js';
import { attachIntakeForms } from '../../../_lib/intake.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

const MAX_OCCURRENCES = 52;          // hard ceiling regardless of credits
const VALID_RECURRENCE = new Set(['weekly', 'biweekly', 'monthly']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const cpId = req.query.id;
    if (!cpId) return badRequest(res, 'Package id required');

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'No packages on your account');

    // Verify the package belongs to one of this user's client memberships.
    const { rows: pkgRows } = await sql.query(
      `SELECT cp.*, c.name AS client_name, c.email AS client_email
         FROM client_packages cp
         JOIN clients c ON c.id = cp.client_id
        WHERE cp.id = $1 AND cp.client_id = ANY($2)`,
      [cpId, myIds],
    );
    if (pkgRows.length === 0) return notFound(res, 'Package not found');
    const cp = pkgRows[0];
    if (cp.status !== 'active') return badRequest(res, 'This package is no longer active.');
    if (cp.credits_remaining <= 0) return badRequest(res, "You're out of credits on this package.");
    if (cp.expires_at && new Date(cp.expires_at).getTime() < Date.now()) {
      return badRequest(res, 'This package has expired.');
    }

    const body = await readBody(req);
    const serviceId = String(body.serviceId || '');
    if (!serviceId) return badRequest(res, 'Pick a service.');

    if (!packageCoversService(
      { status: cp.status, credits_remaining: cp.credits_remaining,
        expires_at: cp.expires_at, service_ids: cp.service_ids },
      serviceId,
    )) {
      return badRequest(res, "This package doesn't cover that service.");
    }

    // Expand the body into a slot list. Either branch must produce a
    // [{date, startMin, endMin}, ...] array.
    let slots = [];
    if (body.recurrence) {
      const recurrence = String(body.recurrence);
      if (!VALID_RECURRENCE.has(recurrence)) return badRequest(res, 'Invalid recurrence.');
      const firstDate = String(body.firstDate || '');
      const startMin = Number(body.startMin);
      const endMin = Number(body.endMin);
      const occurrences = Math.floor(Number(body.occurrences || 0));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate)) return badRequest(res, 'firstDate is required (YYYY-MM-DD).');
      if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1440) return badRequest(res, 'startMin invalid.');
      if (!Number.isInteger(endMin) || endMin <= startMin || endMin > 1440) return badRequest(res, 'endMin invalid.');
      if (!Number.isInteger(occurrences) || occurrences < 1) return badRequest(res, 'occurrences must be 1+.');
      if (occurrences > MAX_OCCURRENCES) return badRequest(res, `Too many occurrences (max ${MAX_OCCURRENCES}).`);
      const dates = expandRecurrence(firstDate, recurrence, occurrences);
      slots = dates.map((date) => ({ date, startMin, endMin }));
    } else if (Array.isArray(body.slots) && body.slots.length > 0) {
      if (body.slots.length > MAX_OCCURRENCES) return badRequest(res, `Too many slots (max ${MAX_OCCURRENCES}).`);
      for (const raw of body.slots) {
        const date = String(raw?.date || '');
        const startMin = Number(raw?.startMin);
        const endMin = Number(raw?.endMin);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'Each slot needs date YYYY-MM-DD.');
        if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1440) return badRequest(res, 'Each slot needs startMin 0–1440.');
        if (!Number.isInteger(endMin) || endMin <= startMin || endMin > 1440) return badRequest(res, 'Each slot needs endMin > startMin.');
        slots.push({ date, startMin, endMin });
      }
      // Detect intra-request duplicates (same date+start) - they'd
      // both try to insert against the same conflict-window.
      const seen = new Set();
      for (const s of slots) {
        const key = `${s.date}|${s.startMin}`;
        if (seen.has(key)) return badRequest(res, 'Duplicate slots in your selection.');
        seen.add(key);
      }
    } else {
      return badRequest(res, 'Send either a recurrence or a slots array.');
    }

    if (slots.length > cp.credits_remaining) {
      return badRequest(res, `You only have ${cp.credits_remaining} credit${cp.credits_remaining === 1 ? '' : 's'} left on this package.`);
    }

    // Load workspace settings + service shape.
    const cs = await sql`
      SELECT availability, min_notice_hours, max_advance_days, buffer_minutes, timezone
        FROM calendar_settings
       WHERE workspace_id = ${cp.workspace_id}
    `;
    const settings = cs.rows[0] || {};
    const availability = settings.availability || {};
    const minNoticeHours = Math.max(0, Number(settings.min_notice_hours ?? 24));
    const maxAdvanceDays = Math.max(0, Number(settings.max_advance_days ?? 60));
    const bufferMinutes  = Math.max(0, Number(settings.buffer_minutes ?? 0));
    const tz = settings.timezone || null;

    const sv = await sql`
      SELECT capacity, availability, name, travel_buffer_minutes FROM services
       WHERE id = ${serviceId} AND workspace_id = ${cp.workspace_id}
    `;
    if (sv.rows.length === 0) return badRequest(res, "That service isn't offered anymore.");
    const capacity = Math.max(1, Number(sv.rows[0].capacity) || 1);
    const serviceAvail = sv.rows[0].availability || null;
    const travelBuffer = Math.max(0, Number(sv.rows[0].travel_buffer_minutes ?? 0));

    // Validate every slot before consuming credits - atomic all-or-nothing.
    const now = Date.now();
    for (const s of slots) {
      const weekday = new Date(s.date + 'T00:00:00Z').getUTCDay();
      if (!withinAvailability(availability, weekday, s.startMin, s.endMin, serviceAvail)) {
        return badRequest(res, `${s.date} ${fmtMin(s.startMin)}: outside this service's hours.`);
      }
      const slotMs = slotEpochMs(s.date, s.startMin, tz);
      if (slotMs < now - 60_000) {
        return badRequest(res, `${s.date} ${fmtMin(s.startMin)}: that time has passed.`);
      }
      if (slotMs < now + minNoticeHours * 3_600_000) {
        const lbl = minNoticeHours % 24 === 0 ? `${minNoticeHours / 24}d` : `${minNoticeHours}h`;
        return badRequest(res, `${s.date} ${fmtMin(s.startMin)}: less than ${lbl} from now.`);
      }
      if (maxAdvanceDays > 0 && slotMs > now + (maxAdvanceDays + 1) * 86_400_000) {
        return badRequest(res, `${s.date} ${fmtMin(s.startMin)}: further out than this business allows.`);
      }
      // eslint-disable-next-line no-await-in-loop
      const conflict = await hasConflict({
        workspaceId: cp.workspace_id,
        dateISO: s.date, start: s.startMin, end: s.endMin,
        serviceId, capacity,
        travelBufferMin: travelBuffer, bufferMin: bufferMinutes,
      });
      if (conflict) {
        return badRequest(res, `${s.date} ${fmtMin(s.startMin)}: that slot is taken.`);
      }
    }

    // Atomically debit N credits. All-or-nothing - gating in the WHERE
    // clause means a concurrent booking flow that took the last credit
    // wins, and we refuse cleanly.
    const debit = await sql`
      UPDATE client_packages SET
        credits_remaining = credits_remaining - ${slots.length},
        status = CASE WHEN credits_remaining - ${slots.length} = 0 THEN 'exhausted' ELSE status END,
        updated_at = NOW()
       WHERE id = ${cpId}
         AND status = 'active'
         AND credits_remaining >= ${slots.length}
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (cardinality(service_ids) = 0 OR ${serviceId}::uuid = ANY(service_ids))
      RETURNING credits_remaining, status
    `;
    if (debit.rows.length === 0) {
      return badRequest(res, 'Could not consume credits - try refreshing your packages.');
    }

    // Insert the bookings. Each gets client_package_id so a future
    // cancellation can restoreCredit() against this package.
    //
    // Rollback contract: if any insert throws (transient DB error, a
    // late race against a concurrent booker that took the slot between
    // our hasConflict() check and INSERT), we DELETE the rows we already
    // wrote and REFUND the full N credits we debited. The endpoint stays
    // "all-or-nothing" from the client's perspective.
    const inserted = [];
    const insertedIds = [];
    try {
      for (const s of slots) {
        // eslint-disable-next-line no-await-in-loop
        const r = await sql`
          INSERT INTO bookings (
            workspace_id, service_id, client_id, client_name, client_email,
            date, start_min, end_min, client_package_id
          ) VALUES (
            ${cp.workspace_id}, ${serviceId}, ${cp.client_id},
            ${cp.client_name}, ${cp.client_email},
            ${s.date}, ${s.startMin}, ${s.endMin}, ${cpId}
          )
          RETURNING *
        `;
        inserted.push(serializeBooking(r.rows[0]));
        insertedIds.push(r.rows[0].id);
      }
    } catch (insertErr) {
      // Best-effort rollback. We swallow rollback errors because we want
      // the original cause to surface, not a secondary cleanup error.
      try {
        if (insertedIds.length > 0) {
          await sql`DELETE FROM bookings WHERE id = ANY(${insertedIds}::uuid[])`;
        }
        await sql`
          UPDATE client_packages SET
            credits_remaining = LEAST(credits_remaining + ${slots.length}, credits_total),
            status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END,
            updated_at = NOW()
           WHERE id = ${cpId}
        `;
      } catch (rollbackErr) {
        // eslint-disable-next-line no-console
        console.error('[packages/book] rollback failed:', rollbackErr.message);
      }
      throw insertErr;
    }

    // Post-insert side-effects - match the public booking endpoint so
    // package-credit bookings aren't silent in the rest of the system.
    // All fire-and-forget; per-booking failures get logged and surface
    // separately from the 200 OK to the client. This is the same pattern
    // api/calendar/public/[slug].js uses.
    for (const b of inserted) {
      notifyNewBooking({ workspaceId: cp.workspace_id, bookingId: b.id, source: 'client-portal' })
        .catch((e) => console.error('[packages/book] notifyNewBooking failed:', e?.message));
      syncOnBookingCreated({ workspaceId: cp.workspace_id, bookingId: b.id })
        .catch((e) => console.error('[packages/book] syncOnBookingCreated failed:', e?.message));
      attachIntakeForms({ workspaceId: cp.workspace_id, bookingId: b.id })
        .catch((e) => console.error('[packages/book] attachIntakeForms failed:', e?.message));
    }
    // Owner gets the "client just ran out of credits" nudge exactly
    // when the debit flipped the status to exhausted (the same moment
    // /api/calendar/bookings fires it).
    if (debit.rows[0].status === 'exhausted') {
      notifyPackageExhausted({
        workspaceId: cp.workspace_id,
        clientPackageId: cpId,
        clientId: cp.client_id,
      }).catch((e) => console.error('[packages/book] notifyPackageExhausted failed:', e?.message));
    }

    return ok(res, {
      bookings: inserted,
      creditsRemaining: debit.rows[0].credits_remaining,
      status: debit.rows[0].status,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// Expand a recurrence rule from a first ISO date into N ISO dates.
// Uses UTC arithmetic - the wall-clock TIME is constant across
// occurrences, only the DATE changes, so DST shifts don't matter for
// the date math itself.
//
// Monthly stepping anchors on the ORIGINAL day-of-month and clamps to
// the target month's last day when shorter. This matches Outlook /
// Google Calendar behavior. The naive `setUTCMonth(+1)` would silently
// roll Jan 31 → "Feb 31" → March 3, skipping February entirely and
// drifting subsequent dates off the user's chosen day-of-month.
function expandRecurrence(firstDateISO, rule, n) {
  const out = [];
  const [y, mo, d] = firstDateISO.split('-').map(Number);
  if (rule === 'monthly') {
    for (let i = 0; i < n; i++) {
      const targetMonth = (mo - 1) + i;
      const yyyy = y + Math.floor(targetMonth / 12);
      const mm   = ((targetMonth % 12) + 12) % 12;
      // Date.UTC(yyyy, mm + 1, 0) gives the last day of month mm.
      const lastDay = new Date(Date.UTC(yyyy, mm + 1, 0)).getUTCDate();
      const day = Math.min(d, lastDay);
      out.push(new Date(Date.UTC(yyyy, mm, day)).toISOString().slice(0, 10));
    }
    return out;
  }
  const cursor = new Date(Date.UTC(y, mo - 1, d));
  const step = rule === 'weekly' ? 7 : 14; // 'biweekly'
  for (let i = 0; i < n; i++) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + step);
  }
  return out;
}

function fmtMin(m) {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${mm}${ap}`;
}

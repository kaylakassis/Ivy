// Shared calendar helpers: slot computation, availability check, format helpers.
// Used by both the owner-side API (validate booking before insert) and frontend.
import { sql } from './db.js';

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const VALID_HANDLE = HANDLE_RE;

export function ensureCalendarSettings(workspaceId) {
  // Create default settings row if one doesn't exist; return the row.
  return sql`
    INSERT INTO calendar_settings (workspace_id) VALUES (${workspaceId})
    ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING *
  `.then((r) => r.rows[0]);
}

export function serializeSettings(row) {
  if (!row) return null;
  return {
    bizName:        row.biz_name,
    slug:           row.slug,
    slotMinutes:    row.slot_minutes,
    bufferMinutes:  row.buffer_minutes,
    minNoticeHours: row.min_notice_hours == null ? 24 : Number(row.min_notice_hours),
    availability:   row.availability || {},
    discoverable:   !!row.discoverable,
    tagline:        row.tagline || '',
    category:       row.category || null,
    addressLabel:   row.address_label || '',
    lat:            row.lat == null ? null : Number(row.lat),
    lng:            row.lng == null ? null : Number(row.lng),
    updatedAt:      row.updated_at,
  };
}

// Categories for Discover. Owners pick one (or none). The set MUST stay
// in sync with src/lib/categories.js on the client — the server-side
// list gates which values can be saved on a workspace.
export const DISCOVER_CATEGORIES = [
  'Wellness', 'Beauty', 'Fitness', 'Health',
  'Home', 'Pet', 'Creative', 'Education', 'Events',
  'Professional', 'Other',
];
export const DISCOVER_CATEGORY_SET = new Set(DISCOVER_CATEGORIES);

export function serializeService(row) {
  if (!row) return null;
  return {
    id:                row.id,
    name:              row.name,
    durationMinutes:   row.duration_minutes,
    price:             Number(row.price || 0),
    displayOrder:      row.display_order,
    description:       row.description || '',
    photoUrl:          row.photo_url || '',
    prepInstructions:  row.prep_instructions || '',
    reminderMinutes:   row.reminder_minutes || DEFAULT_REMINDERS.slice(),
    capacity:          row.capacity || 1,
    intakeFormTemplateIds: row.intake_form_template_ids || [],
    depositType:       row.deposit_type || 'none',
    depositAmount:     Number(row.deposit_amount || 0),
    locationType:      row.location_type || 'in_person',
    locationLabel:     row.location_label || '',
    visibility:        row.visibility || 'public',
    travelBufferMinutes: row.travel_buffer_minutes || 0,
    // Per-service color the owner picked in ServicesDrawer for
    // calendar legibility. Null → renderer falls back to accent.
    color:             row.color || null,
    cancellationFeeAmount:  Number(row.cancellation_fee_amount || 0),
    cancellationWindowHours: Number.isInteger(row.cancellation_window_hours)
      ? row.cancellation_window_hours : 24,
    noShowFeeAmount:   Number(row.no_show_fee_amount || 0),
    customFields:      row.custom_fields || [],
    addOns:            row.add_ons || [],
  };
}

// Compute the deposit owed for a booking against this service. Accepts
// either a serialized service (camelCase) or a raw row (snake_case).
// Always returns a non-negative 2dp number.
export function depositFor(service, totalPrice) {
  if (!service) return 0;
  const type = service.deposit_type || service.depositType || 'none';
  const amt  = Number(service.deposit_amount ?? service.depositAmount ?? 0);
  const price = Number(totalPrice ?? service.price ?? 0);
  if (!price || type === 'none') return 0;
  if (type === 'percent') {
    const pct = Math.min(100, Math.max(0, amt));
    return Math.round(price * pct) / 100;
  }
  if (type === 'fixed') {
    return Math.min(price, Math.max(0, Math.round(amt * 100) / 100));
  }
  if (type === 'full') {
    return Math.round(price * 100) / 100;
  }
  return 0;
}

// Default reminder schedule in minutes-before-appointment.
// 10080 = 7 days, 2880 = 2 days, 1440 = 1 day, 120 = 2 hours.
export const DEFAULT_REMINDERS = [10080, 2880, 1440, 120];

// Two serializer modes:
//   • owner   (default): full fidelity. Label, notes, color, the
//                        whole event payload.
//   • public  (opts.publicView=true): redacted. Date + window only.
//             Label is always 'Busy', notes/color stripped. Used by
//             the public booking slot picker so personal events
//             never leak ("Doctor visit 2pm" → "Busy 2-3pm").
export function serializeBlock(row, opts = {}) {
  if (!row) return null;
  const publicView = !!opts.publicView;
  const base = {
    id:        row.id,
    date:      row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    startMin:  row.start_min,
    endMin:    row.end_min,
  };
  if (publicView) {
    // Never echo the owner's chosen label, notes, color, or
    // blocks_bookings flag. The public widget gets "Busy".
    return { ...base, label: 'Busy' };
  }
  return {
    ...base,
    label:          row.label,
    blocksBookings: row.blocks_bookings !== false,  // legacy rows: undefined → TRUE
    color:          row.color || null,
    notes:          row.notes || null,
    allDay:         !!row.all_day,
  };
}

export function serializeBooking(row, opts = {}) {
  if (!row) return null;
  const { redactClient = false } = opts;
  const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date;
  const cancelledOccurrences = (row.cancelled_occurrences || []).map((d) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : d,
  );
  return {
    id:                  row.id,
    serviceId:           row.service_id,
    clientId:            row.client_id,
    clientName:          redactClient ? null : row.client_name,
    clientEmail:         redactClient ? null : row.client_email,
    date:                dateStr,
    startMin:            row.start_min,
    endMin:              row.end_min,
    notes:               redactClient ? null : row.notes,
    cancelledAt:         row.cancelled_at,
    recurrenceRule:      row.recurrence_rule || null,
    recurrenceUntil:     row.recurrence_until instanceof Date
      ? row.recurrence_until.toISOString().slice(0, 10)
      : (row.recurrence_until || null),
    cancelledOccurrences,
    clientPackageId:     row.client_package_id || null,
    staffId:             row.staff_id || null,
    depositRequired:     Number(row.deposit_required || 0),
    depositPaid:         Number(row.deposit_paid || 0),
    depositPaidAt:       row.deposit_paid_at || null,
    locationAddress:     redactClient ? null : (row.location_address || null),
    videoRoomUrl:        row.video_room_url || null,
    customFieldValues:   redactClient ? null : (row.custom_field_values || {}),
    addOnIds:            row.add_on_ids || [],
    bookingTotal:        Number(row.booking_total || 0),
    giftCardCreditCents: Number(row.gift_card_credit_cents || 0),
    noShowAt:            row.no_show_at || null,
    feeChargedAmount:    Number(row.fee_charged_amount || 0),
    feeChargedKind:      row.fee_charged_kind || null,
    feeChargedAt:        row.fee_charged_at || null,
    tipAmount:           Number(row.tip_amount || 0),
    tipChargedAt:        row.tip_charged_at || null,
    completionLog:       redactClient ? {} : (row.completion_log || {}),
  };
}

// Mint a unique meeting URL for a virtual booking. Jitsi Meet's
// public instance accepts arbitrary room names — we prefix with
// 'thryve-' so the room is namespaced to us, and append a 24-char
// random suffix so the link is unguessable. No API key, no setup.
//
// Owners who want their own conferencing tool can paste a custom
// URL on the booking row post-create; the public booking flow
// always uses what's in the column, never re-mints.
import crypto from 'node:crypto';
export function mintVideoRoomUrl() {
  const token = crypto.randomBytes(18).toString('base64url');
  return `https://meet.jit.si/thryve-${token}`;
}

export const VALID_RECURRENCE = new Set([null, 'weekly', 'biweekly', 'monthly']);

// Returns true if [start, end) overlaps any availability window for the given weekday.
export function withinAvailability(availability, weekday, start, end) {
  const windows = (availability && availability[String(weekday)]) || [];
  return windows.some((w) => start >= w.start && end <= w.end);
}

// Returns true if the slot collides with any block or active booking on the given date.
// Slot conflict check. Permits group bookings — if serviceId + capacity
// are passed and capacity > 1, multiple bookings of the SAME service in
// the EXACT same start/end window can co-exist up to `capacity`. Any
// other overlap (different service, different exact slot, blocks,
// external busy) still conflicts.
// `travelBufferMin` (minutes) widens the conflict window symmetrically.
// When set, a booking at 9:00–10:00 with a 30-min travel buffer treats
// the slot as effectively reserving 8:30–10:30 of the owner's day —
// keeps mobile providers from accidentally accepting back-to-back
// bookings across town.
export async function hasConflict({ workspaceId, dateISO, start, end, serviceId = null, capacity = 1, excludeBookingId = null, travelBufferMin = 0 }) {
  // For mobile services with travel time, widen the proposed booking's
  // window symmetrically so an existing back-to-back booking (or block)
  // counts as a conflict if the gap is shorter than the travel time
  // needed to reach the next address.
  const buf = Math.max(0, Number(travelBufferMin) || 0);
  const startBuf = Math.max(0, start - buf);
  const endBuf   = Math.min(24 * 60, end + buf);

  // Only blocks with blocks_bookings = TRUE are real conflicts.
  // Informational personal events (blocks_bookings = FALSE) live on
  // the owner's calendar but don't gate bookings — clients can still
  // pick that slot, and the owner is responsible for moving their
  // own event if a booking lands there.
  const blocks = await sql`
    SELECT 1 FROM calendar_blocks
    WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
      AND blocks_bookings = TRUE
      AND start_min < ${endBuf} AND end_min > ${startBuf}
    LIMIT 1
  `;
  if (blocks.rows.length > 0) return true;

  // Inbound external busy times — same hard-block treatment as
  // calendar_blocks.
  const external = await sql`
    SELECT 1 FROM external_busy_blocks
    WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
      AND start_min < ${endBuf} AND end_min > ${startBuf}
    LIMIT 1
  `;
  if (external.rows.length > 0) return true;

  // Bookings overlap rules:
  //   1. Any overlap from a DIFFERENT service → conflict
  //   2. Same-service overlap with DIFFERENT start/end (not exact slot)
  //      → conflict (one therapist, can't run two groups stacked)
  //   3. Same-service, EXACT same slot → allowed up to capacity
  // excludeBookingId lets a reschedule re-validate availability without
  // colliding with itself. The booking we're moving is still in the
  // table at its old slot (we soft-update); ignore it during the check.
  // Note: buffered window applies to OTHER bookings too — ensures the
  // gap respects travel time in both directions.
  const overlapping = excludeBookingId
    ? await sql`
        SELECT service_id, start_min, end_min FROM bookings
        WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
          AND cancelled_at IS NULL
          AND start_min < ${endBuf} AND end_min > ${startBuf}
          AND id <> ${excludeBookingId}
      `
    : await sql`
        SELECT service_id, start_min, end_min FROM bookings
        WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
          AND cancelled_at IS NULL
          AND start_min < ${endBuf} AND end_min > ${startBuf}
      `;
  let sameSlotSameService = 0;
  for (const r of overlapping.rows) {
    const isExactSlot = r.start_min === start && r.end_min === end;
    const isSameService = serviceId && r.service_id === serviceId;
    if (!isSameService || !isExactSlot) return true;
    sameSlotSameService++;
  }
  return sameSlotSameService >= Math.max(1, Number(capacity) || 1);
}

// Race resolution for concurrent bookings of the same slot.
//
// hasConflict() is a SELECT-then-INSERT check, so two requests for the
// same slot can BOTH pass it before either inserts (a check-then-act
// race) — at scale this double-books. We can't prevent it with a UNIQUE
// / EXCLUDE constraint (existing intentional overlaps via
// skipConflictCheck would make the constraint fail to apply, and the
// Neon HTTP driver can't hold a transaction to serialize), so instead we
// resolve OPTIMISTICALLY: every racer inserts, then calls this to see if
// it lost.
//
// A freshly-inserted booking "loses" iff at least `capacity` CONFLICTING
// bookings rank before it by (created_at, id) — a total, deterministic
// order, so exactly `capacity` winners survive and every later racer
// rolls itself back. Because this runs as its own statement it sees the
// other racers' committed rows. Mirrors hasConflict's overlap rules.
export async function losesBookingRace({
  workspaceId, dateISO, start, end, serviceId = null, capacity = 1,
  bookingId, createdAt, travelBufferMin = 0,
}) {
  const buf = Math.max(0, Number(travelBufferMin) || 0);
  const startBuf = Math.max(0, start - buf);
  const endBuf   = Math.min(24 * 60, end + buf);
  const earlier = await sql`
    SELECT service_id, start_min, end_min FROM bookings
    WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
      AND cancelled_at IS NULL
      AND start_min < ${endBuf} AND end_min > ${startBuf}
      AND id <> ${bookingId}
      AND (created_at < ${createdAt} OR (created_at = ${createdAt} AND id < ${bookingId}))
  `;
  let sameSlotSameService = 0;
  for (const r of earlier.rows) {
    const isExactSlot = r.start_min === start && r.end_min === end;
    const isSameService = serviceId && r.service_id === serviceId;
    if (!isSameService || !isExactSlot) return true;
    sameSlotSameService++;
  }
  return sameSlotSameService >= Math.max(1, Number(capacity) || 1);
}


export function isPositiveInt(x, max = 24 * 60) {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max;
}

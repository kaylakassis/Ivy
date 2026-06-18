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
    slotFitService: !!row.slot_fit_service,
    bufferMinutes:  row.buffer_minutes,
    minNoticeHours: row.min_notice_hours == null ? 24 : Number(row.min_notice_hours),
    maxAdvanceDays: row.max_advance_days == null ? 60 : Number(row.max_advance_days),
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
// in sync with src/lib/categories.js on the client - the server-side
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
    // Per-service availability override. null → inherit workspace
    // general availability. When set, shape mirrors calendar_settings:
    //   { "0": [], "1": [{start, end}], ... }  (0 = Sunday)
    // Slot computation intersects this with the workspace windows so a
    // service can only narrow availability, never expand outside hours.
    availability:      row.availability || null,
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

// Unified appointment payment summary: deposit + collected balance vs the
// appointment total, so owner + client both see whether the whole service
// has been paid. collect_invoice_* fields are only present when the query
// LEFT JOINs the booking's balance invoice (owner calendar + client portal);
// without them it degrades to deposit-only. Returns null for $0 / untotaled
// bookings so callers can skip the line.
export function computeBookingPayment(row) {
  const total = Number(row.booking_total || 0);
  if (total <= 0) return null;
  const depositPaid = Number(row.deposit_paid || 0);
  const balancePaid = row.collect_invoice_status === 'paid'
    ? Number(row.collect_invoice_paid_amount ?? (total - depositPaid))
    : 0;
  const amountPaid = +(depositPaid + balancePaid).toFixed(2);
  return {
    total,
    depositPaid,
    balancePaid,
    amountPaid,
    balanceDue: Math.max(0, +(total - amountPaid).toFixed(2)),
    fullyPaid: amountPaid >= total - 0.005,
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
    // Unified deposit + balance payment status. Omitted on the public
    // (redacted) slot grid, which must never reveal revenue.
    payment:             redactClient ? undefined : computeBookingPayment(row),
  };
}

// Mint a unique meeting URL for a virtual booking. Jitsi Meet's
// public instance accepts arbitrary room names - we prefix with
// 'ivy-' so the room is namespaced to us, and append a 24-char
// random suffix so the link is unguessable. No API key, no setup.
//
// Owners who want their own conferencing tool can paste a custom
// URL on the booking row post-create; the public booking flow
// always uses what's in the column, never re-mints.
import crypto from 'node:crypto';
export function mintVideoRoomUrl() {
  const token = crypto.randomBytes(18).toString('base64url');
  return `https://meet.jit.si/ivy-${token}`;
}

export const VALID_RECURRENCE = new Set([null, 'weekly', 'biweekly', 'monthly']);

// Intersect two lists of {start, end} windows. Empty/missing inputs yield [].
// Used to combine workspace general availability with a per-service override
// so a service can only restrict, never expand, the bookable hours.
export function intersectWindows(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return [];
  const out = [];
  for (const wa of a) {
    for (const wb of b) {
      const start = Math.max(wa.start, wb.start);
      const end = Math.min(wa.end, wb.end);
      if (start < end) out.push({ start, end });
    }
  }
  return out;
}

// Effective windows for [weekday] given workspace general availability and
// an optional per-service override. When serviceAvailability is null the
// service inherits the workspace windows; when set, the two are intersected.
export function effectiveWindows(workspaceAvailability, serviceAvailability, weekday) {
  const wsWindows = (workspaceAvailability && workspaceAvailability[String(weekday)]) || [];
  if (!serviceAvailability) return wsWindows;
  const svcWindows = serviceAvailability[String(weekday)] || [];
  return intersectWindows(wsWindows, svcWindows);
}

// Returns true if [start, end) sits inside any effective availability window
// for the given weekday. `serviceAvailability` is optional - when present,
// the workspace windows are intersected with the service override.
export function withinAvailability(availability, weekday, start, end, serviceAvailability) {
  const windows = effectiveWindows(availability, serviceAvailability, weekday);
  return windows.some((w) => start >= w.start && end <= w.end);
}

// Resolve a (dateISO, startMin) pair - both in the workspace's wall-clock
// timezone - to a UTC epoch (ms). Critical for the min-notice / horizon
// checks: previously the server treated the pair as UTC, which meant an
// owner in PST testing a 3pm slot tomorrow got rejected at 9pm-tonight-
// PST as "less than 12h" because the server thought "3pm" meant 3pm UTC
// (only ~6h away), not 3pm PST (~18h away).
//
// Two-pass to handle DST transitions cleanly: the offset of `tz` near a
// spring-forward / fall-back boundary depends on the moment, so we
// refine our guess once.
//
// `tz` is an IANA name (e.g. "America/Los_Angeles"). When null/missing -
// matches the legacy behavior - we treat the inputs as UTC.
export function slotEpochMs(dateISO, startMin, tz) {
  if (!dateISO || !Number.isFinite(startMin)) return NaN;
  const [y, m, d] = dateISO.split('-').map(Number);
  const h = Math.floor(startMin / 60);
  const min = startMin % 60;
  const naiveUtcMs = Date.UTC(y, (m || 1) - 1, d, h, min);
  if (!tz) return naiveUtcMs;
  // First-pass offset at the naive UTC moment, then refine at the
  // corrected moment to absorb a DST transition.
  const guess1 = tzOffsetMinutes(naiveUtcMs, tz);
  const corrected = naiveUtcMs - guess1 * 60_000;
  const guess2 = tzOffsetMinutes(corrected, tz);
  return naiveUtcMs - guess2 * 60_000;
}

// Minutes to ADD to UTC to get wall-clock time in `tz` at the given
// moment. PST (UTC-8) returns -480; CEST (UTC+2) returns 120.
function tzOffsetMinutes(epochMs, tz) {
  if (!tz) return 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(epochMs)).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const localAsUtcMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return Math.round((localAsUtcMs - epochMs) / 60_000);
  } catch {
    // Unknown tz - fall back to UTC (offset 0). Same legacy behavior.
    return 0;
  }
}

// True when a recurring booking master has an occurrence landing exactly
// on `dateISO`. Recurring bookings store only the master row (first
// occurrence) + a rule; future occurrences are virtual, so the plain
// `date = dateISO` queries below would miss them and double-book the
// owner. This mirrors the stepping the calendar UI uses
// (src/features/calendar/utils.js expandBookings) so server + client agree.
function recurringOccursOn(master, dateISO) {
  const rule = master.recurrence_rule;
  if (!rule) return master.date === dateISO;
  if (dateISO < master.date) return false;
  if (master.recurrence_until && dateISO > master.recurrence_until) return false;
  const cancelled = (master.cancelled_occurrences || []).map((d) => String(d).slice(0, 10));
  if (cancelled.includes(dateISO)) return false;

  const [y, mo, d] = master.date.split('-').map(Number);
  let cursor = new Date(Date.UTC(y, mo - 1, d));
  const targetMs = Date.parse(dateISO + 'T00:00:00Z');
  let safety = 0;
  while (cursor.getTime() <= targetMs && safety < 1000) {
    safety += 1;
    if (cursor.toISOString().slice(0, 10) === dateISO) return true;
    if (rule === 'weekly')        cursor = new Date(cursor.getTime() + 7 * 86400000);
    else if (rule === 'biweekly') cursor = new Date(cursor.getTime() + 14 * 86400000);
    else if (rule === 'monthly')  { const n = new Date(cursor); n.setUTCMonth(n.getUTCMonth() + 1); cursor = n; }
    else return false;
  }
  return false;
}

// Pull recurring masters whose series window spans `dateISO` and whose
// time overlaps the (buffered) proposed window. Caller filters to those
// that actually have an occurrence on dateISO via recurringOccursOn.
async function overlappingRecurringMasters({ workspaceId, dateISO, startBuf, endBuf }) {
  const { rows } = await sql`
    SELECT id, service_id, start_min, end_min, created_at,
           date::text AS date, recurrence_until::text AS recurrence_until,
           recurrence_rule, cancelled_occurrences
    FROM bookings
    WHERE workspace_id = ${workspaceId}
      AND cancelled_at IS NULL
      AND recurrence_rule IS NOT NULL
      AND date <= ${dateISO}
      AND (recurrence_until IS NULL OR recurrence_until >= ${dateISO})
      AND start_min < ${endBuf} AND end_min > ${startBuf}
  `;
  return rows;
}

// Returns true if the slot collides with any block or active booking on the given date.
// Slot conflict check. Permits group bookings - if serviceId + capacity
// are passed and capacity > 1, multiple bookings of the SAME service in
// the EXACT same start/end window can co-exist up to `capacity`. Any
// other overlap (different service, different exact slot, blocks,
// external busy) still conflicts.
// `travelBufferMin` (minutes) widens the conflict window symmetrically.
// When set, a booking at 9:00–10:00 with a 30-min travel buffer treats
// the slot as effectively reserving 8:30–10:30 of the owner's day -
// keeps mobile providers from accidentally accepting back-to-back
// bookings across town.
export async function hasConflict({ workspaceId, dateISO, start, end, serviceId = null, capacity = 1, excludeBookingId = null, travelBufferMin = 0, bufferMin = 0 }) {
  // Widen the proposed booking's window symmetrically by the total required
  // gap: the workspace's minimum buffer between appointments (bufferMin) +
  // any per-service travel time (travelBufferMin). An existing back-to-back
  // booking/block then counts as a conflict when the gap is too small -
  // this is what bars clients from booking too close to another appointment.
  const buf = Math.max(0, Number(travelBufferMin) || 0) + Math.max(0, Number(bufferMin) || 0);
  const startBuf = Math.max(0, start - buf);
  const endBuf   = Math.min(24 * 60, end + buf);

  // Only blocks with blocks_bookings = TRUE are real conflicts.
  // Informational personal events (blocks_bookings = FALSE) live on
  // the owner's calendar but don't gate bookings - clients can still
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

  // Inbound external busy times - same hard-block treatment as
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
  // Note: buffered window applies to OTHER bookings too - ensures the
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

  // Virtual occurrences of recurring bookings that land on this date.
  const recurringMasters = await overlappingRecurringMasters({ workspaceId, dateISO, startBuf, endBuf });
  for (const m of recurringMasters) {
    if (excludeBookingId && m.id === excludeBookingId) continue;
    if (m.date === dateISO) continue; // first occurrence already counted by the date= query above
    if (!recurringOccursOn(m, dateISO)) continue;
    const isExactSlot = m.start_min === start && m.end_min === end;
    const isSameService = serviceId && m.service_id === serviceId;
    if (!isSameService || !isExactSlot) return true;
    sameSlotSameService++;
  }

  return sameSlotSameService >= Math.max(1, Number(capacity) || 1);
}

// Race resolution for concurrent bookings of the same slot.
//
// hasConflict() is a SELECT-then-INSERT check, so two requests for the
// same slot can BOTH pass it before either inserts (a check-then-act
// race) - at scale this double-books. We can't prevent it with a UNIQUE
// / EXCLUDE constraint (existing intentional overlaps via
// skipConflictCheck would make the constraint fail to apply, and the
// Neon HTTP driver can't hold a transaction to serialize), so instead we
// resolve OPTIMISTICALLY: every racer inserts, then calls this to see if
// it lost.
//
// A freshly-inserted booking "loses" iff at least `capacity` CONFLICTING
// bookings rank before it by (created_at, id) - a total, deterministic
// order, so exactly `capacity` winners survive and every later racer
// rolls itself back. Because this runs as its own statement it sees the
// other racers' committed rows. Mirrors hasConflict's overlap rules.
export async function losesBookingRace({
  workspaceId, dateISO, start, end, serviceId = null, capacity = 1,
  bookingId, createdAt, travelBufferMin = 0, bufferMin = 0,
}) {
  const buf = Math.max(0, Number(travelBufferMin) || 0) + Math.max(0, Number(bufferMin) || 0);
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

  // Recurring series occurrences landing on this date that rank before us.
  // Their masters pre-exist (older created_at), so a new single booking on
  // a future occurrence date correctly loses to the established series.
  const recurringMasters = await overlappingRecurringMasters({ workspaceId, dateISO, startBuf, endBuf });
  const myTs = new Date(createdAt).getTime();
  for (const m of recurringMasters) {
    if (m.id === bookingId) continue;
    if (m.date === dateISO) continue; // first occurrence already counted by the date= query above
    const mTs = new Date(m.created_at).getTime();
    const ranksEarlier = mTs < myTs || (mTs === myTs && m.id < bookingId);
    if (!ranksEarlier) continue;
    if (!recurringOccursOn(m, dateISO)) continue;
    const isExactSlot = m.start_min === start && m.end_min === end;
    const isSameService = serviceId && m.service_id === serviceId;
    if (!isSameService || !isExactSlot) return true;
    sameSlotSameService++;
  }

  return sameSlotSameService >= Math.max(1, Number(capacity) || 1);
}


export function isPositiveInt(x, max = 24 * 60) {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max;
}

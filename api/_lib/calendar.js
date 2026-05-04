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

// Categories for Discover. Owners pick one (or none). Kept short so the chip
// row doesn't overflow on small screens — add carefully.
export const DISCOVER_CATEGORIES = ['Wellness', 'Beauty', 'Fitness', 'Health', 'Professional'];
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
  };
}

// Default reminder schedule in minutes-before-appointment.
// 10080 = 7 days, 2880 = 2 days, 1440 = 1 day, 120 = 2 hours.
export const DEFAULT_REMINDERS = [10080, 2880, 1440, 120];

export function serializeBlock(row) {
  if (!row) return null;
  return {
    id:        row.id,
    date:      row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    startMin:  row.start_min,
    endMin:    row.end_min,
    label:     row.label,
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
  };
}

export const VALID_RECURRENCE = new Set([null, 'weekly', 'biweekly', 'monthly']);

// Returns true if [start, end) overlaps any availability window for the given weekday.
export function withinAvailability(availability, weekday, start, end) {
  const windows = (availability && availability[String(weekday)]) || [];
  return windows.some((w) => start >= w.start && end <= w.end);
}

// Returns true if the slot collides with any block or active booking on the given date.
export async function hasConflict({ workspaceId, dateISO, start, end }) {
  const blocks = await sql`
    SELECT 1 FROM calendar_blocks
    WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
      AND start_min < ${end} AND end_min > ${start}
    LIMIT 1
  `;
  if (blocks.rows.length > 0) return true;
  const bookings = await sql`
    SELECT 1 FROM bookings
    WHERE workspace_id = ${workspaceId} AND date = ${dateISO}
      AND cancelled_at IS NULL
      AND start_min < ${end} AND end_min > ${start}
    LIMIT 1
  `;
  return bookings.rows.length > 0;
}

export function isPositiveInt(x, max = 24 * 60) {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max;
}

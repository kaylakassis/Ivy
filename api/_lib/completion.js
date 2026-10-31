// Per-occurrence completion state on bookings.completion_log, shared by
// the owner endpoint (api/calendar/bookings/complete.js) and the helper
// endpoint (api/helper/bookings/[id]/complete.js) so "mark complete" means
// exactly the same thing whoever presses it.
//
// completion_log is a JSONB map keyed by occurrenceDate ('YYYY-MM-DD'):
//   { completedAt, completedByUserId, completedByStaffId, notes,
//     attachments: [...], visibleToClient }
//
// Callers have already loaded the booking row with their own scoping
// (owner: workspace_id; helper: workspace_id AND staff_id) - this module
// never widens that. The UPDATE re-asserts workspace_id as a belt.
import { sql } from './db.js';

export class CompletionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function cancelledOccurrences(booking) {
  return (booking.cancelled_occurrences || []).map((d) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : String(d),
  );
}

export function completionLogOf(booking) {
  return booking.completion_log && typeof booking.completion_log === 'object'
    ? { ...booking.completion_log } : {};
}

// Shared refusals for any completion write.
export function assertCompletable(booking, occurrenceDate) {
  if (!isIsoDate(occurrenceDate)) throw new CompletionError(400, 'occurrenceDate must be YYYY-MM-DD');
  if (booking.cancelled_at) throw new CompletionError(400, "Can't complete a cancelled booking");
  if (cancelledOccurrences(booking).includes(occurrenceDate)) {
    throw new CompletionError(400, "Can't complete a cancelled occurrence");
  }
}

async function writeLog(booking, log) {
  const upd = await sql`
    UPDATE bookings
       SET completion_log = ${JSON.stringify(log)}::jsonb,
           updated_at = NOW()
     WHERE id = ${booking.id} AND workspace_id = ${booking.workspace_id}
    RETURNING *
  `;
  return upd.rows[0];
}

// Mark one occurrence complete. `attachments` must already be sanitised
// by the caller (helpers never attach files; owners go through
// complete.js's allowlist). Returns the updated booking row.
export async function markComplete({ booking, occurrenceDate, userId, staffId = null, notes = '', attachments = [], visibleToClient = true }) {
  assertCompletable(booking, occurrenceDate);
  if (booking.no_show_at) throw new CompletionError(400, "Can't complete a no-show booking - undo the no-show first");
  const log = completionLogOf(booking);
  if (log[occurrenceDate]) {
    throw new CompletionError(400, 'This booking is already marked complete - edit or remove the completed entry instead');
  }
  log[occurrenceDate] = {
    completedAt: new Date().toISOString(),
    completedByUserId: userId,
    completedByStaffId: staffId || booking.staff_id || null,
    notes: notes == null ? '' : String(notes).slice(0, 8000),
    attachments: Array.isArray(attachments) ? attachments : [],
    visibleToClient: visibleToClient !== false,
  };
  return writeLog(booking, log);
}

// Remove one occurrence's completion. Returns { booking, removed } where
// `removed` is the deleted entry (null when nothing was there) so the
// owner endpoint can clean up its blob attachments.
export async function undoComplete({ booking, occurrenceDate }) {
  if (!isIsoDate(occurrenceDate)) throw new CompletionError(400, 'occurrenceDate must be YYYY-MM-DD');
  const log = completionLogOf(booking);
  const removed = log[occurrenceDate] || null;
  if (!removed) return { booking, removed: null };
  delete log[occurrenceDate];
  return { booking: await writeLog(booking, log), removed };
}

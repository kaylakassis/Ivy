// Time + slot helpers shared by the calendar feature.
import { zonedTimeToUtcMs, zonedParts } from '../../lib/tz.js';

// Intersect two lists of {start, end} windows. Mirrors the server-side
// helper in api/_lib/calendar.js so the slot grid and the booking-validation
// endpoint never disagree.
function intersectWindowsLocal(a, b) {
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

export function minToHM(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${mm.toString().padStart(2, '0')} ${ap}`;
}

export function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function fmtDateISO(d) {
  // Use local time so "today" matches the user's calendar visually.
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// True when `<occurrenceISO> + endMin` has already passed. Used to
// auto-prompt the completion log once a session is over.
export function isOccurrencePast(occurrenceISO, endMin) {
  if (!occurrenceISO) return false;
  const end = parseISO(occurrenceISO);
  end.setMinutes(end.getMinutes() + Number(endMin || 0));
  return end.getTime() < Date.now();
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function startOfWeek(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();
  const diff = (day + 6) % 7;
  r.setDate(r.getDate() - diff);
  return r;
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export const WEEKDAYS_LONG  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Compute slot grid for a date given calendar state and a service duration.
// Returns [{ start, end, available, reason }]
// Compute available booking slots for a date + service. Service-aware so
// group classes (capacity > 1) keep returning available slots until they
// hit capacity. Caller passes the full service object so we can read its
// id + capacity; for backwards compat we accept just a number too.
export function slotsForDate(cal, date, serviceOrDur) {
  const service = typeof serviceOrDur === 'number'
    ? { durationMinutes: serviceOrDur, id: null, capacity: 1 }
    : (serviceOrDur || {});
  const dur = service.durationMinutes || 60;
  const capacity = Math.max(1, Number(service.capacity) || 1);
  const dayIdx = date.getDay();
  const dateISO = fmtDateISO(date);
  // Effective windows = workspace general availability, optionally narrowed
  // by a per-service override. The override can only restrict (intersect),
  // never expand, so a service set to "5–8pm" on a workspace open 8am–8pm
  // becomes 5–8pm; a service set to "9–11pm" on the same workspace
  // becomes empty for that day.
  const wsWindows = (cal.settings?.availability && cal.settings.availability[String(dayIdx)]) || [];
  const svcWindowsRaw = service.availability?.[String(dayIdx)];
  const windows = svcWindowsRaw
    ? intersectWindowsLocal(wsWindows, svcWindowsRaw)
    : wsWindows;
  // Start-time spacing: a fixed grid (slotMinutes - e.g. 60 = top of the
  // hour) or, when slotFitService is set, each service's own length so
  // appointments pack back-to-back. Floored at 5 min to avoid a 0-step loop.
  const step = Math.max(5, cal.settings?.slotFitService ? dur : (cal.settings?.slotMinutes || 30));
  // Minimum advance notice: slots earlier than (now + notice) aren't
  // bookable, and past times are always excluded. Default 24h; 0 = same-day
  // allowed (but never the past). Client-facing only - public booking +
  // portal reschedule both call this; the owner's calendar does not.
  const minNoticeMin = Math.max(0, Number(cal.settings?.minNoticeHours ?? 24) * 60);
  const cutoffMs = Date.now() + minNoticeMin * 60 * 1000;
  // Booking timezone: past/too-soon/too-far are judged against "now in the
  // WORKSPACE zone," not the viewer's browser. When unset, zonedTimeToUtcMs
  // falls back to browser-local, preserving the pre-timezone behavior exactly.
  const tz = cal.settings?.timezone || null;
  // Booking horizon: slots beyond (today + maxAdvanceDays) aren't bookable.
  // 0 = no limit. Inclusive of the whole final day, in the workspace zone.
  const maxAdvanceDays = Math.max(0, Number(cal.settings?.maxAdvanceDays ?? 60));
  const horizonMs = maxAdvanceDays > 0
    ? (() => {
        const t = zonedParts(tz); // today in the workspace zone
        const base = new Date(Date.UTC(t.y, t.m - 1, t.d));
        base.setUTCDate(base.getUTCDate() + maxAdvanceDays);
        const horizonISO = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
        return zonedTimeToUtcMs(horizonISO, 24 * 60 - 1, tz); // end of that day
      })()
    : Infinity;
  // Buffer between appointments: the workspace minimum gap + this service's
  // travel time. Widens the conflict window so a slot too close to an
  // existing booking/block is greyed out (matches the server's hasConflict).
  const buf = Math.max(0, Number(cal.settings?.bufferMinutes || 0)) + Math.max(0, Number(service.travelBufferMinutes || 0));
  // Recurring masters store only their FIRST occurrence; expand them to
  // this date so a weekly 10am correctly occupies next week's grid too.
  // The server's hasConflict already checks occurrences - without this,
  // the public/reschedule grids showed slots the server then refused
  // ("That slot was just taken") after the client filled the whole form.
  const dayBookings = expandBookings(cal.bookings || [], date, date);
  const slots = [];

  for (const w of windows) {
    for (let t = w.start; t + dur <= w.end; t += step) {
      const start = t;
      const end = t + dur;
      let reason = null;
      let seatsTaken = 0;

      for (const b of (cal.blocks || [])) {
        if (b.date === dateISO && !(end + buf <= b.startMin || start >= b.endMin + buf)) {
          reason = 'Blocked';
          break;
        }
      }
      if (!reason) {
        for (const bk of dayBookings) {
          if (bk.date !== dateISO) continue;
          // Exact same slot is allowed up to capacity (no buffer applied to
          // itself); any OTHER booking within the buffer window conflicts.
          const sameSlotExact = bk.startMin === start && bk.endMin === end;
          if (!sameSlotExact && (end + buf <= bk.startMin || start >= bk.endMin + buf)) continue;
          if (sameSlotExact && (end <= bk.startMin || start >= bk.endMin)) continue;
          // Same-service + EXACT-slot bookings count toward capacity.
          // Anything else (different service or different time even
          // same service) is a hard conflict.
          const sameSlot = bk.startMin === start && bk.endMin === end;
          const sameService = service.id && bk.serviceId === service.id;
          if (!sameSlot || !sameService) {
            reason = 'Booked';
            break;
          }
          seatsTaken++;
        }
      }
      // Absolute instant of this slot's start in the workspace zone, so the
      // past/too-soon/too-far checks are DST-correct and match the server.
      const slotStartMs = zonedTimeToUtcMs(dateISO, start, tz);
      if (!reason && slotStartMs < cutoffMs) {
        reason = minNoticeMin > 0 ? 'Too soon' : 'Past';
      }
      if (!reason && slotStartMs > horizonMs) {
        reason = 'Too far';
      }
      const available = !reason && seatsTaken < capacity;
      const seatsLeft = capacity > 1 ? Math.max(0, capacity - seatsTaken) : null;
      slots.push({ start, end, available, reason, seatsLeft, capacity });
    }
  }
  return slots;
}

export function slugify(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

// Expand recurring bookings into virtual occurrences within [rangeStart, rangeEnd].
// Each output entry references its master via `recurrenceMasterId` and carries
// the same fields, with `date` shifted to the occurrence date.
export function expandBookings(bookings, rangeStart, rangeEnd) {
  const out = [];
  const startISO = fmtDateISO(rangeStart);
  const endISO   = fmtDateISO(rangeEnd);

  for (const b of bookings) {
    if (!b.recurrenceRule) {
      // Single occurrence - include if it lands in range.
      if (b.date >= startISO && b.date <= endISO) out.push({ ...b, occurrenceDate: b.date });
      continue;
    }

    const stop = b.recurrenceUntil
      ? Math.min(parseISO(b.recurrenceUntil).getTime(), rangeEnd.getTime())
      : rangeEnd.getTime();
    const cancelledSet = new Set(b.cancelledOccurrences || []);

    let cursor = parseISO(b.date);
    // Series anchor day-of-month for monthly clamping (see below).
    const anchorDay = Number(String(b.date).slice(8, 10)) || cursor.getDate();
    let safety = 0;

    while (cursor.getTime() <= stop && safety < 1000) {
      safety += 1;
      const iso = fmtDateISO(cursor);
      if (iso >= startISO && iso <= endISO && !cancelledSet.has(iso)) {
        out.push({
          ...b,
          // Stamp the occurrence date so the renderer drops it in the right cell.
          date: iso,
          occurrenceDate: iso,
          isRecurringOccurrence: true,
          recurrenceMasterId: b.id,
        });
      }
      // Step forward by the rule.
      if (b.recurrenceRule === 'weekly')   cursor = addDays(cursor, 7);
      else if (b.recurrenceRule === 'biweekly') cursor = addDays(cursor, 14);
      else if (b.recurrenceRule === 'monthly') {
        // Clamp to the target month's last day, preserving the series
        // anchor day: a booking anchored on the 31st occurs Jan 31 →
        // Feb 28 → Mar 31, never setMonth's "Feb 31" → Mar 3 drift.
        // MUST mirror recurringOccursOn (api/_lib/calendar.js) or the
        // grid renders slots the server rejects and vice versa.
        const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1,
          cursor.getHours(), cursor.getMinutes());
        const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(anchorDay, lastDay));
        cursor = next;
      }
      else break;
    }
  }
  return out;
}

// Convenience for components: returns bookings expanded to cover a window
// starting `daysBack` before today and ending `daysAhead` after.
export function expandedBookings(bookings, { daysBack = 7, daysAhead = 90 } = {}) {
  const now = new Date();
  const rangeStart = addDays(now, -daysBack);
  const rangeEnd   = addDays(now, daysAhead);
  return expandBookings(bookings, rangeStart, rangeEnd);
}

export const RECURRENCE_OPTIONS = [
  { value: null,        label: "Doesn't repeat" },
  { value: 'weekly',    label: 'Weekly' },
  { value: 'biweekly',  label: 'Every 2 weeks' },
  { value: 'monthly',   label: 'Monthly' },
];

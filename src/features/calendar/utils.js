// Time + slot helpers shared by the calendar feature.

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
  const windows = (cal.settings?.availability && cal.settings.availability[String(dayIdx)]) || [];
  const step = cal.settings?.slotMinutes || 30;
  const slots = [];

  for (const w of windows) {
    for (let t = w.start; t + dur <= w.end; t += step) {
      const start = t;
      const end = t + dur;
      let reason = null;
      let seatsTaken = 0;

      for (const b of (cal.blocks || [])) {
        if (b.date === dateISO && !(end <= b.startMin || start >= b.endMin)) {
          reason = 'Blocked';
          break;
        }
      }
      if (!reason) {
        for (const bk of (cal.bookings || [])) {
          if (bk.date !== dateISO) continue;
          if (end <= bk.startMin || start >= bk.endMin) continue;
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
      // Single occurrence — include if it lands in range.
      if (b.date >= startISO && b.date <= endISO) out.push({ ...b, occurrenceDate: b.date });
      continue;
    }

    const stop = b.recurrenceUntil
      ? Math.min(parseISO(b.recurrenceUntil).getTime(), rangeEnd.getTime())
      : rangeEnd.getTime();
    const cancelledSet = new Set(b.cancelledOccurrences || []);

    let cursor = parseISO(b.date);
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
        const next = new Date(cursor);
        next.setMonth(next.getMonth() + 1);
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

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
export function slotsForDate(cal, date, serviceDur) {
  const dayIdx = date.getDay();
  const dateISO = fmtDateISO(date);
  const windows = (cal.settings?.availability && cal.settings.availability[String(dayIdx)]) || [];
  const dur = serviceDur || 60;
  const step = cal.settings?.slotMinutes || 30;
  const slots = [];

  for (const w of windows) {
    for (let t = w.start; t + dur <= w.end; t += step) {
      const start = t;
      const end = t + dur;
      let reason = null;

      for (const b of (cal.blocks || [])) {
        if (b.date === dateISO && !(end <= b.startMin || start >= b.endMin)) {
          reason = 'Blocked';
          break;
        }
      }
      if (!reason) {
        for (const bk of (cal.bookings || [])) {
          if (bk.date === dateISO && !(end <= bk.startMin || start >= bk.endMin)) {
            reason = 'Booked';
            break;
          }
        }
      }
      slots.push({ start, end, available: !reason, reason });
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

// Opening-hours text for the Hours section. The editor stores each day as
// { open: 'HH:MM', close: 'HH:MM', closed: bool } and writes the sentence
// visitors read into `hours` ("9:00 AM to 5:00 PM", "Closed"). Older sites
// only have the `hours` text; parseHoursText makes a best effort to read
// times back out of it so the time pickers start filled in.
// Plain JS: shared by the editor and Ivy's website tools.

export function to12h(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return '';
  let h = Number(m[1]);
  const min = m[2];
  if (h > 23 || Number(min) > 59) return '';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

export function hoursText(day) {
  if (!day) return '';
  if (day.closed) return 'Closed';
  const o = to12h(day.open);
  const c = to12h(day.close);
  if (o && c) return `${o} to ${c}`;
  if (o) return `From ${o}`;
  if (c) return `Until ${c}`;
  return typeof day.hours === 'string' ? day.hours : '';
}

// Best-effort read of a legacy hours string ("9 – 5", "9am-5pm",
// "09:00 - 17:00", "9:30 AM to 6 PM", "Closed") into { open, close, closed }.
// Returns nulls when it cannot tell, so the editor shows empty pickers
// and keeps the original text until the owner sets a time.
export function parseHoursText(text) {
  const t = String(text || '').trim();
  if (!t) return { open: '', close: '', closed: false };
  if (/closed|by appointment|appt/i.test(t)) return { open: '', close: '', closed: true };
  const times = [...t.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/gi)];
  if (times.length < 2) return { open: '', close: '', closed: false };
  const pick = (m, isClose) => {
    let h = Number(m[1]);
    const min = m[2] || '00';
    const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (h > 24 || Number(min) > 59) return '';
    if (ap === 'pm' && h < 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    // "9 – 5": no am/pm anywhere; a closing hour under 9 is almost always afternoon.
    else if (!ap && isClose && h < 9) h += 12;
    if (h === 24) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  };
  const open = pick(times[0], false);
  const close = pick(times[1], true);
  if (!open || !close) return { open: '', close: '', closed: false };
  return { open, close, closed: false };
}

// Normalises a day the way the editor saves it.
export function normalizeDay(day) {
  const d = { ...(day || {}) };
  if (d.open == null && d.close == null && d.closed == null) {
    Object.assign(d, parseHoursText(d.hours));
  }
  d.closed = !!d.closed;
  // Times are kept while a day is marked closed, so switching it back
  // open brings them back.
  d.open = String(d.open || '');
  d.close = String(d.close || '');
  const txt = hoursText(d);
  if (txt) d.hours = txt;
  return d;
}

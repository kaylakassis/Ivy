// Calendar dates with no time ("2026-11-15": an invoice due date, a quote
// expiry, a task due date, an expense date).
//
// `new Date('2026-11-15')` reads a bare date as midnight UTC, so anyone west
// of London saw it as the evening before ("Due 11/14"). And
// `new Date().toISOString().slice(0, 10)` is TODAY IN UTC, which from the
// late afternoon in the US is already tomorrow. These helpers keep a bare
// date on the viewer's own calendar day.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A Date at local midnight for a bare YYYY-MM-DD; anything else (a full
// timestamp) parses as usual. null for empty or unparseable input.
export function parseDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value);
  const m = DATE_ONLY.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Locale-formatted bare date ('' when there is none).
export function fmtDateOnly(value, opts) {
  const d = parseDateOnly(value);
  return d ? d.toLocaleDateString(undefined, opts) : '';
}

// YYYY-MM-DD of a Date on the viewer's own calendar (default: today).
export function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

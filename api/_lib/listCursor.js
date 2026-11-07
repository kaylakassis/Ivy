// Opaque "where the last page ended" cursors for the owner's long lists
// (GET /api/invoices and GET /api/clients with ?cursor=). A cursor is the
// sort key of the last row on a page; the next page starts strictly after
// it, so rows added, archived or edited while the owner scrolls never make
// a row show twice or get skipped (an offset would).
//
// Lists called without ?cursor keep the original offset paging and shape:
// the iPhone 1.0.5 build depends on it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(parts) {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

// Returns the array of `n` strings, or null when the cursor is malformed.
// The last part is always a row id (uuid). Values are only ever passed to
// SQL as parameters, with a cast, never spliced into the query text.
export function decodeCursor(raw, n) {
  if (typeof raw !== 'string' || !raw || raw.length > 400) return null;
  try {
    const parts = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== n) return null;
    if (!parts.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 80)) return null;
    if (!UUID_RE.test(parts[n - 1])) return null;
    return parts;
  } catch {
    return null;
  }
}

// Page size for cursor requests: default 50, at most 200.
export function cursorPageSize(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(200, n) : 50;
}

// A timestamp (as Postgres prints it) or a YYYY-MM-DD date, before it is
// cast in SQL: a bad value is a 400, never a query error.
export const looksLikeDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const looksLikeTimestamp = (s) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(s);

// ILIKE pattern for a "contains" search, with % _ and \ taken literally.
export function containsPattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

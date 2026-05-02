// GET /api/me — returns the user-context object: which workspace they own
// (if any), which businesses they're a client of, and a "summary" snapshot
// the client home dashboard renders (counts of unread messages, upcoming
// bookings, pending invoices/docs).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { userContext, ids } from '../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const ctx = await userContext(user);
    if (!ctx.isClient) {
      // Owner-only — return context with empty summary.
      return ok(res, { ...ctx, summary: emptySummary() });
    }

    const myIds = ids(ctx.memberships);
    // Use ARRAY[$1...] style via sql.query so we can pass an array param.
    const summary = await loadSummary(myIds);
    return ok(res, { ...ctx, summary });
  } catch (err) {
    return serverError(res, err);
  }
}

function emptySummary() {
  return { unreadMessages: 0, upcomingBookings: 0, openInvoices: 0, pendingDocs: 0 };
}

async function loadSummary(clientIds) {
  if (!clientIds.length) return emptySummary();
  // Single round-trip with parallel sub-queries keeps page loads snappy.
  const [unread, upcoming, openInv, pending] = await Promise.all([
    sql.query(
      `SELECT COALESCE(SUM(unread_client), 0)::int AS n
         FROM message_threads WHERE client_id = ANY($1)`,
      [clientIds],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS n FROM bookings
         WHERE client_id = ANY($1) AND cancelled_at IS NULL
         AND date >= CURRENT_DATE`,
      [clientIds],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS n FROM invoices
         WHERE client_id = ANY($1) AND status IN ('sent','overdue')`,
      [clientIds],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS n FROM documents
         WHERE recipient_client_id = ANY($1) AND status = 'sent'`,
      [clientIds],
    ),
  ]);
  return {
    unreadMessages:   unread.rows[0]?.n   || 0,
    upcomingBookings: upcoming.rows[0]?.n || 0,
    openInvoices:     openInv.rows[0]?.n  || 0,
    pendingDocs:      pending.rows[0]?.n  || 0,
  };
}

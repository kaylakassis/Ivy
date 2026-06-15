// GET /api/pos/today — today's in-person sales summary.
//
// Surfaces sale count + revenue at the top of the Sell tab so the
// cashier has a real-time "what's the drawer at?" reading for end-
// of-day reconciliation without leaving the POS view.
//
// We treat any invoice that was both ISSUED today AND already PAID
// as a same-day sale — covers cash sales (paid immediately) and
// pay-link sales the customer paid before close.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const r = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'paid'                AND DATE(issue_date) = CURRENT_DATE)::int AS paid_count,
        COALESCE(SUM(paid_amount) FILTER (WHERE status = 'paid' AND DATE(issue_date) = CURRENT_DATE), 0)::numeric AS paid_total,
        COUNT(*) FILTER (WHERE status = 'paid' AND paid_method = 'cash' AND DATE(issue_date) = CURRENT_DATE)::int AS cash_count,
        COALESCE(SUM(paid_amount) FILTER (WHERE status = 'paid' AND paid_method = 'cash' AND DATE(issue_date) = CURRENT_DATE), 0)::numeric AS cash_total,
        COUNT(*) FILTER (WHERE status IN ('sent','overdue') AND DATE(issue_date) = CURRENT_DATE)::int AS open_count
      FROM invoices
      WHERE workspace_id = ${workspaceId}
    `;
    const row = r.rows[0] || {};
    return ok(res, {
      paidCount:  Number(row.paid_count  || 0),
      paidTotal:  Number(row.paid_total  || 0),
      cashCount:  Number(row.cash_count  || 0),
      cashTotal:  Number(row.cash_total  || 0),
      openCount:  Number(row.open_count  || 0),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

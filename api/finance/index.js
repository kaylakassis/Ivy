// GET /api/finance — dashboard summary for the current workspace.
// Returns rolled-up totals computed in SQL so we don't ship every invoice.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    // Read precomputed invoice totals (kept in sync by the
    // invoices_total_trg BEFORE-trigger in schema.js). Before this
    // column existed, the dashboard expanded jsonb_array_elements
    // over every invoice on every page load — sub-second at 100
    // invoices, multi-second at 10K. Now it's a straight SUM over
    // the indexed (workspace_id, status) and (workspace_id, paid_at)
    // partial indexes.
    //
    // Tolerate partial schema: if the column or table isn't there
    // yet (cold install before migrations apply), return zeros
    // instead of bricking the Finance tile.
    let rows;
    try { ({ rows } = await sql`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'paid'                   THEN total END), 0)::numeric AS total_paid,
        COALESCE(SUM(CASE WHEN status IN ('sent','overdue')      THEN total END), 0)::numeric AS total_outstanding,
        COALESCE(SUM(CASE WHEN status = 'overdue'                THEN total END), 0)::numeric AS total_overdue,
        COALESCE(SUM(CASE WHEN status = 'paid'
          AND paid_at >= date_trunc('month', NOW())              THEN total END), 0)::numeric AS month_paid,
        COALESCE(SUM(CASE WHEN status = 'paid'
          AND paid_at >= date_trunc('year', NOW())               THEN total END), 0)::numeric AS year_paid,
        COUNT(*) FILTER (WHERE status = 'draft')                 AS count_draft,
        COUNT(*) FILTER (WHERE status = 'sent')                  AS count_sent,
        COUNT(*) FILTER (WHERE status = 'paid')                  AS count_paid,
        COUNT(*) FILTER (WHERE status = 'overdue')               AS count_overdue,
        COUNT(*) FILTER (WHERE status = 'voided')                AS count_voided
      FROM invoices
      WHERE workspace_id = ${workspaceId}
    `); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[finance GET] summary query failed (returning zeros):', e.message);
      rows = [];
    }
    const r = rows[0] || {};

    return ok(res, {
      summary: {
        totalPaid:        Number(r.total_paid || 0),
        totalOutstanding: Number(r.total_outstanding || 0),
        totalOverdue:     Number(r.total_overdue || 0),
        monthPaid:        Number(r.month_paid || 0),
        yearPaid:         Number(r.year_paid || 0),
        counts: {
          draft:    Number(r.count_draft || 0),
          sent:     Number(r.count_sent || 0),
          paid:     Number(r.count_paid || 0),
          overdue:  Number(r.count_overdue || 0),
          voided:   Number(r.count_voided || 0),
        },
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

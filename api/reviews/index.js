// GET /api/reviews — owner: list every review (visible + hidden) on
// their workspace, plus aggregate stats. Used by the Reviews tab in
// the business app.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeReview } from '../_lib/reviews.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const agg = await sql`
      SELECT COUNT(*)::int AS visible_count,
             AVG(rating) FILTER (WHERE status = 'visible')::numeric AS avg,
             COUNT(*) FILTER (WHERE status = 'hidden')::int AS hidden_count,
             COUNT(*) FILTER (WHERE rating <= 2 AND status = 'visible')::int AS critical
      FROM reviews WHERE workspace_id = ${workspaceId}
    `;
    const { rows } = await sql`
      SELECT * FROM reviews WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
      LIMIT 200
    `;
    return ok(res, {
      summary: {
        visibleCount: agg.rows[0]?.visible_count || 0,
        hiddenCount:  agg.rows[0]?.hidden_count  || 0,
        avg:          agg.rows[0]?.avg != null ? Number(agg.rows[0].avg) : null,
        critical:     agg.rows[0]?.critical || 0,
      },
      reviews: rows.map((r) => serializeReview(r, { includeHidden: true, includeBookingId: true })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

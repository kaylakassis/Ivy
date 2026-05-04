// GET /api/businesses/:slug/reviews
// Public, no auth — same surface that any signed-in client could see
// when browsing Discover or the public booking page.
//
// Returns the workspace's visible reviews + aggregate (count, avg).
// Hidden reviews are excluded from both list and aggregate.
import { sql } from '../../_lib/db.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { serializeReview } from '../../_lib/reviews.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `reviews-public:ip:${ip}`, max: 240, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const slug = (req.query.slug || '').toString().toLowerCase();
    if (!slug) return notFound(res);

    const cs = await sql`
      SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}
    `;
    if (cs.rows.length === 0) return notFound(res, 'Business not found');
    const workspaceId = cs.rows[0].workspace_id;

    // Aggregate first so even an empty list page can show "0 reviews".
    const agg = await sql`
      SELECT COUNT(*)::int AS count, AVG(rating)::numeric AS avg
      FROM reviews WHERE workspace_id = ${workspaceId} AND status = 'visible'
    `;
    const { rows } = await sql`
      SELECT * FROM reviews
      WHERE workspace_id = ${workspaceId} AND status = 'visible'
      ORDER BY created_at DESC
      LIMIT 100
    `;

    return ok(res, {
      summary: {
        count: agg.rows[0]?.count || 0,
        avg:   agg.rows[0]?.avg != null ? Number(agg.rows[0].avg) : null,
      },
      reviews: rows.map((r) => serializeReview(r)),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

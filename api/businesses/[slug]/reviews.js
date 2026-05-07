// GET  /api/businesses/:slug/reviews — public list of visible reviews +
//                                       aggregate. Same surface anyone
//                                       browsing the public booking page
//                                       can read.
// POST /api/businesses/:slug/reviews — signed-in client posts a new
//                                       review. Eligibility: must have
//                                       at least one booking OR one
//                                       message thread tied to the
//                                       business. Enforced via
//                                       UNIQUE INDEX (workspace_id,
//                                       reviewer_user_id) to prevent
//                                       spam (one review per user per
//                                       business).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { serializeReview } from '../../_lib/reviews.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method === 'GET')  return getReviews(req, res);
  if (req.method === 'POST') return createReview(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function getReviews(req, res) {
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

async function createReview(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      // Per-user: 5/day total across all workspaces (caps spam-account
      // attacks even before the per-workspace UNIQUE bites).
      { key: `review-post:user:${user.id}`, max: 5, windowSeconds: 60 * 60 * 24 },
      { key: `review-post:ip:${ip}`,        max: 20, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const slug = (req.query.slug || '').toString().toLowerCase();
    if (!slug) return notFound(res);

    const cs = await sql`
      SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}
    `;
    if (cs.rows.length === 0) return notFound(res, 'Business not found');
    const workspaceId = cs.rows[0].workspace_id;

    const body = await readBody(req);
    const rating = Number(body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return badRequest(res, 'Rating must be an integer 1-5');
    }
    const text = (body?.text || '').toString().trim().slice(0, 2000);

    // Find this user's clients row(s) on the workspace — match by linked
    // user_id or email. The reviewer is "verified" only if at least one
    // such client exists AND has booked OR messaged this workspace.
    const clientRows = await sql`
      SELECT id FROM clients
      WHERE workspace_id = ${workspaceId}
        AND (user_id = ${user.id} OR LOWER(email) = LOWER(${user.email}))
    `;
    const clientIds = clientRows.rows.map((r) => r.id);
    if (clientIds.length === 0) {
      return badRequest(res, "You can review a business after you've booked or messaged them.");
    }

    const bookingHit = await sql`
      SELECT 1 FROM bookings
      WHERE workspace_id = ${workspaceId} AND client_id = ANY(${clientIds})
      LIMIT 1
    `;
    const threadHit = await sql`
      SELECT 1 FROM message_threads
      WHERE workspace_id = ${workspaceId} AND client_id = ANY(${clientIds})
      LIMIT 1
    `;
    if (bookingHit.rows.length === 0 && threadHit.rows.length === 0) {
      return badRequest(res, "You can review a business after you've booked or messaged them.");
    }

    // Insert. The UNIQUE INDEX on (workspace_id, reviewer_user_id) WHERE
    // reviewer_user_id IS NOT NULL surfaces "already reviewed" as a
    // 23505 violation — translate to a friendly 400.
    const reviewerName = (user.name || user.email?.split('@')[0] || 'Verified client').slice(0, 80);
    let inserted;
    try {
      inserted = await sql`
        INSERT INTO reviews (
          workspace_id, client_id, reviewer_user_id, reviewer_name,
          rating, text, status
        ) VALUES (
          ${workspaceId}, ${clientIds[0]}, ${user.id}, ${reviewerName},
          ${rating}, ${text || null}, 'visible'
        )
        RETURNING *
      `;
    } catch (e) {
      if (e?.code === '23505' || /unique/i.test(e?.message || '')) {
        return badRequest(res, "You've already reviewed this business.");
      }
      throw e;
    }

    return created(res, { review: serializeReview(inserted.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

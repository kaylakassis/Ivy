// PATCH /api/reviews/:id — owner moderation actions on a single review.
//   body { status?: 'visible' | 'hidden', ownerResponse?: string | null }
//
// Hide takes the review out of the public list + average. Owner response
// shows up underneath the review on the public page (one per review;
// posting again replaces).
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeReview } from '../_lib/reviews.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const VALID_STATUS = new Set(['visible', 'hidden']);

export default async function handler(req, res) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const body = await readBody(req);

    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

    if ('status' in body) {
      if (!VALID_STATUS.has(body.status)) return badRequest(res, 'status must be visible or hidden');
      push('status', body.status);
    }
    if ('ownerResponse' in body) {
      const t = body.ownerResponse == null ? null : String(body.ownerResponse).trim().slice(0, 2000);
      push('owner_response', t || null);
      push('owner_responded_at', t ? new Date() : null);
    }

    if (sets.length === 0) {
      const cur = await sql`SELECT * FROM reviews WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (cur.rows.length === 0) return notFound(res, 'Review not found');
      return ok(res, { review: serializeReview(cur.rows[0], { includeHidden: true, includeBookingId: true }) });
    }

    values.push(id, workspaceId);
    const query = `
      UPDATE reviews SET ${sets.join(', ')}
      WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
      RETURNING *
    `;
    const { rows } = await sql.query(query, values);
    if (rows.length === 0) return notFound(res, 'Review not found');
    return ok(res, { review: serializeReview(rows[0], { includeHidden: true, includeBookingId: true }) });
  } catch (err) {
    return serverError(res, err);
  }
}

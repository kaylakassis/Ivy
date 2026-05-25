// PATCH /api/reviews/:id — owner actions on a single review.
//   body { ownerResponse?: string | null, appealReason?: string }
//
// Reviews auto-publish, so owners CANNOT hide/publish them. They can:
//   • respond publicly (owner_response shows under the review), and
//   • appeal a review for removal — that flags it for the support team
//     (super-admin) to approve (hide) or deny. The review stays visible
//     until an appeal is approved.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeReview } from '../_lib/reviews.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

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

    if ('ownerResponse' in body) {
      const t = body.ownerResponse == null ? null : String(body.ownerResponse).trim().slice(0, 2000);
      push('owner_response', t || null);
      push('owner_responded_at', t ? new Date() : null);
    }
    if ('appealReason' in body) {
      // File (or re-file) an appeal. Block if one is already open or was
      // already approved — owners get one bite per review until support acts.
      const cur = await sql`SELECT appeal_status FROM reviews WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (cur.rows.length === 0) return notFound(res, 'Review not found');
      const cs = cur.rows[0].appeal_status || 'none';
      if (cs === 'requested') return badRequest(res, 'An appeal for this review is already under review.');
      if (cs === 'approved') return badRequest(res, 'This review has already been removed.');
      const reason = String(body.appealReason || '').trim().slice(0, 1000);
      if (!reason) return badRequest(res, 'Please include a reason for the appeal.');
      push('appeal_status', 'requested');
      push('appeal_reason', reason);
      push('appeal_requested_at', new Date());
      push('appeal_resolved_at', null);
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

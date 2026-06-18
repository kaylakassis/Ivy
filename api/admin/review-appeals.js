// Super-admin review-appeal queue.
//   GET  → all reviews with an open appeal (appeal_status='requested'),
//          newest first, with the business name + review details.
//   POST { reviewId, action: 'approve' | 'deny' }
//          • approve → hide the review (removes it from public) + mark
//            the appeal approved.
//          • deny    → leave the review visible + mark the appeal denied.
//
// "Support team" = super-admin (gated by SUPER_ADMIN_EMAIL / user_type /
// x-admin-secret). Owners file appeals from their Reviews tab; they can
// never hide a review themselves.
import { sql } from '../_lib/db.js';
import { readSession } from '../_lib/auth.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

function adminIdFromSession(req) {
  const s = readSession(req);
  if (!s?.sub) return null;
  return typeof s.sub === 'string' ? s.sub : (s.sub.id || null);
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT r.id, r.workspace_id, r.rating, r.text, r.reviewer_name,
               r.appeal_reason, r.appeal_requested_at, r.created_at,
               cs.biz_name
          FROM reviews r
          LEFT JOIN calendar_settings cs ON cs.workspace_id = r.workspace_id
         WHERE r.appeal_status = 'requested'
         ORDER BY r.appeal_requested_at ASC NULLS LAST
         LIMIT 200
      `;
      return ok(res, {
        appeals: rows.map((r) => ({
          id:            r.id,
          workspaceId:   r.workspace_id,
          businessName:  r.biz_name || '(unnamed business)',
          rating:        Number(r.rating),
          text:          r.text || '',
          reviewerName:  r.reviewer_name || 'Anonymous',
          appealReason:  r.appeal_reason || '',
          appealRequestedAt: r.appeal_requested_at,
          createdAt:     r.created_at,
        })),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const reviewId = (body.reviewId || '').toString();
      const action = (body.action || '').toString();
      if (!reviewId) return badRequest(res, 'reviewId is required');
      if (action !== 'approve' && action !== 'deny') {
        return badRequest(res, "action must be 'approve' or 'deny'");
      }
      const adminId = adminIdFromSession(req);

      // Only act on reviews with an OPEN appeal - guards against double-resolve.
      const newStatus = action === 'approve' ? 'hidden' : null; // deny leaves status untouched
      const newAppeal = action === 'approve' ? 'approved' : 'denied';
      const { rows } = await sql`
        UPDATE reviews SET
          appeal_status      = ${newAppeal},
          appeal_resolved_at = NOW(),
          appeal_resolved_by = ${adminId},
          status             = COALESCE(${newStatus}, status)
        WHERE id = ${reviewId} AND appeal_status = 'requested'
        RETURNING id, status, appeal_status
      `;
      if (rows.length === 0) return notFound(res, 'No open appeal for that review');
      return ok(res, { resolved: rows[0] });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

// GET /api/admin/exit-answers?days=30|90|365  (operator only)
//
// Why owners left: how many were asked and answered, each reason's share,
// and the answers themselves (reasons, comment, how long they were with
// Ivy). See api/_lib/exitInterview.js.
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { exitSummary } from '../_lib/exitInterview.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    res.setHeader?.('Cache-Control', 'no-store');
    return ok(res, await exitSummary({ days: Number(req.query?.days) || 90 }));
  } catch (err) {
    return serverError(res, err);
  }
}

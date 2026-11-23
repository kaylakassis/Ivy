// GET /api/admin/first-week?days=30|60|90  (operator only)
//
// Where new accounts stop: for businesses that signed up in the window, how
// many reached each screen in their first seven days, how many days they
// came back, and the last screen seen by the ones who went quiet. Counts
// only; no account is named. See api/_lib/screenVisits.js.
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { firstWeekReport } from '../_lib/screenVisits.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    res.setHeader?.('Cache-Control', 'no-store');
    return ok(res, await firstWeekReport({ days: Number(req.query?.days) || 30 }));
  } catch (err) {
    return serverError(res, err);
  }
}

// GET /api/admin/accountability-partner - is the accountability partner
// working? Super-admins only (requireSuperAdmin). Counts and dates only:
// no names, emails, ids or message text (api/_lib/partnerStats.js says
// where every number comes from).
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { partnerStats } from '../_lib/partnerStats.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    res.setHeader?.('Cache-Control', 'no-store');
    return ok(res, await partnerStats());
  } catch (err) {
    return serverError(res, err);
  }
}

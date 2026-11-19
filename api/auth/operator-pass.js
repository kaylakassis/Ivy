// GET /api/auth/operator-pass
//
// Called by the app just before it loads the Admin screen. For an operator
// it sets the pass cookie that lets their browser download that screen's
// code (api/_lib/operatorPass.js) and answers 204. For anyone else it
// answers exactly like a page that does not exist.
import { requireSameOrigin } from '../_lib/security.js';
import { requireUser } from '../_lib/auth.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { setOperatorPass } from '../_lib/operatorPass.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return undefined;
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.setHeader('Cache-Control', 'no-store');
    const operator = user.user_type === 'super_admin' || emailIsSuperAdmin(user.email);
    if (!operator || !setOperatorPass(res, user.id)) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (err) {
    return serverError(res, err);
  }
}

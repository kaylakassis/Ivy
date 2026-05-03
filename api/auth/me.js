// GET /api/auth/me — returns the current user or 401.
import { requireUser } from '../_lib/auth.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return; // requireUser already responded
    return ok(res, {
      user: { ...user, isSuperAdmin: emailIsSuperAdmin(user.email) },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

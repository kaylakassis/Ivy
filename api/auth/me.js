// GET /api/auth/me — returns the current user or 401.
import { sql } from '../_lib/db.js';
import { requireUser, readSession } from '../_lib/auth.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return; // requireUser already responded

    // Surface impersonation state to the frontend so it can show a
    // "you're viewing as X — stop" banner and post to the stop endpoint.
    const session = readSession(req);
    let impersonating = null;
    if (session?.imp) {
      const ar = await sql`SELECT email FROM users WHERE id = ${session.imp}`;
      impersonating = {
        actorEmail: ar.rows[0]?.email || null,
        targetEmail: user.email,
      };
    }

    return ok(res, {
      user: { ...user, isSuperAdmin: emailIsSuperAdmin(user.email) },
      impersonating,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

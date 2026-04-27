// POST /api/auth/login  { email, password }
import { sql } from '../_lib/db.js';
import { verifyPassword, signSession, setSessionCookie, validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { email, password } = await readBody(req);
    if (!validEmail(email) || typeof password !== 'string') {
      return badRequest(res, 'Invalid credentials');
    }
    const { rows } = await sql`
      SELECT id, email, name, password_hash, created_at
      FROM users WHERE email = ${email.toLowerCase()}
    `;
    if (rows.length === 0) return unauthorized(res, 'Invalid email or password');
    const user = rows[0];
    const okPw = await verifyPassword(password, user.password_hash);
    if (!okPw) return unauthorized(res, 'Invalid email or password');

    setSessionCookie(res, signSession(user.id));
    const { password_hash, ...safe } = user;
    return ok(res, { user: safe });
  } catch (err) {
    return serverError(res, err);
  }
}

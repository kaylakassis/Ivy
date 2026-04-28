// POST /api/auth/signup  { email, password, name? }
import { sql } from '../_lib/db.js';
import { hashPassword, signSession, setSessionCookie, validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { email, password, name } = await readBody(req);
    if (!validEmail(email)) return badRequest(res, 'Invalid email');
    if (typeof password !== 'string' || password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters');
    }

    // Tighter than login: signup is more abusable (creates new accounts).
    // 5/10min per IP — enough for typos but not for spam farms.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `signup:ip:${ip}`, max: 5, windowSeconds: 10 * 60 },
    ]);
    if (blocked) return;

    const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (existing.rows.length > 0) return badRequest(res, 'Email already in use');

    const password_hash = await hashPassword(password);
    const insertUser = await sql`
      INSERT INTO users (email, password_hash, name)
      VALUES (${email.toLowerCase()}, ${password_hash}, ${name || null})
      RETURNING id, email, name, created_at
    `;
    const user = insertUser.rows[0];
    await sql`INSERT INTO workspaces (owner_id) VALUES (${user.id})`;

    setSessionCookie(res, signSession(user.id));
    return created(res, { user });
  } catch (err) {
    return serverError(res, err);
  }
}

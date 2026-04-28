// POST /api/auth/verify-email  { token }
// Marks the user's email_verified_at and burns the token.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { findValidToken, consumeToken, KIND_VERIFY } from '../_lib/tokens.js';
import { methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { token } = await readBody(req);
    const valid = await findValidToken({ kind: KIND_VERIFY, raw: token });
    if (!valid) return unauthorized(res, 'This verification link is invalid or has expired');

    await sql`
      UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW())
      WHERE id = ${valid.userId}
    `;
    await consumeToken(valid.tokenId);

    const { rows } = await sql`
      SELECT id, email, name, created_at, email_verified_at
      FROM users WHERE id = ${valid.userId}
    `;
    return ok(res, { user: rows[0] });
  } catch (err) {
    return serverError(res, err);
  }
}

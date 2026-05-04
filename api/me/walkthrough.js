// POST /api/me/walkthrough  body: { completed?: true, reset?: true }
//
// Owners (or anyone) can dismiss the in-app walkthrough or replay it
// from the Account page. Two flags:
//   completed: true  → stamp walkthrough_completed_at = NOW()
//   reset: true      → null it back out so AppShell auto-shows on next
//                       render
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (body.reset) {
      await sql`UPDATE users SET walkthrough_completed_at = NULL WHERE id = ${user.id}`;
      return ok(res, { walkthroughCompletedAt: null });
    }
    if (body.completed) {
      const r = await sql`
        UPDATE users SET walkthrough_completed_at = NOW()
        WHERE id = ${user.id}
        RETURNING walkthrough_completed_at
      `;
      return ok(res, { walkthroughCompletedAt: r.rows[0]?.walkthrough_completed_at });
    }
    return badRequest(res, 'Pass { completed: true } or { reset: true }');
  } catch (err) {
    return serverError(res, err);
  }
}

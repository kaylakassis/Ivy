// POST /api/push/unsubscribe   body: { endpoint }
// Removes a push subscription for the signed-in user. Called when the
// browser revokes permission or the user toggles "Disable notifications".
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
    const endpoint = body.endpoint ? String(body.endpoint) : null;
    if (!endpoint) return badRequest(res, 'endpoint is required');
    await sql`
      DELETE FROM push_subscriptions
      WHERE user_id = ${user.id} AND endpoint = ${endpoint}
    `;
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}

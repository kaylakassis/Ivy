// GET /api/auth/username-available?u=handle   (public)
// Live check for the sign-up form. Answers { available, value } or, for a
// badly formed handle, { available: false, error }. Never says who holds
// a taken handle. Lightly rate-limited so it can't be used to enumerate.
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { validateUsername, usernameTaken } from '../_lib/username.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    if (await enforce(req, res, [{ key: `uname-check:ip:${getClientIp(req)}`, max: 120, windowSeconds: 60 }])) return;
    try { await ensureSchemaApplied(); } catch { /* tolerate */ }
    const check = validateUsername(req.query.u);
    if (!check.ok) return ok(res, { available: false, error: check.error });
    const taken = await usernameTaken(check.value);
    return ok(res, { available: !taken, value: check.value, ...(taken ? { error: 'That username is taken' } : {}) });
  } catch (err) {
    return serverError(res, err);
  }
}

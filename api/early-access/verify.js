// POST /api/early-access/verify  { password: "..." }
//
// Public, rate-limited. Verifies the gate password and sets the
// ea_pass cookie on success. The cookie is HMAC-signed against the
// current password hash, so rotating the password invalidates every
// previously-issued unlock automatically.
//
// Returns:
//   200 { unlocked: true }         on success or gate-off
//   401 { error: 'Bad password' }  on miss
//   400 { error: ... }             on validation failures
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { attemptUnlock, setGateCookie } from '../_lib/earlyAccess.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    // Heavy rate limit — the gate password is a single global secret.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `ea-verify:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
      { key: 'ea-verify:global',   max: 200, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const password = body.password ? String(body.password) : '';
    if (!password) return badRequest(res, 'Password required');
    if (password.length > 200) return badRequest(res, 'Password too long');

    const result = await attemptUnlock(password);
    if (!result.ok) {
      if (result.reason === 'no_password_set') {
        return badRequest(res, 'The gate is enabled but no password has been set yet. Contact the operator.');
      }
      // Tiny jitter on miss to discourage timing-based enumeration —
      // bcrypt is already constant-time but request-level timing can
      // leak when the early reject paths are short.
      await new Promise((r) => setTimeout(r, 250));
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Wrong password' }));
    }

    if (result.cookieValue) setGateCookie(res, result.cookieValue);
    return ok(res, { unlocked: true });
  } catch (err) {
    return serverError(res, err);
  }
}

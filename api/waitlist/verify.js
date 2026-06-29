// POST /api/waitlist/verify  { password: "..." }
//
// Beta-tester bypass for waitlist mode. Validates the configured bypass
// password (the early-access password hash) and, on success, sets the
// ea_pass cookie so this session can sign up normally despite the
// waitlist. Mirrors /api/early-access/verify but uses attemptBypass,
// which works regardless of whether the standalone early-access gate is
// toggled on (in waitlist mode it usually isn't).
//
// Returns:
//   200 { unlocked: true }         on success
//   401 { error: 'Wrong password' } on miss
//   400 { error: ... }             on validation failures
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { attemptBypass, setGateCookie } from '../_lib/earlyAccess.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    // Heavy rate limit - the bypass password is a single shared secret.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `wl-verify:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
      { key: 'wl-verify:global',   max: 200, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const password = body.password ? String(body.password) : '';
    if (!password) return badRequest(res, 'Password required');
    if (password.length > 200) return badRequest(res, 'Password too long');

    const result = await attemptBypass(password);
    if (!result.ok) {
      if (result.reason === 'no_password_set') {
        return badRequest(res, 'No beta access password has been set yet. Contact the operator.');
      }
      // Tiny jitter on miss to blunt request-level timing enumeration.
      await new Promise((r) => setTimeout(r, 250));
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Wrong password' }));
    }

    setGateCookie(res, result.cookieValue);
    return ok(res, { unlocked: true });
  } catch (err) {
    return serverError(res, err);
  }
}

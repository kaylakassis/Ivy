// POST /api/auth/login  { email, password }
import bcrypt from 'bcryptjs';
import { sql, warmupDb, isConnectionError } from '../_lib/db.js';
import { verifyPassword, signSession, setSessionCookie, validEmail, isNativeClient } from '../_lib/auth.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireGate } from '../_lib/earlyAccess.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError, serviceUnavailable, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { maybeNotifyNewSignIn } from '../_lib/securityNotify.js';

// Decoy bcrypt hash for constant-time email-enumeration defense. When
// the email doesn't exist we still run bcrypt.compare() against this
// so the response time matches the "user found, wrong password" path.
// Without it, attackers can distinguish "registered" vs "not registered"
// addresses by latency even with a generic error message.
//
// Hashed once at module load - one ~100ms cost per cold lambda, then
// the same comparison cost as real logins on subsequent requests. Cost
// factor 10 matches hashPassword() in api/_lib/auth.js so timing aligns.
const DECOY_PASSWORD_HASH = bcrypt.hashSync('ivy-decoy-not-a-real-password', 10);

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  // Temporary early-access gate: blocks login when the operator has
  // turned it on in /admin → Settings. Visitor must POST the gate
  // password to /api/early-access/verify first (sets ea_pass cookie).
  if (!(await requireGate(req, res))) return;
  try {
    // Wake the database before doing anything else. A suspended /
    // scaled-to-zero Neon instance (or a transient blip) would otherwise
    // make the SELECT below throw and hard-500 the login. warmupDb retries
    // a quick `SELECT 1` to wake it; if it's genuinely down it throws a
    // `dbUnavailable`-tagged error, which we answer with a retryable 503
    // instead of a confusing 500.
    await warmupDb();
    // Cold-started function with no schema yet would 500 the SELECT
    // below. Bootstrap explicitly - login is a public endpoint that
    // doesn't call requireUser.
    await ensureSchemaApplied();
    const { email, password } = await readBody(req);
    if (!validEmail(email) || typeof password !== 'string') {
      return badRequest(res, 'Invalid credentials');
    }
    const ip = getClientIp(req);
    const emailKey = email.toLowerCase();

    // 10/hr per IP and 5/hr per email - same window so an attacker can't burn
    // through accounts from one IP, and a victim can't be locked out forever
    // by a distributed attack on their email.
    const blocked = await enforce(req, res, [
      { key: `login:ip:${ip}`,        max: 10, windowSeconds: 60 * 60 },
      { key: `login:email:${emailKey}`, max:  5, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const { rows } = await sql`
      SELECT id, email, name, password_hash, created_at, email_verified_at, user_type
      FROM users WHERE email = ${emailKey}
    `;
    // Always run a bcrypt compare so the timing of the no-user branch
    // matches the wrong-password branch. Otherwise an attacker can
    // distinguish registered vs unregistered emails from response
    // latency (no-user returns in ~5ms, wrong-password in ~100ms).
    if (rows.length === 0) {
      await verifyPassword(password, DECOY_PASSWORD_HASH);
      recordAudit(req, { action: 'auth.login_fail', meta: { email: emailKey, reason: 'no_user' } });
      return unauthorized(res, 'Invalid email or password');
    }
    const user = rows[0];
    const okPw = await verifyPassword(password, user.password_hash);
    if (!okPw) {
      recordAudit(req, { actor: user, action: 'auth.login_fail', meta: { email: emailKey, reason: 'bad_password' } });
      return unauthorized(res, 'Invalid email or password');
    }

    const token = signSession(user.id);
    setSessionCookie(res, token);
    // Stamp last login for the admin Users view. Awaited (a single cheap
    // UPDATE) so it reliably commits before the serverless function freezes,
    // but wrapped so a write hiccup never blocks a successful sign-in.
    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}`
      .catch((e) => console.warn('[login] last_login_at stamp failed:', e.message));
    // Security alert on a sign-in from a device we haven't seen before.
    // Fire-and-forget (like recordAudit) so it never slows or breaks login;
    // the helper seeds a silent baseline on the first tracked sign-in.
    maybeNotifyNewSignIn({ userId: user.id, ip, userAgent: req.headers['user-agent'] });
    recordAudit(req, { actor: user, action: 'auth.login', meta: {} });
    // Decorate the user payload with isSuperAdmin so the sidebar /
    // bottom-nav / command-palette show the Admin tab on first paint.
    // /api/auth/me also adds this on subsequent loads; doing it here
    // avoids the "refresh once and Admin appears" papercut.
    const { password_hash, ...safe } = user;
    const payload = {
      user: { ...safe, isSuperAdmin: emailIsSuperAdmin(safe.email) || safe.user_type === 'super_admin' },
    };
    // Native shells (iOS/Android) can't read the HttpOnly cookie across
    // the WebView↔API origin gap. Return the raw JWT so they can stash
    // it in Keychain and replay it as `Authorization: Bearer …`.
    if (isNativeClient(req)) payload.token = token;
    return ok(res, payload);
  } catch (err) {
    // DB unreachable (asleep/over-limit/connectivity) → retryable 503,
    // not a 500. Covers both the warmup's tagged error and a connection
    // that drops mid-request after warmup.
    if (isConnectionError(err)) return serviceUnavailable(res);
    return serverError(res, err);
  }
}

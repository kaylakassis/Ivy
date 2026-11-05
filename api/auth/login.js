// POST /api/auth/login  { email, password }
import bcrypt from 'bcryptjs';
import { sql, warmupDb, isConnectionError } from '../_lib/db.js';
import { verifyPassword, signSession, setSessionCookie, validEmail, isNativeClient, normalizeAccountEmail } from '../_lib/auth.js';
import { beginMfaStep, hasTwoStep } from '../_lib/mfaEmail.js';
import { emailIsSuperAdmin } from '../_lib/admin.js';
import { readBody } from '../_lib/body.js';
import { countRecent, recordAttempt, clearRateLimit, isAdminBypass, getClientIp } from '../_lib/rate-limit.js';
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

const LOCK_MAX_FAILURES = 5;        // per email + IP: hard lock
const IP_MAX_FAILURES = 20;         // per IP across any emails: hard lock
const EMAIL_SOFT_FAILURES = 10;     // per email across any IPs: slow down only
const SOFT_DELAY_MS = 2000;
const LOCK_WINDOW_SECONDS = 60 * 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 with a message that says how long is left on the lock. The lock
// lasts 60 minutes from the OLDEST failure still in the window, so it
// counts down rather than restarting on every retry.
function lockedOut(res, oldestAt) {
  const remainingSec = Math.max(60, Math.ceil(((oldestAt || Date.now()) + LOCK_WINDOW_SECONDS * 1000 - Date.now()) / 1000));
  const mins = Math.ceil(remainingSec / 60);
  res.setHeader('Retry-After', String(remainingSec));
  return res.status(429).json({
    error: mins >= 60
      ? 'Too many failed attempts. This account is locked for 60 minutes.'
      : `Too many failed attempts. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`,
    locked: true,
    retryAfterSeconds: remainingSec,
  });
}

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
    // Any capitals or stray spaces sign in to the same account.
    const emailKey = normalizeAccountEmail(email);
    if (!validEmail(emailKey) || typeof password !== 'string') {
      return badRequest(res, 'Invalid credentials');
    }
    const ip = getClientIp(req);

    // Lockout counts FAILED attempts only. Five wrong passwords for an
    // email FROM ONE IP lock that pair for 60 minutes; each miss tells the
    // person how many attempts remain. A correct sign-in never counts.
    // The hard lock is keyed on email + IP so a stranger who knows an
    // owner's address cannot lock her out of her own account by spraying
    // wrong passwords from elsewhere. The per-IP ceiling (20 failures/hour
    // across any emails) stops one machine from spraying guesses at many
    // accounts. A per-email counter across ALL IPs is kept as a soft
    // measure only: past 10 failures/hour the request is slowed by two
    // seconds, never locked.
    const emailIpFailKey = `login:fail:${emailKey}:${ip}`;
    const emailFailKey = `login:fail:${emailKey}`;
    const ipFailKey = `login:ipfail:${ip}`;
    const bypass = await isAdminBypass(req);
    let pairFails = { count: 0, oldestAt: null };
    if (!bypass) {
      pairFails = await countRecent(emailIpFailKey, LOCK_WINDOW_SECONDS);
      if (pairFails.count >= LOCK_MAX_FAILURES) return lockedOut(res, pairFails.oldestAt);
      const ipFails = await countRecent(ipFailKey, LOCK_WINDOW_SECONDS);
      if (ipFails.count >= IP_MAX_FAILURES) return lockedOut(res, ipFails.oldestAt);
      const emailFails = await countRecent(emailFailKey, LOCK_WINDOW_SECONDS);
      if (emailFails.count >= EMAIL_SOFT_FAILURES) await sleep(SOFT_DELAY_MS);
    }
    // One wrong attempt: record it, then tell them how many remain.
    const miss = async () => {
      if (bypass) return unauthorized(res, 'Invalid email or password');
      await recordAttempt(emailIpFailKey);
      await recordAttempt(emailFailKey);
      await recordAttempt(ipFailKey);
      const left = Math.max(0, LOCK_MAX_FAILURES - (pairFails.count + 1));
      if (left === 0) return lockedOut(res, Date.now());
      return res.status(401).json({
        error: `Invalid email or password. ${left} attempt${left === 1 ? '' : 's'} left before this account is locked for 60 minutes.`,
        attemptsLeft: left,
      });
    };

    const { rows } = await sql`
      SELECT id, email, name, password_hash, created_at, email_verified_at, user_type, totp_enrolled_at,
             mfa_email_enabled_at
      FROM users WHERE LOWER(email) = ${emailKey}
      -- Only a pre-fix database can hold two case variants of one address
      -- (the ops alert flags them); prefer the exact, oldest row.
      ORDER BY (email = ${emailKey}) DESC, deleted_at IS NOT NULL, created_at ASC
      LIMIT 1
    `;
    // Always run a bcrypt compare so the timing of the no-user branch
    // matches the wrong-password branch. Otherwise an attacker can
    // distinguish registered vs unregistered emails from response
    // latency (no-user returns in ~5ms, wrong-password in ~100ms).
    if (rows.length === 0) {
      await verifyPassword(password, DECOY_PASSWORD_HASH);
      recordAudit(req, { action: 'auth.login_fail', meta: { email: emailKey, reason: 'no_user' } });
      return miss();
    }
    const user = rows[0];
    const okPw = await verifyPassword(password, user.password_hash);
    if (!okPw) {
      recordAudit(req, { actor: user, action: 'auth.login_fail', meta: { email: emailKey, reason: 'bad_password' } });
      return miss();
    }
    // Right password: the slate is clean again.
    await clearRateLimit(emailIpFailKey);
    await clearRateLimit(emailFailKey);

    // 2-step gate (every account type: owner, client portal, helper): if this
    // user has an authenticator app or email codes on, DON'T issue a session
    // yet. Hand back a short-lived MFA-pending token; they must clear
    // /api/auth/totp/challenge with an app, email or backup code before they
    // get a real session. (readSession refuses the mfa-pending token as a
    // session, so it can't be replayed to bypass this.) Email-only accounts
    // get their first code sent here.
    if (hasTwoStep(user)) {
      const out = await beginMfaStep(req, res, user);
      recordAudit(req, { actor: user, action: 'auth.mfa_required', meta: { methods: out.mfaMethods } });
      return ok(res, out);
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

// POST /api/auth/verify-email  { token }
// Marks the user's email_verified_at and burns the token.
//
// Idempotent - email security scanners (Gmail / Outlook / Apple Mail
// link-preview) often prefetch the link and trigger one verification
// silently. If a SECOND click finds the token already consumed but the
// user IS verified, we return 200 instead of 401 so the user doesn't
// see "this link is invalid" after a successful first hit.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { findValidToken, consumeToken, KIND_VERIFY } from '../_lib/tokens.js';
import { invalidateUserCache, signSession, setSessionCookie, isNativeClient } from '../_lib/auth.js';
import { readSignupTicket } from '../_lib/signupTicket.js';
import { clearRateLimit } from '../_lib/rate-limit.js';
import { sendEmail } from '../_lib/email.js';
import { renderWelcome } from '../_lib/welcome-content.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';
import { claimSignupPerks } from '../_lib/signupPerks.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    // Heavy per-IP cap. Token guessing is the abuse vector - without
    // a limit, a bot can iterate through token-space looking for
    // bad-token oracle behavior. 30/hr/IP is generous for any
    // real user (they typically click the link 1-3 times).
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `verify-email:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const { token, ticket } = await readBody(req);
    const valid = await findValidToken({ kind: KIND_VERIFY, raw: token });
    if (!valid) return unauthorized(res, 'This verification link is invalid or has expired');

    // Read the user row regardless of whether the token's been used yet.
    const { rows } = await sql`
      SELECT id, email, name, created_at, email_verified_at, confirm_required, signup_role
      FROM users WHERE id = ${valid.userId}
    `;
    const user = rows[0];
    // A confirm-first sign-up being finished by this link.
    const finishing = !!user?.confirm_required && !user.email_verified_at;
    if (user) { delete user.confirm_required; delete user.signup_role; }
    const role = rows[0]?.signup_role === 'client' ? 'client' : 'owner';
    if (!user) return unauthorized(res, 'This verification link is invalid or has expired');

    if (valid.alreadyUsed) {
      // Idempotent path. If the user is already verified, this is just
      // a duplicate click - return success. If they're somehow NOT
      // verified (token used but user.email_verified_at is still null -
      // shouldn't happen but worth handling), we don't trust the stale
      // token and reject. The user can sign in and hit "Resend".
      if (user.email_verified_at) {
        // Retry the perk claim (idempotent) in case the first click's
        // claim hit a blip: the address is proven either way.
        await claimSignupPerks(user.id);
        // Mail scanners open links before people do. If that is what used
        // this one, the browser that made the sign-up (it holds the
        // ticket) is still signed straight in when the person taps it.
        if (readSignupTicket(ticket) === user.id) {
          const sessionToken = signSession(user.id);
          setSessionCookie(res, sessionToken);
          const out = { user, alreadyVerified: true, confirmed: true, signedIn: true };
          if (isNativeClient(req)) out.token = sessionToken;
          return ok(res, out);
        }
        return ok(res, { user, alreadyVerified: true });
      }
      return unauthorized(res, 'This verification link is invalid or has expired');
    }

    await sql`
      UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), confirm_required = FALSE,
                       last_login_at = COALESCE(last_login_at, NOW())
      WHERE id = ${valid.userId}
    `;
    // Bust the cached row so the next authed request sees the verified
    // state immediately — the user just clicked the link and expects
    // the "verify your email" banner to be gone.
    invalidateUserCache(valid.userId);
    await consumeToken(valid.tokenId);
    // The address is now proven: grant what was waiting on it (a comp
    // invite, the waitlist discount). Idempotent and never throws.
    await claimSignupPerks(valid.userId);

    // Re-read so the response carries the freshly-set email_verified_at.
    const refreshed = await sql`
      SELECT id, email, name, created_at, email_verified_at
      FROM users WHERE id = ${valid.userId}
    `;
    if (!finishing) return ok(res, { user: refreshed.rows[0] });

    // The account is now real. Any "wrong password" marks from trying to
    // sign in before the link was opened are forgiven.
    const emailKey = String(refreshed.rows[0].email || '').toLowerCase();
    await clearRateLimit(`login:fail:${emailKey}`);
    await clearRateLimit(`login:fail:${emailKey}:${ip}`);
    // The welcome email was held back until the address was confirmed.
    try {
      const w = renderWelcome({ name: String(user.name || '').trim().split(/\s+/)[0] || null, appUrl: appUrl(), variant: role });
      await sendEmail({ to: refreshed.rows[0].email, subject: w.subject, html: w.html });
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[verify-email] welcome email failed:', mailErr?.message);
    }
    // Signed straight in only on the browser or app that made the sign-up
    // (it holds the ticket). Whoever opens the link anywhere else has
    // proved the inbox, not that they chose the password, so they are
    // asked to sign in: if the password is not theirs, "forgot password"
    // puts the account in their hands alone.
    const sameDevice = readSignupTicket(ticket) === valid.userId;
    if (!sameDevice) return ok(res, { user: { email: refreshed.rows[0].email }, confirmed: true, signedIn: false, role });
    const sessionToken = signSession(valid.userId);
    setSessionCookie(res, sessionToken);
    const payload = { user: refreshed.rows[0], confirmed: true, signedIn: true, role };
    if (isNativeClient(req)) payload.token = sessionToken;
    return ok(res, payload);
  } catch (err) {
    return serverError(res, err);
  }
}

// POST /api/auth/totp/verify   body: { code }
//
// Confirms the user can read codes from their authenticator app.
// Flips users.totp_enrolled_at = NOW(), which is what the login
// flow checks to decide whether to require a TOTP challenge. Until
// this succeeds, enrollment is "pending" and login is NOT gated.
//
// Used in two places:
//   1. End of the enrollment flow (Account -> Security): confirms
//      setup before turning the gate on.
//   2. Re-confirming a code after a backup-code consume (the user
//      can re-enroll a different device).
//
// Rate-limited: 5 attempts per minute per user to slow down a
// brute-force attempt against the 6-digit space (~1M codes).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { decrypt } from '../../_lib/secrets.js';
import { base32Decode, verifyTotp } from '../../_lib/totp.js';
import { enforce } from '../../_lib/rate-limit.js';
import { recordAudit } from '../../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    // 5 attempts / minute / user. A brute-force from a different IP
    // hits this same cap because we key on user, not IP. 1M codes
    // / 5 per minute = 200k minutes ≈ 138 days to exhaust the space
    // even with continuous attack. Acceptable.
    const blocked = await enforce(req, res, [
      { key: `totp:verify:${user.id}`, max: 5, windowSeconds: 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const code = String(body?.code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      return badRequest(res, 'Enter the 6-digit code from your authenticator app.');
    }

    // Pull the pending secret. Reject if enrollment was never
    // initiated (no secret on file).
    const { rows } = await sql`
      SELECT totp_secret_encrypted, totp_enrolled_at
        FROM users WHERE id = ${user.id}
    `;
    const row = rows[0];
    if (!row?.totp_secret_encrypted) {
      return badRequest(res, "Start enrollment first — your secret isn't on file yet.");
    }

    let secretBase32;
    try { secretBase32 = decrypt(row.totp_secret_encrypted); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.error('[totp/verify] decrypt failed for user', user.id, e.message);
      return serverError(res, new Error('Could not read your stored 2FA secret. Re-enroll from Account → Security.'));
    }

    const secretBuf = base32Decode(secretBase32);
    if (!verifyTotp(secretBuf, code, { drift: 1 })) {
      recordAudit(req, {
        actor: user, targetUserId: user.id,
        action: 'totp.verify.failed',
        meta: { reason: 'invalid_code' },
      });
      return badRequest(res, "That code didn't match. Double-check your authenticator and try again.");
    }

    // Flip the enrolled_at switch. From here on, login.js will see
    // a non-null totp_enrolled_at and require the challenge.
    // (Note: the challenge endpoint + login flow change land in a
    // separate commit after enrollment is verified working in prod.)
    const wasEnrolled = !!row.totp_enrolled_at;
    if (!wasEnrolled) {
      await sql`
        UPDATE users SET totp_enrolled_at = NOW(), updated_at = NOW()
         WHERE id = ${user.id}
      `;
    }

    recordAudit(req, {
      actor: user, targetUserId: user.id,
      action: wasEnrolled ? 'totp.verify.success' : 'totp.enroll.completed',
      meta: {},
    });

    return ok(res, {
      ok: true,
      enrolled: true,
      // Echo back the timestamp so the UI can immediately reflect
      // the "2FA active" state without a refetch.
      enrolledAt: new Date().toISOString(),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

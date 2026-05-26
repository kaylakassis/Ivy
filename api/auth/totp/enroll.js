// POST /api/auth/totp/enroll
//
// First half of two-factor setup. Generates + saves a TOTP secret
// (encrypted), generates 10 backup recovery codes (stored hashed),
// and returns everything the owner needs to add THRYVE to their
// authenticator app: the otpauth:// URI (scan as QR via any client-
// side QR lib OR paste into 1Password), the base32 secret (for
// manual entry), and the plaintext backup codes (shown ONCE — the
// frontend must prompt the user to write them down).
//
// Enrollment is two-step: this endpoint provisions the secret;
// /api/auth/totp/verify confirms the user can actually generate a
// valid code from it before flipping enrolled_at = NOW(). Until verify
// succeeds, the login flow is NOT gated by 2FA — so a user who
// abandons the setup midway isn't locked out.
//
// Re-enrolling (calling this again on an already-enrolled account)
// rotates both the secret + backup codes. Useful for "I think someone
// saw my codes" recovery without going through a password reset.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { encrypt } from '../../_lib/secrets.js';
import {
  generateSecret, base32Encode, otpauthUrl,
  generateBackupCodes, hashBackupCode,
} from '../../_lib/totp.js';
import { recordAudit } from '../../_lib/audit.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    // Generate fresh secret + backup codes. The secret is what the
    // authenticator app stores; backup codes are emergency-only
    // single-use recovery for "lost my phone".
    const secret = generateSecret();
    const secretBase32 = base32Encode(secret);
    const backupCodes = generateBackupCodes(10);
    const hashedCodes = backupCodes.map((c) => ({ hash: hashBackupCode(c), used_at: null }));

    // Encrypt the secret at rest. encrypt() returns the ciphertext
    // bundle (iv + authtag + key id + ciphertext). Decryption happens
    // on the verify path + every login.
    const secretEncrypted = encrypt(secretBase32);

    // Save with enrolled_at = NULL (pending). Login gate stays off
    // until verify confirms the user can read codes from their app.
    // We overwrite any existing pending secret so a half-done prior
    // enrollment doesn't leak through.
    await sql`
      UPDATE users SET
        totp_secret_encrypted    = ${secretEncrypted},
        totp_backup_codes_hashed = ${JSON.stringify(hashedCodes)}::jsonb,
        totp_enrolled_at         = NULL,
        updated_at               = NOW()
       WHERE id = ${user.id}
    `;

    // Audit. We don't include the secret or codes here — the audit
    // trail just records that an enrollment was initiated.
    recordAudit(req, {
      actor: user, targetUserId: user.id,
      action: 'totp.enroll.initiated',
      meta: { backup_code_count: backupCodes.length },
    });

    return ok(res, {
      // Display label for the authenticator app — shows up under
      // 'THRYVE:' with the user's email.
      secret: secretBase32,
      otpauth: otpauthUrl({ secretBase32, label: user.email }),
      backupCodes,
      // The frontend MUST surface this prominently — these are the
      // only chance to capture the codes in plaintext.
      message: 'Save these 10 backup codes somewhere safe — each is single-use, and we cannot show them again.',
    });
  } catch (err) {
    return serverError(res, err);
  }
}

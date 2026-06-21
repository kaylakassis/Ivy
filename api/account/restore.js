// POST /api/account/restore  { token }
//
// Counterpart to api/account/delete.js. Lets the owner UNDO a soft-delete
// within the 30-day grace window (before db-prune.js hard-deletes the
// row) using the recovery token we emailed them at deletion time.
//
// What it does, in order:
//   1. Validates the single-use KIND_RECOVER token. Wrong/expired/used → 401.
//   2. Reverses the email mangling delete.js applied
//      ('foo+deleted-<userId>@bar' → 'foo@bar') so the original address is
//      free again. If the address is already taken (rare: another signup
//      grabbed it during the window), we keep the mangled form and just
//      restore - the owner can then change their email from /account.
//   3. Clears deleted_at, burns the token.
//   4. Signs the user in by setting the session cookie, so they land in a
//      working app from the email click.
//   5. Fires a "your account was restored" security-style confirmation
//      (best-effort).
//
// Public endpoint: no requireUser. The token is the proof.
import { sql } from '../_lib/db.js';
import { signSession, setSessionCookie, isNativeClient } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { findValidToken, consumeToken, invalidateUserTokens, KIND_RECOVER } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { recordAudit } from '../_lib/audit.js';
import { reportError } from '../_lib/monitoring.js';
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;

  try {
    // Cheap rate-limit so a leaked token URL can't be brute-force probed.
    // Token itself is high-entropy; this just bounds noise.
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `restore:ip:${ip}`, max: 20, windowSeconds: 60 * 60 }])) return;

    const { token } = await readBody(req);
    if (typeof token !== 'string' || token.length < 16) {
      return badRequest(res, 'Missing or malformed recovery token.');
    }

    const valid = await findValidToken({ kind: KIND_RECOVER, raw: token });
    if (!valid) {
      return unauthorized(res, 'This recovery link is invalid, already used, or expired.');
    }
    // A used token from a duplicate click (e.g. the user clicked twice or
    // an email scanner prefetched) is treated as success - same convention
    // as verify_email.
    if (valid.alreadyUsed) {
      const { rows } = await sql`SELECT id, email, name, deleted_at FROM users WHERE id = ${valid.userId}`;
      if (rows[0] && rows[0].deleted_at == null) {
        // Already restored. Sign them in again and return 200.
        const u = rows[0];
        const sessionToken = signSession(u.id);
        setSessionCookie(res, sessionToken);
        const payload = { restored: true, alreadyRestored: true, user: { id: u.id, email: u.email, name: u.name } };
        if (isNativeClient(req)) payload.token = sessionToken;
        return ok(res, payload);
      }
      return unauthorized(res, 'This recovery link was used already, but the account is no longer recoverable.');
    }

    // Load the soft-deleted row. requireUser would reject it (deleted_at),
    // but we're operating on a token + raw SQL so we can see it.
    const { rows } = await sql`
      SELECT id, email, name, deleted_at FROM users WHERE id = ${valid.userId}
    `;
    const u = rows[0];
    if (!u) {
      // Row already hard-deleted by db-prune (window lapsed). Tell the
      // user clearly so they know the account is unrecoverable.
      return unauthorized(res, 'This account has already been permanently deleted and can no longer be restored.');
    }
    if (u.deleted_at == null) {
      // Already restored some other way. Just sign in.
      const sessionToken = signSession(u.id);
      setSessionCookie(res, sessionToken);
      const payload = { restored: true, alreadyRestored: true, user: { id: u.id, email: u.email, name: u.name } };
      if (isNativeClient(req)) payload.token = sessionToken;
      await consumeToken(valid.tokenId);
      return ok(res, payload);
    }

    // Reverse the mangle: 'foo+deleted-<userId>@bar' → 'foo@bar'.
    // Built defensively so a row that was never mangled (or was already
    // edited) just stays as-is.
    const restoredEmail = restoreEmail(u.email, u.id);
    let finalEmail = restoredEmail;
    if (restoredEmail !== u.email) {
      // Make sure another account hasn't claimed the original address in
      // the meantime. If it has, keep the mangled form - the owner can
      // update from /account → Profile.
      const clash = await sql`
        SELECT 1 FROM users WHERE LOWER(email) = LOWER(${restoredEmail}) AND id <> ${u.id} LIMIT 1
      `;
      if (clash.rows.length > 0) finalEmail = u.email;
    }

    await sql`
      UPDATE users SET
        deleted_at = NULL,
        email = ${finalEmail},
        updated_at = NOW()
      WHERE id = ${u.id}
    `;
    await consumeToken(valid.tokenId);
    // Burn any other live recovery tokens for this user so a second copy
    // of the email (or a leaked one) can't be replayed.
    await invalidateUserTokens({ userId: u.id, kind: KIND_RECOVER });

    recordAudit(req, {
      actor: { id: u.id, email: finalEmail },
      targetUserId: u.id,
      action: 'account.restored',
      meta: { restored_email: finalEmail, was_mangled: finalEmail !== u.email },
    });

    // Sign them in so the redirect lands on a working app.
    const sessionToken = signSession(u.id);
    setSessionCookie(res, sessionToken);

    // Best-effort confirmation that we did the restore. Mirrors the style
    // of the security-alert family.
    sendRestoreConfirmation({ email: finalEmail, name: u.name }).catch(() => {});

    const payload = { restored: true, user: { id: u.id, email: finalEmail, name: u.name } };
    if (isNativeClient(req)) payload.token = sessionToken;
    return ok(res, payload);
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

// Demangle: strip the '+deleted-<userId>' tag from the local part if present.
function restoreEmail(email, userId) {
  if (!email || typeof email !== 'string') return email;
  const tag = `+deleted-${userId}`;
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.endsWith(tag)) return local.slice(0, -tag.length) + domain;
  return email;
}

async function sendRestoreConfirmation({ email, name }) {
  if (!email) return;
  const fn = (name || '').split(/\s+/)[0] || 'there';
  try {
    await sendEmail({
      to: email,
      subject: 'Your Ivy OS account is restored',
      html: emailShell({
        heading: 'Welcome back',
        preheader: `Your account and data are right where you left them.`,
        body: `<p>Hi ${escapeHtml(fn)},</p>
          <p>Your Ivy OS account is restored. Your clients, bookings, invoices, documents, and history are exactly where you left them — nothing was lost during the recovery window.</p>
          <p>If you didn't restore your account, change your password right away.</p>`,
        footer: `Glad you're back. — The Ivy OS Team`,
      }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[account/restore] confirmation email failed:', err.message);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

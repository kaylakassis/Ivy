// POST /api/helper/accept  (public, rate-limited)
//   { token, name?, password?, acceptedTermsVersion?, acceptedPrivacyVersion? }
//
// Burns a helper invite link and attaches the invitee's login to the
// staff record (api/_lib/helpers.js acceptInvite).
//
//   • Email already has an Ivy account → the browser must be signed in AS
//     that account (the accept page sends them through /signin with
//     next= back here). We never take a password on this endpoint for an
//     existing account, so lockout + 2FA stay in /api/auth/login.
//   • No account yet → name + password + terms acceptance create one.
//     No workspace is minted: a helper owns nothing. The click proves
//     control of the inbox, so the email counts as verified.
//
// Refuses when the invitee is the workspace owner (owners do not help at
// their own business) and when the token is unknown / used / expired.
import { sql } from '../_lib/db.js';
import {
  readSession, hashPassword, signSession, setSessionCookie, isNativeClient, invalidateUserCache,
} from '../_lib/auth.js';
import { validatePassword } from '../_lib/passwordPolicy.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../_lib/legal.js';
import { findLiveInvite, acceptInvite, invalidateHelperCache } from '../_lib/helpers.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const EXPIRED = 'This invite link has expired or was already used. Ask the business to send a new one.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `helper-accept:ip:${ip}`, max: 10, windowSeconds: 10 * 60 }])) return;

    const body = await readBody(req);
    const raw = typeof body.token === 'string' ? body.token : '';
    const invite = await findLiveInvite(raw);
    if (!invite) return badRequest(res, EXPIRED);
    const email = invite.email.toLowerCase();

    const owner = await sql`SELECT id, email FROM users WHERE id = ${invite.owner_id} LIMIT 1`;
    if ((owner.rows[0]?.email || '').toLowerCase() === email) {
      return badRequest(res, 'That is the business owner’s own email. Helpers need their own sign-in.');
    }

    const existing = await sql`
      SELECT id, email, name FROM users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1
    `;
    const session = readSession(req);
    let userId;
    let created = false;
    let sessionToken = null;

    if (existing.rows.length > 0) {
      const account = existing.rows[0];
      if (!session?.sub) {
        return res.status(401).json({
          error: 'sign-in-required',
          message: 'This email already has an Ivy account. Sign in to accept the invite.',
          email,
        });
      }
      if (session.sub !== account.id) {
        return res.status(403).json({
          error: 'wrong-account',
          message: `This invite was sent to ${email}. Sign out and sign in with that account.`,
          email,
        });
      }
      userId = account.id;
    } else {
      // Signed in as someone else while holding an invite for a brand-new
      // email: don't silently create a second account under their nose.
      if (session?.sub) {
        return res.status(403).json({
          error: 'wrong-account',
          message: `This invite was sent to ${email}. Sign out, then open the link again to create that sign-in.`,
          email,
        });
      }
      const name = (body.name || '').toString().trim().slice(0, 200);
      if (!name) return badRequest(res, 'Your name is required');
      const pw = validatePassword(body.password);
      if (!pw.ok) return badRequest(res, pw.error);
      if (body.acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
        return badRequest(res, `You must accept the current Terms (${CURRENT_TERMS_VERSION}) to create a sign-in.`);
      }
      if (body.acceptedPrivacyVersion !== CURRENT_PRIVACY_VERSION) {
        return badRequest(res, `You must accept the current Privacy Policy (${CURRENT_PRIVACY_VERSION}) to create a sign-in.`);
      }
      const passwordHash = await hashPassword(body.password);
      const ins = await sql`
        INSERT INTO users (
          email, password_hash, name, email_verified_at,
          terms_version, terms_accepted_at, privacy_version, privacy_accepted_at,
          last_login_at, last_active_at
        ) VALUES (
          ${email}, ${passwordHash}, ${name}, NOW(),
          ${CURRENT_TERMS_VERSION}, NOW(), ${CURRENT_PRIVACY_VERSION}, NOW(),
          NOW(), NOW()
        )
        RETURNING id
      `;
      userId = ins.rows[0].id;
      created = true;
      try {
        const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;
        await sql`
          INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
          VALUES
            (${userId}, 'terms',   ${CURRENT_TERMS_VERSION},   ${ip}, ${ua}),
            (${userId}, 'privacy', ${CURRENT_PRIVACY_VERSION}, ${ip}, ${ua})
        `;
      } catch (legalErr) {
        // Same compensation as signup: never strand an account without
        // its acceptance proof.
        await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
        throw legalErr;
      }
    }

    if (invite.owner_id === userId) {
      return badRequest(res, 'You own this business. Helpers need their own sign-in.');
    }

    const attached = await acceptInvite({ invite, userId });
    if (!attached) {
      // Lost a race with a second click on the same link.
      if (created) await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
      return badRequest(res, EXPIRED);
    }
    invalidateHelperCache(userId);
    invalidateUserCache(userId);

    if (created) {
      sessionToken = signSession(userId);
      setSessionCookie(res, sessionToken);
    }

    const payload = {
      ok: true,
      created,
      workspaceId: invite.workspace_id,
      businessName: invite.biz_name || invite.workspace_name || 'A business',
      staffId: invite.staff_member_id,
    };
    if (created && isNativeClient(req)) payload.token = sessionToken;
    return ok(res, payload);
  } catch (err) {
    return serverError(res, err);
  }
}

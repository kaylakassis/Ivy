// PATCH  /api/admin/users/:id
//   Body fields are independent - pass any subset:
//     role           'regular'|'sponsored'|'affiliate'|'business-trial'|'business-active'
//                    Single high-level dispatch that knows the side effects:
//                      regular         → user_type='regular', revert sponsored
//                                        comp if leaving 'sponsored'
//                      sponsored       → user_type='sponsored', flip workspace
//                                        to active w/ 100-year period_end
//                                        (paywall stays out of the way)
//                      affiliate       → user_type='affiliate', auto-create
//                                        an affiliates row with a generated
//                                        code if one doesn't exist yet
//                      business-trial  → workspace.subscription_status =
//                                        'trialing' with a fresh 14-day window
//                      business-active → workspace.subscription_status =
//                                        'active' with period_end = NOW() + 1mo
//                                        (manual flag - Stripe webhook still
//                                         updates real period_end on payment)
//     userType       legacy alias for role; only accepts the first three
//                    values. Kept for back-compat with older admin clients.
//     password               setting a new one without going through email
//     name                   rename
//     sendResetLink: true        → emails them a fresh password-reset link
//     sendVerificationLink: true → emails them a fresh email-verification link
//                                  (no-op if already verified)
//     resendWelcome: true        → re-fires the welcome email the user got
//                                  at signup. Owner vs client variant is
//                                  auto-detected from workspace ownership.
//
// DELETE /api/admin/users/:id
//   Hard-delete the user. Cascades through the FK chain (workspaces,
//   clients, etc.) - see schema. Refuses to delete super-admins.
import { sql } from '../../_lib/db.js';
import { hashPassword } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { requireSuperAdmin, emailIsSuperAdmin, getAdminActor } from '../../_lib/admin.js';
import { TRIAL_DAYS } from '../../_lib/billing.js';
import { sendEmail, emailShell } from '../../_lib/email.js';
import { createToken, invalidateUserTokens, KIND_RESET, KIND_VERIFY, appUrl } from '../../_lib/tokens.js';
import { recordAudit } from '../../_lib/audit.js';
import { renderWelcome } from '../../_lib/welcome-content.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

// Same reason as /api/auth/signup - this PATCH can fire emails
// (sendVerificationLink, sendResetLink, resendWelcome). Default 10s
// is tight when Resend is slow.
export const config = { maxDuration: 30 };

const VALID_ROLES = new Set([
  'regular', 'sponsored', 'beta', 'affiliate',
  'business-trial', 'business-active',
]);

// Roles that map directly onto users.user_type. The remaining two
// ('business-trial', 'business-active') only flip workspace state;
// user_type stays whatever it was (or reverts to 'regular' if the
// caller is leaving 'sponsored'/'beta').
const TYPE_ROLES = new Set(['regular', 'sponsored', 'beta', 'affiliate']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const id = (req.query.id || '').toString();
    const r = await sql`
      SELECT u.id, u.email, u.name, u.user_type, u.email_verified_at,
             EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id) AS is_owner
        FROM users u
       WHERE u.id = ${id}
    `;
    if (r.rows.length === 0) return notFound(res, 'User not found');
    const u = r.rows[0];

    if (req.method === 'PATCH') return patchUser(u, req, res);
    if (req.method === 'DELETE') return deleteUser(u, req, res);
    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function patchUser(u, req, res) {
  const body = await readBody(req);
  const actor = await getAdminActor(req);

  // Resolve the requested role. `role` is the new high-level field; `userType`
  // is kept for back-compat and is only allowed to carry user_type values.
  let role = null;
  if ('role' in body) {
    const r = String(body.role);
    if (!VALID_ROLES.has(r)) return badRequest(res, 'Invalid role');
    role = r;
  } else if ('userType' in body) {
    const t = String(body.userType);
    if (!TYPE_ROLES.has(t)) return badRequest(res, 'Invalid userType');
    role = t;
  }

  if (role) {
    await applyRole(u, role, req, actor);
  }

  if ('name' in body) {
    const n = body.name == null ? null : String(body.name).trim().slice(0, 200);
    await sql`UPDATE users SET name = ${n} WHERE id = ${u.id}`;
  }

  if ('password' in body && body.password) {
    const pw = String(body.password);
    if (pw.length < 8) return badRequest(res, 'Password too short');
    const hash = await hashPassword(pw);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${u.id}`;
    await recordAudit(req, {
      actor, targetUserId: u.id, action: 'user.set_password',
      meta: { method: 'manual' },
    });
  }

  if (body.sendResetLink === true) {
    try {
      const raw = await createToken({ userId: u.id, kind: KIND_RESET, ttlMinutes: 60 * 24 });
      const link = `${appUrl()}/reset-password?token=${encodeURIComponent(raw)}`;
      await sendEmail({
        to: u.email,
        subject: 'Reset your Ivy OS password',
        html: emailShell({
          heading: 'Reset your password',
          body: `<p>${u.name ? `Hi ${escapeHtml(u.name)},` : 'Hi,'}</p>
                 <p>An admin sent you a fresh link to reset your Ivy OS
                 password. Click below and pick a new one.</p>
                 <p>This link is good for 24 hours.</p>`,
          ctaText: 'Reset my password',
          ctaUrl: link,
          footer: 'If this looks unexpected, reply to this email and we\'ll sort it out.',
        }),
      });
      await recordAudit(req, {
        actor, targetUserId: u.id, action: 'user.send_reset_link',
        meta: {},
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[admin/users/:id] reset-link email failed:', err.message);
      return badRequest(res, `Could not send email: ${err.message}`);
    }
  }

  // Fresh email-verification link. Burns older live verify tokens so only
  // the latest one works. No-op if the user already verified - return a
  // soft note so the UI can show "already verified" rather than a generic
  // success.
  if (body.sendVerificationLink === true) {
    if (u.email_verified_at) {
      return ok(res, { ok: true, alreadyVerified: true });
    }
    try {
      await invalidateUserTokens({ userId: u.id, kind: KIND_VERIFY });
      const raw = await createToken({ userId: u.id, kind: KIND_VERIFY, ttlMinutes: 60 * 24 });
      const link = `${appUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
      await sendEmail({
        to: u.email,
        subject: 'Confirm your email for Ivy OS',
        html: emailShell({
          heading: 'Confirm your email',
          body: `<p>${u.name ? `Hi ${escapeHtml(u.name)},` : 'Hi,'}</p>
                 <p>An admin sent you a fresh link to confirm your Ivy OS
                 email. Click below to activate notifications and finish
                 setting up your account.</p>
                 <p>This link is good for 24 hours.</p>`,
          ctaText: 'Confirm my email',
          ctaUrl: link,
          footer: `If this looks unexpected, reply to this email and we'll sort it out.`,
        }),
      });
      await recordAudit(req, {
        actor, targetUserId: u.id, action: 'user.send_verification_link',
        meta: {},
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[admin/users/:id] verification-link email failed:', err.message);
      return badRequest(res, `Could not send email: ${err.message}`);
    }
  }

  // Resend the welcome email - same content the user gets at signup.
  // Owner vs client variant is auto-detected from workspace ownership.
  if (body.resendWelcome === true) {
    const variant = u.is_owner ? 'owner' : 'client';
    const out = renderWelcome({
      name: firstName(u.name),
      appUrl: appUrl(),
      variant,
    });
    try {
      await sendEmail({ to: u.email, subject: out.subject, html: out.html });
      await recordAudit(req, {
        actor, targetUserId: u.id, action: 'user.resend_welcome',
        meta: { variant },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[admin/users/:id] welcome resend failed:', err.message);
      return badRequest(res, `Could not send email: ${err.message}`);
    }
  }

  return ok(res, { ok: true });
}

function firstName(name) {
  if (!name) return null;
  return String(name).trim().split(/\s+/)[0] || null;
}

async function deleteUser(u, req, res) {
  if (emailIsSuperAdmin(u.email) || u.user_type === 'super_admin') {
    return badRequest(res, "Refusing to delete a super-admin account through this endpoint.");
  }
  const actor = await getAdminActor(req);
  if (actor?.id === u.id) {
    return badRequest(res, "You can't delete the account you're signed in as.");
  }
  await sql`DELETE FROM users WHERE id = ${u.id}`;
  await recordAudit(req, {
    actor, targetUserId: u.id, action: 'user.delete',
    meta: { email: u.email },
  });
  return noContent(res);
}

// Single dispatch for every role assignment. Side effects vary by role:
//   regular         → user_type = 'regular'; if leaving sponsored, revert
//                     workspace subscription.
//   sponsored       → user_type = 'sponsored'; force workspace to 'active'
//                     with a 100-year period_end so the Paywall hides.
//   affiliate       → user_type = 'affiliate'; auto-create an affiliates
//                     row with a generated code if one doesn't exist.
//   business-trial  → workspace.subscription_status = 'trialing' with a
//                     fresh 14-day trial; user_type back to 'regular' if
//                     they were sponsored.
//   business-active → workspace.subscription_status = 'active' with a
//                     1-month period_end (the Stripe webhook will refresh
//                     the period_end on real renewals); user_type back to
//                     'regular' if they were sponsored.
async function applyRole(u, role, req, actor) {
  // Whether this role corresponds to a value of users.user_type or only
  // affects the workspace's subscription state.
  const newUserType = TYPE_ROLES.has(role) ? role : 'regular';
  if (newUserType !== u.user_type) {
    await sql`UPDATE users SET user_type = ${newUserType} WHERE id = ${u.id}`;
  }

  // Subscription-state side effects keyed off the requested role.
  if (role === 'sponsored' || role === 'beta') {
    // Same shape: free, full-access, no card, no expiry. The user_type
    // bypass in workspaceGate is the real enforcement; setting the row
    // to 'active' with a 100yr period_end is the belt-and-suspenders.
    await sql`
      UPDATE workspaces SET
        subscription_status     = 'active',
        subscription_period_end = NOW() + INTERVAL '100 years',
        trial_ends_at           = NULL
      WHERE owner_id = ${u.id}
    `;
  } else if (role === 'business-trial') {
    await sql`
      UPDATE workspaces SET
        subscription_status     = 'trialing',
        trial_ends_at           = NOW() + (${TRIAL_DAYS}::int || ' days')::interval,
        subscription_period_end = NULL
      WHERE owner_id = ${u.id}
    `;
  } else if (role === 'business-active') {
    await sql`
      UPDATE workspaces SET
        subscription_status     = 'active',
        subscription_period_end = NOW() + INTERVAL '1 month',
        trial_ends_at           = NULL
      WHERE owner_id = ${u.id}
    `;
  } else if ((u.user_type === 'sponsored' || u.user_type === 'beta')
             && role !== 'sponsored' && role !== 'beta') {
    // Leaving a comp'd type (sponsored/beta) back to regular/affiliate
    // without an explicit billing role - give them a fresh trial
    // (TRIAL_DAYS days) unless they already have a Stripe sub doing
    // the real billing.
    await sql`
      UPDATE workspaces SET
        subscription_status     = CASE
          WHEN stripe_subscription_id IS NOT NULL THEN subscription_status
          ELSE 'trialing'
        END,
        subscription_period_end = CASE
          WHEN stripe_subscription_id IS NOT NULL THEN subscription_period_end
          ELSE NULL
        END,
        trial_ends_at           = CASE
          WHEN stripe_subscription_id IS NOT NULL THEN trial_ends_at
          ELSE NOW() + (${TRIAL_DAYS}::int || ' days')::interval
        END
      WHERE owner_id = ${u.id}
    `;
  }

  // Affiliate row provisioning. A user flipped to 'affiliate' should have
  // a code ready when they log in. Idempotent - re-running is a no-op.
  if (role === 'affiliate') {
    const dup = await sql`SELECT id, code FROM affiliates WHERE user_id = ${u.id}`;
    if (dup.rows.length === 0) {
      const code = await uniqueAffiliateCode();
      await sql`
        INSERT INTO affiliates (user_id, code, display_name)
        VALUES (${u.id}, ${code}, ${u.name || null})
      `;
      await recordAudit(req, {
        actor, targetUserId: u.id, action: 'affiliate.create',
        meta: { code, source: 'role-assign' },
      });
    }
  }

  await recordAudit(req, {
    actor, targetUserId: u.id, action: 'user.set_role',
    meta: { from: u.user_type, to: role },
  });
}

async function uniqueAffiliateCode() {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 8; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const r = await sql`SELECT 1 FROM affiliates WHERE code = ${s}`;
    if (r.rows.length === 0) return s;
  }
  return `Ivy OS-${Date.now().toString(36).toUpperCase()}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

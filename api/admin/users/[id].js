// PATCH  /api/admin/users/:id
//   Body: { userType?, password?, name?, sendResetLink? }
//   • userType in 'regular'|'sponsored'|'affiliate' — flips the column.
//     Switching to/from sponsored also adjusts the workspace's
//     subscription state so the paywall behaves correctly:
//       → sponsored: workspace status flips to 'active' with a far-future
//         period_end so the Paywall sees them as paid.
//       → leaving sponsored back to regular: status reverts to 'trialing'
//         with a fresh 28-day window if they don't already have an
//         active Stripe sub.
//   • password: setting a new one without going through email — useful
//     when an owner can't receive email and asks for a manual reset.
//   • sendResetLink: true → emails them a reset link.
//
// DELETE /api/admin/users/:id
//   Hard-delete the user. Cascades through the FK chain (workspaces,
//   clients, etc. — see schema). Use with care; there's no undo.
import { sql } from '../../_lib/db.js';
import { hashPassword } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { requireSuperAdmin, emailIsSuperAdmin } from '../../_lib/admin.js';
import { sendEmail, emailShell } from '../../_lib/email.js';
import { createToken, KIND_RESET, appUrl } from '../../_lib/tokens.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

const VALID_TYPES = new Set(['regular', 'sponsored', 'affiliate']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const id = (req.query.id || '').toString();
    const r = await sql`SELECT id, email, name, user_type FROM users WHERE id = ${id}`;
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

  if ('userType' in body) {
    const t = String(body.userType);
    if (!VALID_TYPES.has(t)) return badRequest(res, 'Invalid userType');

    await sql`UPDATE users SET user_type = ${t} WHERE id = ${u.id}`;

    // Side effects on the user's workspace (if any) so the paywall stays
    // consistent with the type.
    if (t === 'sponsored') {
      await sql`
        UPDATE workspaces SET
          subscription_status     = 'active',
          subscription_period_end = NOW() + INTERVAL '100 years',
          trial_ends_at           = NULL
        WHERE owner_id = ${u.id}
      `;
    } else if (u.user_type === 'sponsored' && t !== 'sponsored') {
      // Coming back from sponsored — give them a fresh 28-day trial unless
      // they already have a real Stripe subscription.
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
            ELSE NOW() + INTERVAL '28 days'
          END
        WHERE owner_id = ${u.id}
      `;
    }
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
  }

  if (body.sendResetLink === true) {
    try {
      const raw = await createToken({ userId: u.id, kind: KIND_RESET, ttlMinutes: 60 * 24 });
      const link = `${appUrl()}/reset-password?token=${encodeURIComponent(raw)}`;
      await sendEmail({
        to: u.email,
        subject: 'Reset your THRYVE password',
        html: emailShell({
          heading: 'Reset your password',
          body: `<p>${u.name ? `Hi ${escapeHtml(u.name)},` : 'Hi,'}</p>
                 <p>An admin sent you a fresh link to reset your THRYVE
                 password. Click below and pick a new one.</p>
                 <p>This link is good for 24 hours.</p>`,
          ctaText: 'Reset my password',
          ctaUrl: link,
          footer: 'If this looks unexpected, reply to this email and we\'ll sort it out.',
        }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[admin/users/:id] reset-link email failed:', err.message);
      return badRequest(res, `Could not send email: ${err.message}`);
    }
  }

  return ok(res, { ok: true });
}

async function deleteUser(u, req, res) {
  if (emailIsSuperAdmin(u.email)) {
    return badRequest(res, "Refusing to delete a super-admin account through this endpoint.");
  }
  await sql`DELETE FROM users WHERE id = ${u.id}`;
  return noContent(res);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

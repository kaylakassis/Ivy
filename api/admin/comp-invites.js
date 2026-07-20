// /api/admin/comp-invites - super-admin management of complimentary access.
//
//   GET    → list invites (claimed + unclaimed) with workspace status
//   POST   → { email, note?, months? } create an invite + send the invite
//            email. If the email already has a LIVE account, comp their
//            workspace immediately (marked claimed).
//   DELETE → ?id=<invite id> revoke: removes the invite AND clears
//            comp_until on the claimed workspace (they fall back to the
//            normal trial/paywall funnel - nothing else is touched).
//
// Why comp instead of a 100% Stripe coupon: no card entry, no $0
// subscription polluting Stripe MRR, no dunning emails on card expiry,
// one-click revoke, and it works while the waitlist gate is on.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { appUrl } from '../_lib/tokens.js';
import { invalidateOwnerWorkspaceByWorkspaceId } from '../_lib/clientPortal.js';
import { evictWorkspaceGateCache } from '../_lib/workspaceGate.js';
import { badRequest, created, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

const PERMANENT = '9999-01-01T00:00:00Z';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    if (!(await requireSuperAdmin(req, res))) return;
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT ci.id, ci.email, ci.note, ci.comp_months, ci.created_at,
               ci.claimed_at, ci.claimed_workspace_id,
               w.comp_until AS workspace_comp_until
          FROM comp_invites ci
          LEFT JOIN workspaces w ON w.id = ci.claimed_workspace_id
         ORDER BY ci.created_at DESC
         LIMIT 500
      `;
      return ok(res, {
        invites: rows.map((r) => ({
          id: r.id,
          email: r.email,
          note: r.note,
          months: r.comp_months,
          createdAt: r.created_at,
          claimedAt: r.claimed_at,
          active: !!(r.workspace_comp_until && new Date(r.workspace_comp_until) > new Date()),
        })),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return badRequest(res, 'A valid email is required');
      const note = body.note ? String(body.note).slice(0, 200) : null;
      const months = Number.isFinite(Number(body.months)) && Number(body.months) > 0
        ? Math.min(120, Math.round(Number(body.months)))
        : null; // null = permanent

      const ins = await sql`
        INSERT INTO comp_invites (email, note, comp_months, created_by)
        VALUES (${email}, ${note}, ${months}, ${user.id})
        ON CONFLICT (LOWER(email)) DO UPDATE SET
          note = EXCLUDED.note, comp_months = EXCLUDED.comp_months
        RETURNING id
      `;
      const inviteId = ins.rows[0].id;

      // Existing live account with this email → comp their workspace now.
      let compedNow = false;
      const existing = await sql`
        SELECT u.id AS user_id, w.id AS workspace_id
          FROM users u JOIN workspaces w ON w.owner_id = u.id
         WHERE LOWER(u.email) = ${email} AND u.deleted_at IS NULL
         LIMIT 1
      `;
      if (existing.rows.length > 0) {
        const wsId = existing.rows[0].workspace_id;
        const until = months
          ? new Date(Date.now() + months * 30 * 86400 * 1000).toISOString()
          : PERMANENT;
        await sql`UPDATE workspaces SET comp_until = ${until}, comp_note = ${note || 'Comp invite'} WHERE id = ${wsId}`;
        await sql`UPDATE comp_invites SET claimed_at = NOW(), claimed_workspace_id = ${wsId} WHERE id = ${inviteId}`;
        evictWorkspaceGateCache(wsId);
        await invalidateOwnerWorkspaceByWorkspaceId(wsId).catch(() => {});
        compedNow = true;
      }

      // Invite email - best-effort; the grant itself is already durable.
      let emailed = false;
      try {
        const durLabel = months ? `${months} month${months === 1 ? '' : 's'} of` : 'full';
        await sendEmail({
          to: email,
          subject: "You've been given free access to Ivy",
          html: emailShell({
            heading: 'Welcome to Ivy - on us',
            body: compedNow
              ? `<p>Your Ivy account now has ${durLabel} complimentary access. No card, no charges - just sign in and everything is unlocked.</p>`
              : `<p>You've been invited to Ivy with ${durLabel} complimentary access. Create your account with this email address (${email}) and everything unlocks automatically - no card required.</p>`,
            ctaText: compedNow ? 'Open Ivy' : 'Create your account',
            ctaUrl: compedNow ? `${appUrl()}/signin` : `${appUrl()}/signup`,
            footer: 'Ivy - the all-in-one platform for solopreneurs.',
          }),
        });
        emailed = true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[comp-invites] invite email failed:', e.message);
      }

      return created(res, { id: inviteId, email, compedNow, emailed });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) return badRequest(res, 'id is required');
      const { rows } = await sql`
        DELETE FROM comp_invites WHERE id = ${id}
        RETURNING claimed_workspace_id
      `;
      if (rows.length === 0) return notFound(res, 'Invite not found');
      const wsId = rows[0].claimed_workspace_id;
      if (wsId) {
        await sql`UPDATE workspaces SET comp_until = NULL, comp_note = NULL WHERE id = ${wsId}`;
        evictWorkspaceGateCache(wsId);
        await invalidateOwnerWorkspaceByWorkspaceId(wsId).catch(() => {});
      }
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

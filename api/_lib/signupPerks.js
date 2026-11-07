// Sign-up perks: complimentary access (comp_invites) and the waitlist
// discount (workspaces.waitlist_discount_at, 20% off at checkout).
//
// Both are granted to "whoever owns this email address", so they are
// handed out only once the account has PROVEN it owns the address: after
// the email is verified. Granting them at sign-up let anyone who knew an
// invitee's (or a waitlister's) address sign up as them first and take the
// free access or the discount.
//
// Called from every path that marks an email verified:
//   • api/auth/verify-email.js (the link in the confirmation email)
//   • api/admin/users.js (an admin-created account is verified on creation)
// and from api/admin/comp-invites.js indirectly (an invite for an existing
// VERIFIED account is applied at once; an unverified one waits for here).
//
// Idempotent: the comp invite is claimed with a single conditional UPDATE
// (claimed_at IS NULL), so two concurrent verifications claim it once; the
// waitlist stamp keeps its first date. Best-effort: never throws, so a perk
// hiccup can never break email verification.
import { sql } from './db.js';
import { invalidateOwnerWorkspace } from './clientPortal.js';
import { evictWorkspaceGateCache } from './workspaceGate.js';

const PERMANENT = '9999-01-01T00:00:00Z';

export function compUntilFor(months) {
  return months
    ? new Date(Date.now() + months * 30 * 86400 * 1000).toISOString()
    : PERMANENT;
}

// Returns { comp: boolean, waitlist: boolean } saying what was granted NOW
// (false when already granted earlier or not applicable).
export async function claimSignupPerks(userId) {
  const out = { comp: false, waitlist: false };
  if (!userId) return out;
  let user;
  let workspaceId;
  try {
    const u = await sql`
      SELECT id, email, email_verified_at, deleted_at FROM users WHERE id = ${userId}
    `;
    user = u.rows[0];
    if (!user || user.deleted_at || !user.email_verified_at || !user.email) return out;
    const ws = await sql`
      SELECT id FROM workspaces WHERE owner_id = ${userId}
       ORDER BY created_at ASC, id ASC LIMIT 1
    `;
    workspaceId = ws.rows[0]?.id;
    if (!workspaceId) return out; // client accounts: no perks to apply
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[signupPerks] lookup failed:', err.message);
    return out;
  }
  const emailKey = String(user.email).trim().toLowerCase();

  // Comp invite: claim it atomically, then apply it to the workspace. If
  // applying fails, hand the claim back so the next verification retries.
  try {
    const inv = await sql`
      UPDATE comp_invites
         SET claimed_at = NOW(), claimed_workspace_id = ${workspaceId}
       WHERE id = (SELECT id FROM comp_invites
                    WHERE LOWER(email) = ${emailKey} AND claimed_at IS NULL
                    ORDER BY created_at ASC LIMIT 1)
         AND claimed_at IS NULL
       RETURNING id, note, comp_months
    `;
    if (inv.rows.length > 0) {
      const row = inv.rows[0];
      try {
        await sql`
          UPDATE workspaces SET comp_until = ${compUntilFor(row.comp_months)}, comp_note = ${row.note || 'Comp invite'}
           WHERE id = ${workspaceId}
        `;
        out.comp = true;
      } catch (applyErr) {
        await sql`UPDATE comp_invites SET claimed_at = NULL, claimed_workspace_id = NULL WHERE id = ${row.id}`.catch(() => {});
        throw applyErr;
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[signupPerks] comp-invite claim failed:', err.message);
  }

  // Waitlist discount: this server-side email match IS the exclusivity
  // (the discount cannot be shared as a code). Keeps the first stamp.
  try {
    const wl = await sql`SELECT 1 FROM waitlist_signups WHERE LOWER(email) = ${emailKey} LIMIT 1`;
    if (wl.rows.length > 0) {
      const stamped = await sql`
        UPDATE workspaces SET waitlist_discount_at = NOW()
         WHERE id = ${workspaceId} AND waitlist_discount_at IS NULL
         RETURNING id
      `;
      out.waitlist = stamped.rows.length > 0;
      await sql`
        UPDATE waitlist_signups
           SET status = 'converted', converted_user_id = ${userId}, converted_at = NOW()
         WHERE LOWER(email) = ${emailKey} AND converted_user_id IS DISTINCT FROM ${userId}
      `;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[signupPerks] waitlist discount stamp failed:', err.message);
  }

  if (out.comp || out.waitlist) {
    evictWorkspaceGateCache(workspaceId);
    invalidateOwnerWorkspace(userId);
  }
  return out;
}

// For /api/me: does the signed-in, NOT yet verified owner have an
// unclaimed comp invite waiting on their own address? Only ever asked for
// the session user's own email, so it reveals nothing about anyone else.
export async function hasPendingCompInvite(user) {
  if (!user?.id || !user.email || user.email_verified_at) return false;
  try {
    const { rows } = await sql`
      SELECT 1 FROM comp_invites
       WHERE LOWER(email) = ${String(user.email).trim().toLowerCase()} AND claimed_at IS NULL
       LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

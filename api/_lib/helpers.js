// Helpers: "bring your assistant along".
//
// Ivy is for solo businesses - one owner per workspace, no co-owner or
// admin role. A HELPER is an existing staff_members row (assistant,
// second shooter, Saturday cover) that the owner has invited to sign in.
// Accepting attaches the helper's own users row (staff_members.user_id)
// so they can see THEIR assigned bookings and mark them done. Nothing
// else: no money, no other clients, no settings.
//
// This module is the single source of truth for:
//   • HELPER_SEATS         - how many helpers a workspace may attach (2)
//   • helperMembershipsFor - which workspaces a user helps at
//   • requireHelper        - the gate every /api/helper/* endpoint uses
//   • inviteHelper / revokeHelper / cancelHelperInvite
//   • helperSeatUsage      - attached + pending-invite count vs the cap
//
// SECURITY: every helper read is scoped by workspace_id AND
// staff_member_id resolved from the SESSION user, never from the request.
// Helper access rides on the owner's subscription: when isWorkspaceActive
// says the business is paused, requireHelper denies with 402.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { requireUser } from './auth.js';
import { getOrSet, invalidate as cacheInvalidate } from './hotCache.js';
import { isWorkspaceActive } from './clientPortal.js';
import { sendEmail, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { generateRawToken, appUrl } from './tokens.js';

// Helpers included with every subscription. Not a plan tier, not a seat
// price - the cap keeps Ivy a solo product with room for an assistant.
export const HELPER_SEATS = 2;

// Signed invite links live for a week, then the owner resends.
export const HELPER_INVITE_TTL_DAYS = 7;

// Cached per session user (requireHelper runs on every helper request).
// Short TTL; revoke/accept/delete call invalidateHelperCache so the
// change lands immediately in practice. The test harness bypasses the
// cache entirely (IVY_DISABLE_HOTCACHE).
const HELPS_TTL_MS = 15_000;

export function invalidateHelperCache(userId) {
  if (userId) cacheInvalidate(`helps:${userId}`);
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Every workspace this user helps at, or WAS helping at until the owner
// revoked them. Shape is what /api/me exposes as `helps`:
//   [{ workspaceId, businessName, staffId, staffName, status, active }]
//   status: 'active' (login attached) | 'revoked' (owner removed them)
//   active: the owner's subscription is live (isWorkspaceActive, with the
//           sponsored/beta bypass the owner's own gate applies)
// Revoked rows are kept so the helper shell can say "you're no longer
// part of <Business>" rather than a bare 403.
export async function helperMembershipsFor(userId) {
  if (!userId) return [];
  return getOrSet(`helps:${userId}`, HELPS_TTL_MS, () => helperMembershipsFromDb(userId));
}

// Only the live ones - what every access decision is based on.
export async function activeHelperMembershipsFor(userId) {
  return (await helperMembershipsFor(userId)).filter((m) => m.status === 'active');
}

async function helperMembershipsFromDb(userId) {
  try {
    const { rows } = await sql`
      SELECT sm.id AS staff_id, sm.name AS staff_name, sm.workspace_id,
             (sm.user_id = ${userId}) AS is_live, sm.revoked_at,
             w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until,
             w.owner_id,
             u.user_type AS owner_user_type, u.deleted_at AS owner_deleted_at,
             cs.biz_name, w.name AS workspace_name
        FROM staff_members sm
        JOIN workspaces w ON w.id = sm.workspace_id
        LEFT JOIN users u ON u.id = w.owner_id
        LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
       WHERE (sm.user_id = ${userId} AND sm.active = TRUE)
          OR (sm.user_id IS NULL AND sm.revoked_user_id = ${userId})
       ORDER BY (sm.user_id = ${userId}) DESC, COALESCE(cs.biz_name, w.name) ASC, sm.created_at ASC
    `;
    return rows.map((r) => ({
      workspaceId:  r.workspace_id,
      businessName: r.biz_name || r.workspace_name || 'Business',
      staffId:      r.staff_id,
      staffName:    r.staff_name,
      ownerId:      r.owner_id,
      status:       r.is_live ? 'active' : 'revoked',
      revokedAt:    r.is_live ? null : r.revoked_at,
      active:       !!r.is_live && !r.owner_deleted_at && (
        r.owner_user_type === 'sponsored' || r.owner_user_type === 'beta' || isWorkspaceActive(r)
      ),
    }));
  } catch (err) {
    // Partial schema (cold install) - no helpers rather than a 500 on /api/me.
    // eslint-disable-next-line no-console
    console.error('[helpers] membership lookup failed (returning empty):', err.message);
    return [];
  }
}

// Does this user help anywhere at all? Used by the owner gate to refuse
// auto-creating a workspace for a helper-only account.
export async function isHelperUser(userId) {
  const m = await activeHelperMembershipsFor(userId);
  return m.length > 0;
}

// Gate for /api/helper/*. Resolves the staff membership from the SESSION
// user. `workspaceId` (query or body) picks one when the user helps at
// several businesses; otherwise the first. Writes the response on
// failure and returns null:
//   401 - no session (requireUser)
//   403 - the user helps nowhere / not at that workspace
//         ({ error: 'revoked', businessName } when the owner removed them,
//         so the shell can say so instead of showing a blank wall)
//   402 - the business is paused on Ivy (owner's subscription lapsed)
export async function requireHelper(req, res, { workspaceId } = {}) {
  const user = await requireUser(req, res);
  if (!user) return null;
  const all = await helperMembershipsFor(user.id);
  const memberships = all.filter((m) => m.status === 'active');
  const wanted = workspaceId ? String(workspaceId) : null;
  const revokedDeny = (m) => {
    res.status(403).json({
      error: 'revoked',
      message: "Looks like you're no longer part of this team on Ivy.",
      workspaceId: m.workspaceId,
      businessName: m.businessName,
    });
    return null;
  };
  if (memberships.length === 0) {
    const revoked = wanted ? all.find((m) => m.workspaceId === wanted) : all[0];
    if (revoked) return revokedDeny(revoked);
    res.status(403).json({ error: 'not-a-helper', message: 'You are not a helper at any business on Ivy.' });
    return null;
  }
  const membership = wanted
    ? memberships.find((m) => m.workspaceId === wanted)
    : memberships[0];
  if (!membership) {
    const revoked = all.find((m) => m.workspaceId === wanted);
    if (revoked) return revokedDeny(revoked);
    res.status(403).json({ error: 'not-a-helper', message: 'You are not a helper at that business.' });
    return null;
  }
  if (!membership.active) {
    res.status(402).json({
      error: 'business-paused',
      message: 'This business is paused on Ivy. Ask the owner to reactivate their subscription.',
      workspaceId: membership.workspaceId,
      businessName: membership.businessName,
    });
    return null;
  }
  return { user, membership, memberships };
}

// Seats used = helpers attached + invites still pending (unused,
// uncancelled, unexpired). Pending invites count so two invites can't
// race past the cap.
export async function helperSeatUsage(workspaceId) {
  const { rows } = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM staff_members
         WHERE workspace_id = ${workspaceId} AND user_id IS NOT NULL) AS attached,
      (SELECT COUNT(DISTINCT hi.staff_member_id)::int FROM helper_invites hi
         JOIN staff_members sm ON sm.id = hi.staff_member_id AND sm.user_id IS NULL
        WHERE hi.workspace_id = ${workspaceId}
          AND hi.used_at IS NULL AND hi.cancelled_at IS NULL
          AND hi.expires_at > NOW()) AS pending
  `;
  const attached = rows[0]?.attached || 0;
  const pending  = rows[0]?.pending || 0;
  return { attached, pending, used: attached + pending, seats: HELPER_SEATS };
}

// Latest pending invite per staff row, for the owner's drawer.
// Returns Map(staffId -> { expiresAt, createdAt }).
export async function pendingInvitesByStaff(workspaceId) {
  const out = new Map();
  try {
    const { rows } = await sql`
      SELECT DISTINCT ON (staff_member_id) staff_member_id, expires_at, created_at
        FROM helper_invites
       WHERE workspace_id = ${workspaceId}
         AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > NOW()
       ORDER BY staff_member_id, created_at DESC
    `;
    for (const r of rows) out.set(r.staff_member_id, { expiresAt: r.expires_at, createdAt: r.created_at });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[helpers] pending invite lookup failed:', err.message);
  }
  return out;
}

// 'active' | 'invited' | 'revoked' | null (plain owner-managed record).
export function helperStatusFor(row, pending) {
  if (row.user_id) return 'active';
  if (pending) return 'invited';
  if (row.revoked_at) return 'revoked';
  return null;
}

export function helperFieldsFor(row, pending) {
  return {
    status:          helperStatusFor(row, pending),
    invitedAt:       row.invited_at || null,
    acceptedAt:      row.accepted_at || null,
    revokedAt:       row.revoked_at || null,
    inviteExpiresAt: pending?.expiresAt || null,
  };
}

export class HelperError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Owner action: mint + email a signed single-use invite for a staff row.
// Also used for "resend" (a fresh link; earlier pending ones are cancelled).
// Throws HelperError(400/409) with a plain message the UI shows as-is.
export async function inviteHelper({ workspaceId, owner, staff }) {
  const email = (staff.email || '').trim().toLowerCase();
  if (!email) throw new HelperError(400, 'Add an email for this helper first.');
  if (owner?.email && email === owner.email.toLowerCase()) {
    throw new HelperError(400, 'That is your own email. Helpers need their own sign-in.');
  }
  if (staff.user_id) throw new HelperError(409, 'This helper already has access.');
  if (!staff.active) throw new HelperError(400, 'Reactivate this staff member before inviting them.');

  // Seat check. A resend for a staff row that already holds a pending
  // seat doesn't need a new one.
  const pending = await pendingInvitesByStaff(workspaceId);
  const usage = await helperSeatUsage(workspaceId);
  if (!pending.has(staff.id) && usage.used >= HELPER_SEATS) {
    throw new HelperError(409, `Ivy includes ${HELPER_SEATS} helpers. Revoke one to invite another.`);
  }

  // One live link per staff row.
  await sql`
    UPDATE helper_invites SET cancelled_at = NOW()
     WHERE staff_member_id = ${staff.id} AND workspace_id = ${workspaceId}
       AND used_at IS NULL AND cancelled_at IS NULL
  `;
  const raw = generateRawToken();
  const expiresAt = new Date(Date.now() + HELPER_INVITE_TTL_DAYS * 86400 * 1000).toISOString();
  await sql`
    INSERT INTO helper_invites (workspace_id, staff_member_id, email, token_hash, expires_at)
    VALUES (${workspaceId}, ${staff.id}, ${email}, ${hashToken(raw)}, ${expiresAt})
  `;
  await sql`
    UPDATE staff_members SET email = ${email}, invited_at = NOW(), revoked_at = NULL, updated_at = NOW()
     WHERE id = ${staff.id} AND workspace_id = ${workspaceId}
  `;

  const branding = await fetchBranding(workspaceId);
  const bizName = branding.businessName || owner?.name || 'A business';
  const link = `${appUrl()}/helper/invite/${encodeURIComponent(raw)}`;
  const first = (staff.name || '').trim().split(/\s+/)[0] || '';
  const result = await sendEmail({
    to: email,
    subject: `${bizName} invited you to help out on Ivy`,
    replyTo: branding.replyTo,
    html: emailShell({
      heading: `Help out at ${escapeHtml(bizName)}`,
      branding,
      body: `<p>Hi${first ? ` ${escapeHtml(first)}` : ''},</p>
        <p><strong>${escapeHtml(bizName)}</strong> uses Ivy to run their business and invited you to help out.
        With your own sign-in you can see the sessions assigned to you, the client's contact details for
        those sessions, and mark them done.</p>
        <p>This link works once and expires in ${HELPER_INVITE_TTL_DAYS} days.</p>`,
      ctaText: 'Accept the invite',
      ctaUrl: link,
      footer: `If you were not expecting this, you can ignore this email.`,
    }),
  }).catch((err) => ({ sent: false, reason: err.message }));

  return { sent: result?.sent !== false && result?.ok !== false, expiresAt, reason: result?.reason || null };
}

// Owner action: drop a pending invite (link stops working).
export async function cancelHelperInvite({ workspaceId, staffId }) {
  await sql`
    UPDATE helper_invites SET cancelled_at = NOW()
     WHERE staff_member_id = ${staffId} AND workspace_id = ${workspaceId}
       AND used_at IS NULL AND cancelled_at IS NULL
  `;
  await sql`
    UPDATE staff_members SET invited_at = NULL, updated_at = NOW()
     WHERE id = ${staffId} AND workspace_id = ${workspaceId} AND user_id IS NULL
  `;
}

// Owner action: detach the helper's login. Their sessions lose helper
// access on the next request (membership cache invalidated).
export async function revokeHelper({ workspaceId, staffId }) {
  const before = await sql`
    SELECT user_id FROM staff_members WHERE id = ${staffId} AND workspace_id = ${workspaceId} LIMIT 1
  `;
  const userId = before.rows[0]?.user_id || null;
  if (!userId) return null;
  await sql`
    UPDATE staff_members
       SET user_id = NULL, accepted_at = NULL, invited_at = NULL,
           revoked_at = NOW(), revoked_user_id = ${userId}, updated_at = NOW()
     WHERE id = ${staffId} AND workspace_id = ${workspaceId}
  `;
  // Also kill any still-pending link so a revoked helper can't re-attach
  // through an old email.
  await sql`
    UPDATE helper_invites SET cancelled_at = NOW()
     WHERE staff_member_id = ${staffId} AND workspace_id = ${workspaceId}
       AND used_at IS NULL AND cancelled_at IS NULL
  `;
  invalidateHelperCache(userId);
  return userId;
}

// Look up an invite by its raw token. Returns the row or null when the
// token is unknown, used, cancelled or expired (one message for all four
// so the public endpoint is not an oracle).
export async function findLiveInvite(raw) {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 200) return null;
  const { rows } = await sql`
    SELECT hi.*, sm.name AS staff_name, sm.user_id AS staff_user_id, sm.active AS staff_active,
           w.owner_id, cs.biz_name, w.name AS workspace_name
      FROM helper_invites hi
      JOIN staff_members sm ON sm.id = hi.staff_member_id
      JOIN workspaces w ON w.id = hi.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
     WHERE hi.token_hash = ${hashToken(raw)}
     LIMIT 1
  `;
  const inv = rows[0];
  if (!inv) return null;
  if (inv.used_at || inv.cancelled_at) return null;
  if (new Date(inv.expires_at).getTime() <= Date.now()) return null;
  if (!inv.staff_active) return null;
  return inv;
}

// Attach `userId` to the invite's staff row and burn the token. The
// caller has already verified the user's email matches the invite.
// Returns false if the token was consumed concurrently (single-use).
export async function acceptInvite({ invite, userId }) {
  const burn = await sql`
    UPDATE helper_invites SET used_at = NOW()
     WHERE id = ${invite.id} AND used_at IS NULL AND cancelled_at IS NULL
    RETURNING id
  `;
  if (burn.rowCount === 0) return false;
  await sql`
    UPDATE staff_members
       SET user_id = ${userId}, accepted_at = NOW(), revoked_at = NULL, revoked_user_id = NULL, updated_at = NOW()
     WHERE id = ${invite.staff_member_id} AND workspace_id = ${invite.workspace_id}
  `;
  invalidateHelperCache(userId);
  return true;
}

// For the accept page's dead-link copy: why a known token no longer
// works. Returns null for a token we have never seen (nothing to say),
// otherwise { status: 'used' | 'cancelled' | 'expired', businessName }.
// Only the holder of the emailed link can reach this, so naming the
// business is fine; the token itself is 32 random bytes.
export async function deadInviteState(raw) {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 200) return null;
  const { rows } = await sql`
    SELECT hi.used_at, hi.cancelled_at, hi.expires_at, cs.biz_name, w.name AS workspace_name
      FROM helper_invites hi
      JOIN workspaces w ON w.id = hi.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
     WHERE hi.token_hash = ${hashToken(raw)}
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  const businessName = r.biz_name || r.workspace_name || 'this business';
  if (r.cancelled_at) return { status: 'cancelled', businessName };
  if (r.used_at) return { status: 'used', businessName };
  if (new Date(r.expires_at).getTime() <= Date.now()) return { status: 'expired', businessName };
  return { status: 'inactive', businessName };
}

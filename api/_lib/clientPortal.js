// Helpers for the /api/me client-portal endpoints.
//
// A user can be:
//   • An OWNER of a workspace (workspaces.owner_id = user.id)
//   • A CLIENT of one or more businesses (clients.user_id = user.id, OR
//     clients.email matches the user's email — the latter handles "claim
//     your account" before user_id is wired up)
//   • Both, if they own a business AND book with another business
//
// All client-portal queries are scoped to the joined set of `clients` rows
// owned by this user. We never trust user-supplied workspaceId / clientId
// — every read is filtered through `myClientIds()` so a malicious request
// can't peek at someone else's data.
import { sql } from './db.js';

// Returns the IDs of every `clients` row this user owns, across workspaces.
// Matches by user_id first, then auto-claims any rows with the same email
// (so links pre-dating signup get attached to the user).
export async function myClientIds(user) {
  // First, opportunistically claim rows by email match. Idempotent — only
  // updates rows that aren't already linked.
  if (user.email) {
    await sql`
      UPDATE clients
      SET user_id = ${user.id}
      WHERE email = ${user.email.toLowerCase()}
        AND (user_id IS NULL OR user_id <> ${user.id})
    `;
  }

  const { rows } = await sql`
    SELECT c.id, c.workspace_id, c.name, c.email,
           w.name AS workspace_name,
           cs.biz_name
    FROM clients c
    JOIN workspaces w ON w.id = c.workspace_id
    LEFT JOIN calendar_settings cs ON cs.workspace_id = c.workspace_id
    WHERE c.user_id = ${user.id}
    ORDER BY COALESCE(cs.biz_name, w.name) ASC
  `;
  return rows.map((r) => ({
    clientId:     r.id,
    workspaceId:  r.workspace_id,
    clientName:   r.name,
    clientEmail:  r.email,
    businessName: r.biz_name || r.workspace_name || 'Business',
  }));
}

// Convenience: just the IDs for SQL `WHERE c.id IN (...)` checks.
export function ids(memberships) {
  return memberships.map((m) => m.clientId);
}

// Does this user own a workspace? Returns { id, onboardedAt } or null.
// (Used to decide which app to show after sign-in: business, client, or
// a switcher — and whether to route a fresh owner through /onboarding.)
export async function ownsWorkspace(userId) {
  const { rows } = await sql`
    SELECT id, onboarded_at FROM workspaces WHERE owner_id = ${userId} LIMIT 1
  `;
  return rows.length > 0
    ? { id: rows[0].id, onboardedAt: rows[0].onboarded_at }
    : null;
}

// Build a context object the frontend uses to choose the default app +
// render the view-switcher only when the user is genuinely both.
export async function userContext(user) {
  const [workspace, memberships] = await Promise.all([
    ownsWorkspace(user.id),
    myClientIds(user),
  ]);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerifiedAt: user.email_verified_at,
    },
    isOwner:  !!workspace,
    isClient: memberships.length > 0,
    workspaceId: workspace?.id || null,
    onboardedAt: workspace?.onboardedAt || null,
    memberships,
  };
}

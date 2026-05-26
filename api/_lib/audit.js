// Lightweight audit logger. Every super-admin-initiated mutation should
// pass through here so there's a record of who-did-what-when.
//
// Designed to be fire-and-forget: a logging failure must never block the
// user-visible action. If the DB is wedged we'd rather lose the audit
// row than 500 a password reset.
//
// Usage:
//   await recordAudit(req, {
//     actor: superAdminUser,
//     targetUserId: editedUser.id,
//     action: 'user.set_type',
//     meta: { from: 'regular', to: 'sponsored' },
//   });
import { sql } from './db.js';
import { getClientIp } from './rate-limit.js';

export async function recordAudit(req, { actor, targetUserId = null, action, meta = {} }) {
  if (!action) return;
  try {
    const actorId    = actor?.id || null;
    const actorEmail = actor?.email || null;
    const ip = req ? getClientIp(req) : null;
    const ua = req?.headers?.['user-agent']?.toString().slice(0, 500) || null;
    await sql`
      INSERT INTO audit_events
        (actor_user_id, actor_email, target_user_id, action, meta, ip, user_agent)
      VALUES
        (${actorId}, ${actorEmail}, ${targetUserId}, ${action},
         ${JSON.stringify(meta || {})}::jsonb, ${ip}, ${ua})
    `;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit] failed:', action, err.message);
  }
}

// Workspace-scoped audit. Same fire-and-forget contract as recordAudit
// but targets a (workspace, entity-kind, entity-id) triple rather than
// a single user. Use for owner-initiated mutations that need an
// immutable trail:
//   invoice.refund   invoice.void   client.delete
//   document.void    workflow.toggle  subscription.cancel
//
// All three of (workspace_id, target_kind, target_id) live on audit_events
// as nullable columns; super-admin writes continue to use recordAudit
// which leaves them NULL. Workspace owners can later list their own
// audit trail by filtering workspace_id = their_workspace.
//
// Usage:
//   await recordWorkspaceAudit(req, {
//     workspaceId, actor: user,
//     action: 'invoice.refund',
//     target: { kind: 'invoice', id: inv.id },
//     meta: { amount, reason, method },
//   });
export async function recordWorkspaceAudit(req, { workspaceId, actor, action, target, meta = {} }) {
  if (!workspaceId || !action) return;
  try {
    const actorId    = actor?.id || null;
    const actorEmail = actor?.email || null;
    const ip = req ? getClientIp(req) : null;
    const ua = req?.headers?.['user-agent']?.toString().slice(0, 500) || null;
    const targetKind = target?.kind || null;
    const targetId   = target?.id != null ? String(target.id) : null;
    await sql`
      INSERT INTO audit_events
        (actor_user_id, actor_email, workspace_id, action,
         target_kind, target_id, meta, ip, user_agent)
      VALUES
        (${actorId}, ${actorEmail}, ${workspaceId}, ${action},
         ${targetKind}, ${targetId},
         ${JSON.stringify(meta || {})}::jsonb, ${ip}, ${ua})
    `;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[workspace-audit] failed:', action, err.message);
  }
}

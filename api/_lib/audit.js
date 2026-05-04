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

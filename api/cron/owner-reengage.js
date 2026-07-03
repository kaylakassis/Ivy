// Dormant-owner re-engagement. THRYVE catches billing churn (dunning,
// win-back) but nothing catches USAGE churn: a subscribed/trialing owner who
// simply stops logging in was invisible until they cancelled. This cron reaches
// them while they're still paying — the moment we can still save the account.
//
// Eligibility: onboarded, currently subscribed/trialing/past_due, and their
// user was active before but hasn't been for DORMANT_DAYS. One-shot per
// dormancy episode via users.dormant_nudge_sent_at, which requireUser CLEARS
// when they come back — so a later dormancy episode can re-fire.
//
// Auth: same three paths as the other crons (Vercel cron header / admin secret
// / super-admin session). Registered in vercel.json.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyDormantOwner } from '../_lib/subscriptionNotify.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const DORMANT_DAYS = 10;
const MAX_PER_RUN = 200;

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const { rows } = await sql.query(
      `SELECT w.id AS workspace_id, u.id AS user_id
         FROM workspaces w
         JOIN users u ON u.id = w.owner_id
        WHERE w.subscription_status IN ('trialing', 'active', 'past_due')
          AND w.onboarded_at IS NOT NULL
          AND u.last_active_at IS NOT NULL
          AND u.last_active_at < NOW() - ($1::int || ' days')::interval
          AND u.dormant_nudge_sent_at IS NULL
          AND u.email IS NOT NULL
          AND COALESCE(u.user_type, 'regular') <> 'sponsored'
        ORDER BY u.last_active_at ASC
        LIMIT $2`,
      [DORMANT_DAYS, MAX_PER_RUN],
    );

    let sent = 0;
    for (const r of rows) {
      // Stamp under the IS NULL guard first; a lost race (retry / concurrent
      // run) returns zero rows and we skip without re-sending.
      // eslint-disable-next-line no-await-in-loop
      const upd = await sql.query(
        `UPDATE users SET dormant_nudge_sent_at = NOW()
           WHERE id = $1 AND dormant_nudge_sent_at IS NULL
           RETURNING id`,
        [r.user_id],
      );
      if (upd.rows.length === 0) continue;
      sent++;
      notifyDormantOwner({ workspaceId: r.workspace_id })
        .catch((e) => console.error('[owner-reengage] notify failed:', r.workspace_id, e?.message));
    }
    return ok(res, { scanned: rows.length, sent });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('owner-reengage', handler);

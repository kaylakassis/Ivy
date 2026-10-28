// Plan-ending reminder. An owner who turned auto-renew off (Stripe
// cancel_at_period_end, Apple CANCELLATION) keeps access to the end of the
// paid period; ~2 days before that we send one email + push saying the
// date and that the booking page, website and client portal will be
// archived. Stamp-first so retries and shards never double-send; the
// stamp is cleared by the billing webhooks when renewal is turned back on.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyPlanEnding } from '../_lib/subscriptionNotify.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

const BATCH_SIZE = 500;

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);
  try {
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');
    let scanned = 0, sent = 0, emptied = true;
    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        const { rows } = await sql.query(
          `SELECT w.id AS workspace_id, w.subscription_period_end, w.subscription_source
             FROM workspaces w
             JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
            WHERE w.cancel_at_period_end = TRUE
              AND w.subscription_status = 'active'
              AND w.subscription_period_end > NOW()
              AND w.subscription_period_end <= NOW() + INTERVAL '2 days'
              AND w.plan_ending_reminder_sent_at IS NULL
              AND u.email IS NOT NULL
              ${shardFilter}
            ORDER BY w.subscription_period_end ASC
            LIMIT $1`,
          [BATCH_SIZE],
        );
        if (rows.length === 0) break;
        scanned += rows.length;
        for (const r of rows) {
            const upd = await sql.query(
            `UPDATE workspaces SET plan_ending_reminder_sent_at = NOW()
              WHERE id = $1 AND plan_ending_reminder_sent_at IS NULL RETURNING id`,
            [r.workspace_id],
          );
          if (upd.rows.length === 0) continue;
          sent++;
            await notifyPlanEnding({ workspaceId: r.workspace_id, endsAt: r.subscription_period_end, source: r.subscription_source });
          if (Date.now() >= deadline) { emptied = false; break; }
        }
      }
    });
    return ok(res, { shard, shards, scanned, sent, terminatedBy: terminationReason({ emptied, hitCap: false }) });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('plan-ending', handler);

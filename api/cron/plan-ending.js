// Plan-ending reminder. An owner who turned auto-renew off (Stripe
// cancel_at_period_end, Apple CANCELLATION) keeps access to the end of the
// paid period; ~2 days before that we send one email + push saying the
// date and that the booking page, website and client portal will be
// archived. Stamp-first so retries and shards never double-send; the
// stamp is cleared by the billing webhooks when renewal is turned back on.
import { sql } from '../_lib/db.js';
import { cronAuthorized } from '../_lib/cronAuth.js';
import { notifyPlanEnding } from '../_lib/subscriptionNotify.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

const BATCH_SIZE = 500;

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');
    let scanned = 0, sent = 0, emptied = true;
    // Rows whose email failed this run: handed back for the next run, not
    // picked up again by this one (so a mail outage cannot spin the loop).
    const failedIds = new Set();
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
              AND NOT (w.id = ANY($2::uuid[]))
              ${shardFilter}
            ORDER BY w.subscription_period_end ASC
            LIMIT $1`,
          [BATCH_SIZE, [...failedIds]],
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
          // Claimed above (never twice); an email the provider did not
          // accept hands the claim back so the next run retries it.
          const mail = await notifyPlanEnding({ workspaceId: r.workspace_id, endsAt: r.subscription_period_end, source: r.subscription_source, retryable: true });
          if (mail?.ok === false) {
            failedIds.add(r.workspace_id);
            await sql`UPDATE workspaces SET plan_ending_reminder_sent_at = NULL WHERE id = ${r.workspace_id}`.catch(() => {});
          } else {
            sent++;
          }
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

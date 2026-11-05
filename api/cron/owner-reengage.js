// Dormant-owner re-engagement. Ivy catches billing churn (dunning,
// win-back) but nothing catches USAGE churn: a subscribed/trialing owner who
// simply stops logging in was invisible until they cancelled. This cron reaches
// them while they're still paying — the moment we can still save the account.
//
// Eligibility: onboarded, currently subscribed/trialing/past_due, and their
// user was active before but hasn't been for DORMANT_DAYS. One-shot per
// dormancy episode via users.dormant_nudge_sent_at, which requireUser CLEARS
// when they come back — so a later dormancy episode can re-fire.
//
// Since 1.0.6 this only runs for owners who turned the accountability
// partner OFF: the partner's own away check-ins cover everyone else.
//
// Auth: same three paths as the other crons (Vercel cron header / admin secret
// / super-admin session). Registered in vercel.json.
import { sql } from '../_lib/db.js';
import { cronAuthorized } from '../_lib/cronAuth.js';
import { notifyDormantOwner } from '../_lib/subscriptionNotify.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

const DORMANT_DAYS = 10;
// Per-batch fetch size. The deadline-drain loop keeps pulling batches until the
// candidate set empties or we near the function budget — so a backlog bigger
// than one batch is DRAINED across the run rather than silently truncated at a
// hard MAX_PER_RUN (the old behavior dropped everyone past #200 until tomorrow,
// and never caught up once daily inflow exceeded the cap). Sends are awaited so
// we don't spawn unbounded concurrent emails past Resend's account throughput;
// `shardFilter` lets the cron fan out horizontally when needed.
const BATCH_SIZE = 200;

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);

  try {
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');

    let scanned = 0, sent = 0, emptied = false;
    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // Stamp-then-send means a row processed in one batch has its
        // dormant_nudge_sent_at set, so it drops out of the next batch's
        // candidate query — the loop drains and terminates naturally.
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `SELECT w.id AS workspace_id, u.id AS user_id
             FROM workspaces w
             JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
            WHERE w.subscription_status IN ('trialing', 'active', 'past_due')
              AND w.onboarded_at IS NOT NULL
              AND u.last_active_at IS NOT NULL
              AND u.last_active_at < NOW() - ($1::int || ' days')::interval
              AND u.dormant_nudge_sent_at IS NULL
              AND u.email IS NOT NULL
              AND COALESCE(u.user_type, 'regular') <> 'sponsored'
              -- Owners with the accountability partner on get its 3-day and
              -- 7-day check-ins instead (api/cron/accountability-partner.js),
              -- then nothing until they return; no third "away" email here.
              AND u.notification_prefs->>'accountability' = 'false'
              ${shardFilter}
            ORDER BY u.last_active_at ASC
            LIMIT $2`,
          [DORMANT_DAYS, BATCH_SIZE],
        );
        if (rows.length === 0) { emptied = true; break; }
        scanned += rows.length;
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
          // Awaited (not fire-and-forget) so the drain loop doesn't spawn
          // thousands of concurrent sends; notifyDormantOwner never throws.
          // eslint-disable-next-line no-await-in-loop
          await notifyDormantOwner({ workspaceId: r.workspace_id })
            .catch((e) => console.error('[owner-reengage] notify failed:', r.workspace_id, e?.message));
          if (Date.now() >= deadline) break;
        }
      }
    });

    const terminatedBy = terminationReason({ emptied, hitCap: false });
    return ok(res, { shard, shards, scanned, sent, terminatedBy });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('owner-reengage', handler);

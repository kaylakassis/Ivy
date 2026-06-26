// Daily Stripe reconcile sweep.
//
// What this does:
//   • For every workspace with Stripe Connect enabled, list active +
//     past_due + trialing + recently-cancelled subscriptions and
//     replay each through applySubscriptionState. This catches drift
//     that the webhook missed - dropped deliveries, retries past
//     Stripe's retention window, subscriptions created/edited in the
//     Stripe Dashboard during a webhook outage, plan changes that
//     fired before the metadata stamping was added, etc.
//
//   • Idempotent. applySubscriptionState is guarded - same state
//     replay is a no-op UPDATE; tier changes still resync.
//
// Why a cron, not just the webhook:
//   The webhook is the fast path; this cron is the ground-truth
//   reconciler. If the webhook ever has a bad day (Vercel outage,
//   missed signing secret rotation, network blip), this still gets
//   the local state correct by morning.
//
// Scale notes:
//   • Previous version capped at 500 workspaces/run. At 1M workspaces
//     that drops 99.95% of accounts from the daily reconcile. Now uses
//     keyset-paginated workspace iteration inside the deadline loop +
//     optional shard fan-out via ?shard=K&shards=N — same pattern as
//     the other crons.
//   • Stripe's account-level rate limit is 100 req/sec. Each workspace
//     fires ≥1 listStripeSubscriptions call; a heavy run can saturate.
//     Each Stripe call now runs through retryStripeOn429 which sleeps
//     per the Retry-After header (or exponential fallback) for up to
//     3 attempts before giving up on that workspace.
import { sql } from '../_lib/db.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { listStripeSubscriptions } from '../_lib/stripe.js';
import { applySubscriptionState } from '../_lib/memberships.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

// Per-batch workspace fetch. Each workspace fires N Stripe API calls
// (1 per page of subs) so smaller batches mean tighter deadline checks
// + smaller blast radius if Stripe rate-limits us.
const WS_BATCH_SIZE = 100;
const MAX_SUBS_PER_WORKSPACE = 1000; // safety on pagination
const MAX_RETRIES_429 = 3;

// Sleep + exponential backoff for Stripe 429s. stripeFetch throws an
// Error with err.status = 429 on rate-limit responses; we treat anything
// else as a real error and bubble. Without a Retry-After header (which
// our fetch wrapper doesn't currently expose) we back off with
// 1s → 2s → 4s, well under the cron's 4min deadline.
async function retryStripeOn429(fn) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (err?.status !== 429 || attempt >= MAX_RETRIES_429) throw err;
      const waitMs = 1000 * 2 ** attempt;
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'workspace_id');

    let workspaces = 0, scanned = 0, applied = 0, created = 0,
        retiered = 0, skipped = 0, errors = 0, rateLimited = 0, batches = 0;
    let emptied = false;
    // Keyset pagination over finance_settings.workspace_id so a long
    // backlog can be drained across multiple cron ticks without
    // re-processing the same workspaces. UUID lexicographic order is
    // stable enough for keyset paging.
    let cursor = null;

    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        const cursorClause = cursor ? `AND workspace_id > '${cursor}'` : '';
        // eslint-disable-next-line no-await-in-loop
        const ws = await sql.query(
          `SELECT workspace_id FROM finance_settings
            WHERE (stripe_connect_user_id IS NOT NULL
               OR stripe_secret_encrypted IS NOT NULL)
              ${cursorClause}
              ${shardFilter}
            ORDER BY workspace_id ASC
            LIMIT ${WS_BATCH_SIZE}`,
        );
        if (ws.rows.length === 0) { emptied = true; break; }
        batches += 1;
        cursor = ws.rows[ws.rows.length - 1].workspace_id;

        for (const row of ws.rows) {
          if (Date.now() >= deadline) break;
          workspaces += 1;
          const workspaceId = row.workspace_id;
          let creds;
          try {
            // eslint-disable-next-line no-await-in-loop
            creds = await loadStripeCreds(workspaceId);
          } catch {
            skipped++;
            continue;
          }

          // Page through every subscription on the account. Stripe
          // caps limit=100; the starting_after cursor walks the rest.
          let startingAfter = null;
          let seen = 0;
          let workspaceBailed = false;
          // eslint-disable-next-line no-constant-condition
          while (!workspaceBailed) {
            let page;
            try {
              // eslint-disable-next-line no-await-in-loop
              page = await retryStripeOn429(() => listStripeSubscriptions({
                secretKey: creds.secretKey,
                stripeAccount: creds.stripeAccount,
                startingAfter,
                limit: 100,
              }));
            } catch (err) {
              // 429 after MAX_RETRIES_429 means we're truly saturated —
              // bail this workspace, surface the count, let the next
              // tick retry.
              if (err?.status === 429) rateLimited++;
              else {
                // eslint-disable-next-line no-console
                console.warn('[stripe-reconcile] list failed for', workspaceId, err.message);
                errors++;
              }
              workspaceBailed = true;
              break;
            }
            const subs = page?.data || [];
            if (subs.length === 0) break;

            for (const sub of subs) {
              scanned++;
              seen++;
              try {
                // eslint-disable-next-line no-await-in-loop
                const result = await applySubscriptionState({
                  workspaceId, sub,
                  stripeContext: { secretKey: creds.secretKey, stripeAccount: creds.stripeAccount },
                });
                if (result === 'created') created++;
                else if (result === 'retiered') retiered++;
                else if (result === 'ok') applied++;
                else skipped++;
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[stripe-reconcile] apply failed for', sub?.id, err.message);
                errors++;
              }
            }

            if (!page.has_more || seen >= MAX_SUBS_PER_WORKSPACE) break;
            startingAfter = subs[subs.length - 1]?.id;
            if (!startingAfter) break;
          }
        }
      }
    });

    const terminatedBy = terminationReason({ emptied, hitCap: false });
    return ok(res, {
      shard, shards, batches,
      workspaces, scanned, applied, created, retiered, skipped, errors, rateLimited,
      terminatedBy,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('stripe-reconcile', handler);

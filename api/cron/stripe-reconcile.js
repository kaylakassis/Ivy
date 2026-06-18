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
import { sql } from '../_lib/db.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { listStripeSubscriptions } from '../_lib/stripe.js';
import { applySubscriptionState } from '../_lib/memberships.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const MAX_WORKSPACES_PER_RUN = 500;
const MAX_SUBS_PER_WORKSPACE = 1000; // pagination guard

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const ws = await sql`
      SELECT workspace_id FROM finance_settings
       WHERE stripe_connect_user_id IS NOT NULL
          OR stripe_secret_encrypted IS NOT NULL
       LIMIT ${MAX_WORKSPACES_PER_RUN}
    `;

    let scanned = 0, applied = 0, created = 0, retiered = 0, skipped = 0, errors = 0;

    for (const row of ws.rows) {
      const workspaceId = row.workspace_id;
      let creds;
      try {
        creds = await loadStripeCreds(workspaceId);
      } catch {
        skipped++;
        continue;
      }

      // Page through every subscription on the account. Stripe caps
      // limit=100; the starting_after cursor walks the rest.
      let startingAfter = null;
      let seen = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let page;
        try {
          page = await listStripeSubscriptions({
            secretKey: creds.secretKey,
            stripeAccount: creds.stripeAccount,
            startingAfter,
            limit: 100,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[stripe-reconcile] list failed for', workspaceId, err.message);
          errors++;
          break;
        }
        const subs = page?.data || [];
        if (subs.length === 0) break;

        for (const sub of subs) {
          scanned++;
          seen++;
          try {
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

    return ok(res, {
      workspaces: ws.rows.length,
      scanned, applied, created, retiered, skipped, errors,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('stripe-reconcile', handler);

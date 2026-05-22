// GET /api/admin/analytics?from=ISO&to=ISO
//
// Single round-trip with parallel sub-queries, so the admin overview
// loads fast even when the user picks "all time" against a sizeable
// users table. All counters are inclusive on `from`, exclusive on `to`.
//
// Response shape:
//   {
//     range: { from, to },
//     totals: {
//       users: <count of distinct users.id, dedupes business+client>,
//       newSignups: <users.created_at within window>,
//       businessActive: <workspaces.subscription_status='active'>,
//       businessTrial:  <workspaces.subscription_status='trialing' AND trial_ends_at>NOW()>,
//       sponsored:      <users.user_type='sponsored'>,
//       affiliate:      <users.user_type='affiliate'>,
//       clientOnly:     <users without a workspace, who claim 1+ clients rows>,
//       revenueAllTime: <sum paid invoices, all platforms>,
//       revenueWindow:  <same, within window>,
//     },
//     churn: {
//       cancelledInWindow,
//       activeAtWindowStart,
//       ratePct,
//     }
//   }
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const fromRaw = (req.query.from || '').toString();
    const toRaw   = (req.query.to   || '').toString();
    const fromIso = parseDate(fromRaw, '1970-01-01T00:00:00Z');
    const toIso   = parseDate(toRaw, new Date().toISOString());
    if (!fromIso || !toIso) return badRequest(res, 'Invalid from/to');

    // Parallelize. Each query is independent.
    const [
      usersRow,
      signupsRow,
      bizActiveRow,
      bizTrialRow,
      sponsoredRow,
      affiliateRow,
      clientOnlyRow,
      revenueAllRow,
      revenueWindowRow,
      churnCancelledRow,
      churnActiveAtStartRow,
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM users`,
      sql.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE created_at >= $1 AND created_at < $2`,
        [fromIso, toIso],
      ),
      sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE subscription_status = 'active'`,
      sql`SELECT COUNT(*)::int AS n FROM workspaces
            WHERE subscription_status = 'trialing'
              AND trial_ends_at IS NOT NULL
              AND trial_ends_at > NOW()`,
      sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'sponsored'`,
      sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'affiliate'`,
      // "Client-only" — users who don't own a workspace but DO have at
      // least one clients row claimed under their user_id. Avoids
      // counting bare auth records that haven't been linked anywhere.
      sql`SELECT COUNT(DISTINCT u.id)::int AS n
            FROM users u
            WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
              AND EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id)`,
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
          FROM invoices WHERE status = 'paid'`,
      sql.query(
        `SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
          FROM invoices
          WHERE status = 'paid' AND paid_at >= $1 AND paid_at < $2`,
        [fromIso, toIso],
      ),
      // Churn in the window: count of workspaces that flipped to
      // 'cancelled' (we don't track the moment of state change yet so
      // approximate via subscription_period_end falling inside the window
      // for cancelled rows).
      sql.query(
        `SELECT COUNT(*)::int AS n FROM workspaces
          WHERE subscription_status = 'cancelled'
            AND subscription_period_end >= $1
            AND subscription_period_end < $2`,
        [fromIso, toIso],
      ),
      // Active denominator at start of window — best-effort proxy:
      // workspaces created before window start that are or were paying.
      sql.query(
        `SELECT COUNT(*)::int AS n FROM workspaces
          WHERE created_at < $1
            AND subscription_status IN ('active', 'past_due', 'trialing', 'cancelled')`,
        [fromIso],
      ),
    ]);

    const cancelled = churnCancelledRow.rows[0]?.n || 0;
    const denom = churnActiveAtStartRow.rows[0]?.n || 0;
    const ratePct = denom > 0 ? Math.round((cancelled / denom) * 1000) / 10 : 0;

    return ok(res, {
      range: { from: fromIso, to: toIso },
      totals: {
        users:           usersRow.rows[0]?.n || 0,
        newSignups:      signupsRow.rows[0]?.n || 0,
        businessActive:  bizActiveRow.rows[0]?.n || 0,
        businessTrial:   bizTrialRow.rows[0]?.n || 0,
        sponsored:       sponsoredRow.rows[0]?.n || 0,
        affiliate:       affiliateRow.rows[0]?.n || 0,
        clientOnly:      clientOnlyRow.rows[0]?.n || 0,
        revenueAllTime:  Number(revenueAllRow.rows[0]?.total || 0),
        revenueWindow:   Number(revenueWindowRow.rows[0]?.total || 0),
      },
      churn: {
        cancelledInWindow:   cancelled,
        activeAtWindowStart: denom,
        ratePct,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

function parseDate(raw, fallback) {
  if (!raw) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

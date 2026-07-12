// GET /api/admin/referrals?from=ISO&to=ISO
//   Self-serve referral program overview ("refer a friend, you both get a
//   free week"): program totals, conversion rate, reward payout, top
//   referrers, and recent conversions. Read-only. Distinct from the paid
//   affiliates program (api/admin/affiliates.js) - this aggregates the
//   `referrals` table. Window (from/to) filters the signup/conversion
//   counts; the top-referrer and reward totals are all-time.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

function safeIso(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

    const fromRaw = (req.query.from || '').toString();
    const toRaw   = (req.query.to   || '').toString();
    const fromIso = fromRaw ? safeIso(fromRaw) : '1970-01-01T00:00:00Z';
    const toIso   = toRaw   ? safeIso(toRaw)   : new Date().toISOString();
    if (!fromIso || !toIso) return badRequest(res, 'Invalid from/to');

    const [totals, top, recent] = await Promise.all([
      sql`
        SELECT
          COUNT(*)::int                                                 AS referrals,
          COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int         AS converted,
          COUNT(*) FILTER (WHERE rewarded_at IS NOT NULL)::int          AS referrer_rewarded,
          COUNT(*) FILTER (WHERE referred_rewarded_at IS NOT NULL)::int AS referred_rewarded,
          (COALESCE(SUM(reward_cents) FILTER (WHERE rewarded_at IS NOT NULL), 0)
           + COALESCE(SUM(referred_reward_cents) FILTER (WHERE referred_rewarded_at IS NOT NULL), 0))::bigint AS reward_cents,
          COUNT(*) FILTER (WHERE signed_up_at >= ${fromIso} AND signed_up_at < ${toIso})::int AS referrals_window,
          COUNT(*) FILTER (WHERE converted_at >= ${fromIso} AND converted_at < ${toIso})::int AS converted_window
        FROM referrals
      `,
      sql`
        SELECT r.referrer_user_id, u.email, u.name,
               COUNT(*)::int                                          AS referred,
               COUNT(*) FILTER (WHERE r.converted_at IS NOT NULL)::int AS converted
        FROM referrals r
        LEFT JOIN users u ON u.id = r.referrer_user_id
        GROUP BY r.referrer_user_id, u.email, u.name
        ORDER BY converted DESC, referred DESC
        LIMIT 20
      `,
      sql`
        SELECT r.converted_at,
               ru.email AS referred_email, ru.name AS referred_name,
               rr.email AS referrer_email, rr.name AS referrer_name
        FROM referrals r
        LEFT JOIN users ru ON ru.id = r.referred_user_id
        LEFT JOIN users rr ON rr.id = r.referrer_user_id
        WHERE r.converted_at IS NOT NULL
        ORDER BY r.converted_at DESC
        LIMIT 20
      `,
    ]);

    const t = totals.rows[0] || {};
    const referrals = Number(t.referrals || 0);
    const converted = Number(t.converted || 0);

    return ok(res, {
      range: { from: fromIso, to: toIso },
      totals: {
        referrals,
        converted,
        conversionRate: referrals ? Math.round((converted / referrals) * 1000) / 10 : 0,
        referrerRewarded: Number(t.referrer_rewarded || 0),
        referredRewarded: Number(t.referred_rewarded || 0),
        rewardCents: Number(t.reward_cents || 0),
        referralsWindow: Number(t.referrals_window || 0),
        convertedWindow: Number(t.converted_window || 0),
      },
      topReferrers: top.rows.map((r) => ({
        user: { id: r.referrer_user_id, email: r.email, name: r.name },
        referred: Number(r.referred),
        converted: Number(r.converted),
      })),
      recent: recent.rows.map((r) => ({
        convertedAt: r.converted_at,
        referred: r.referred_name || r.referred_email || 'A friend',
        referrer: r.referrer_name || r.referrer_email || 'Someone',
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

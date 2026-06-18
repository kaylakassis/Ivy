// GET /api/website/traffic - owner-facing analytics rollup.
//
// Returns 30-day aggregate pageviews bucketed by:
//   • day (for the sparkline chart)
//   • page slug (for the "most viewed pages" list)
//   • referrer source (for "top referrers")
//   • UA class (mobile vs desktop vs bot - useful sanity check)
//
// All data lives in `website_pageviews`. No PII anywhere.

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const siteRow = await sql`SELECT id FROM websites WHERE workspace_id = ${workspaceId}`;
    if (siteRow.rows.length === 0) {
      return ok(res, { total: 0, byDay: [], byPage: [], byReferrer: [], byUa: [] });
    }
    const siteId = siteRow.rows[0].id;

    // All four roll-ups in one DB round-trip via Promise.all. Each
    // returns a small array; total counts are cheap.
    const [byDay, byPage, byReferrer, byUa, total] = await Promise.all([
      sql`
        SELECT TO_CHAR(date_trunc('day', viewed_at), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS n
        FROM website_pageviews
        WHERE website_id = ${siteId}
          AND viewed_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 1
      `,
      sql`
        SELECT page_slug AS slug, COUNT(*)::int AS n
        FROM website_pageviews
        WHERE website_id = ${siteId}
          AND viewed_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20
      `,
      sql`
        SELECT COALESCE(NULLIF(referrer, ''), '(direct)') AS source, COUNT(*)::int AS n
        FROM website_pageviews
        WHERE website_id = ${siteId}
          AND viewed_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20
      `,
      sql`
        SELECT ua_class AS class, COUNT(*)::int AS n
        FROM website_pageviews
        WHERE website_id = ${siteId}
          AND viewed_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 2 DESC
      `,
      sql`
        SELECT COUNT(*)::int AS n
        FROM website_pageviews
        WHERE website_id = ${siteId}
          AND viewed_at > NOW() - INTERVAL '30 days'
      `,
    ]);

    return ok(res, {
      total:      total.rows[0]?.n || 0,
      byDay:      byDay.rows,
      byPage:     byPage.rows,
      byReferrer: byReferrer.rows,
      byUa:       byUa.rows,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

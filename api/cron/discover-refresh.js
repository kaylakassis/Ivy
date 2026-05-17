// Refreshes discover_snapshots — precomputes the static-derived fields
// the /discover page needs (service_count, min/max_price, cover_photo,
// site_handle, review_count, rating_avg) so the user-facing endpoint
// runs a single JOIN instead of N×8 subqueries.
//
// Runs every 15 min. One single SQL statement does the whole refresh
// via INSERT ... ON CONFLICT DO UPDATE — atomic per row, idempotent
// across runs, and short enough to fit comfortably in the function
// budget even at 50K workspaces.
//
// Why we don't precompute the FILTERED `matching_services` aggregation:
// that depends on the per-request query/price filters and can't be
// cached. Left as an inline subquery in discover.js — still cheap
// because services has (workspace_id, price) covered.
import { sql } from '../_lib/db.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  try {
    const t0 = Date.now();
    // One server-side SQL computes the snapshot for every workspace
    // that's discoverable (has a calendar_settings row). UPSERTs into
    // discover_snapshots; rows for workspaces that no longer match
    // are pruned in a second statement.
    const upsert = await sql`
      INSERT INTO discover_snapshots (
        workspace_id, service_count, min_price, max_price,
        cover_photo_url, site_handle, review_count, rating_avg,
        refreshed_at
      )
      SELECT
        cs.workspace_id,
        COALESCE((SELECT COUNT(*)::int FROM services s
                   WHERE s.workspace_id = cs.workspace_id
                     AND s.visibility = 'public'), 0),
        (SELECT MIN(price)::numeric FROM services s
          WHERE s.workspace_id = cs.workspace_id AND s.visibility = 'public'),
        (SELECT MAX(price)::numeric FROM services s
          WHERE s.workspace_id = cs.workspace_id AND s.visibility = 'public'),
        (SELECT photo_url FROM services s_cover
          WHERE s_cover.workspace_id = cs.workspace_id
            AND s_cover.photo_url IS NOT NULL
            AND s_cover.visibility = 'public'
          ORDER BY s_cover.display_order ASC LIMIT 1),
        (SELECT w.handle FROM websites w
          WHERE w.workspace_id = cs.workspace_id
            AND w.launched = TRUE
            AND w.visibility = 'public'
          LIMIT 1),
        COALESCE((SELECT COUNT(*)::int FROM reviews r
                   WHERE r.workspace_id = cs.workspace_id
                     AND r.status = 'visible'), 0),
        (SELECT AVG(rating)::numeric FROM reviews r
          WHERE r.workspace_id = cs.workspace_id AND r.status = 'visible'),
        NOW()
      FROM calendar_settings cs
      ON CONFLICT (workspace_id) DO UPDATE SET
        service_count   = EXCLUDED.service_count,
        min_price       = EXCLUDED.min_price,
        max_price       = EXCLUDED.max_price,
        cover_photo_url = EXCLUDED.cover_photo_url,
        site_handle     = EXCLUDED.site_handle,
        review_count    = EXCLUDED.review_count,
        rating_avg      = EXCLUDED.rating_avg,
        refreshed_at    = NOW()
    `;

    // Prune snapshots for workspaces that lost their calendar_settings
    // (deleted). FK cascade handles workspace deletion; this catches
    // the (rare) case where someone wipes calendar_settings directly.
    const pruned = await sql`
      DELETE FROM discover_snapshots
      WHERE workspace_id NOT IN (SELECT workspace_id FROM calendar_settings)
    `;

    return ok(res, {
      ok: true,
      upserted: upsert.rowCount ?? 0,
      pruned: pruned.rowCount ?? 0,
      durationMs: Date.now() - t0,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('discover-refresh', handler);

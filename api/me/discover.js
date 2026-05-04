// GET /api/me/discover — public directory of businesses that have opted in
// to be listed (calendar_settings.discoverable = TRUE) AND have published a
// slug. Auth-gated only because the rest of /me/* is — the data here is
// already publicly visible at /book/<slug>.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    // Pull a service-count + cheapest service so the listing can show a
    // meaningful preview without a second round-trip.
    const { rows } = await sql`
      SELECT
        cs.workspace_id,
        cs.biz_name,
        cs.slug,
        cs.tagline,
        (SELECT COUNT(*)::int FROM services s WHERE s.workspace_id = cs.workspace_id) AS service_count,
        (SELECT MIN(price)::numeric FROM services s WHERE s.workspace_id = cs.workspace_id) AS min_price
      FROM calendar_settings cs
      WHERE cs.discoverable = TRUE AND cs.slug IS NOT NULL
      ORDER BY cs.biz_name ASC
      LIMIT 200
    `;

    const businesses = rows.map((r) => ({
      slug:         r.slug,
      bizName:      r.biz_name,
      tagline:      r.tagline || '',
      serviceCount: r.service_count || 0,
      minPrice:     r.min_price != null ? Number(r.min_price) : null,
    }));

    return ok(res, { businesses });
  } catch (err) {
    return serverError(res, err);
  }
}

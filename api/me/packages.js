// GET /api/me/packages — every active client_package across the
// signed-in user's client memberships, with the issuing business name
// attached so the UI can render "Marisol Hair · 8 of 10 sessions left".
//
// Past / exhausted packages are excluded by default; pass ?all=1 to
// include them for a "history" view.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { serializeClientPackage } from '../_lib/packages.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { packages: [] });
    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    const all = req.query.all === '1';
    const { rows } = await sql.query(
      `SELECT cp.*, cs.slug AS workspace_slug
         FROM client_packages cp
         LEFT JOIN calendar_settings cs ON cs.workspace_id = cp.workspace_id
        WHERE cp.client_id = ANY($1)
         ${all ? '' : "AND cp.status = 'active' AND cp.credits_remaining > 0 AND (cp.expires_at IS NULL OR cp.expires_at > NOW())"}
       ORDER BY cp.status = 'active' DESC, cp.created_at DESC
       LIMIT 200`,
      [myIds],
    );

    const packages = rows.map((r) => {
      const m = byClient.get(r.client_id);
      return {
        ...serializeClientPackage(r),
        businessName: m?.businessName || 'Business',
        // Slug lets the client portal link straight to the public booking
        // page for that business when redeeming credits.
        bookingSlug: r.workspace_slug || null,
      };
    });
    return ok(res, { packages });
  } catch (err) {
    return serverError(res, err);
  }
}

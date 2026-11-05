// GET /api/me/packages - every active client_package across the
// signed-in user's client memberships, with the issuing business name
// attached so the UI can render "Marisol Hair · 8 of 10 sessions left".
//
// Past / exhausted packages are excluded by default; pass ?all=1 to
// include them for a "history" view, or ?include=recent (the current
// portal) for the active ones plus packages used up or expired in the
// last 120 days, so the card can say "Used up" and offer "Buy again".
// A used-up package is left out once the client holds an active one
// from the same template (they already bought again).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import {
  serializeClientPackage, packageState, SESSIONS_BOOKED_SQL, SESSIONS_HELD_SQL, SERVICE_NAMES_SQL,
} from '../_lib/packages.js';
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
    const recent = !all && req.query.include === 'recent';
    // Fixed SQL fragments only (no user input is interpolated).
    const filter = all ? ''
      : recent
        ? `AND cp.status <> 'cancelled'
           AND (
             (cp.status = 'active' AND cp.credits_remaining > 0 AND (cp.expires_at IS NULL OR cp.expires_at > NOW()))
             OR cp.updated_at > NOW() - INTERVAL '120 days'
             OR (cp.expires_at IS NOT NULL AND cp.expires_at > NOW() - INTERVAL '120 days')
           )`
        : "AND cp.status = 'active' AND cp.credits_remaining > 0 AND (cp.expires_at IS NULL OR cp.expires_at > NOW())";
    const { rows: raw } = await sql.query(
      `SELECT cp.*, cs.slug AS workspace_slug, cs.package_use_on, ${SESSIONS_BOOKED_SQL}, ${SESSIONS_HELD_SQL}, ${SERVICE_NAMES_SQL},
              (p.id IS NOT NULL AND p.active AND p.visibility = 'public' AND p.price > 0) AS template_buyable
         FROM client_packages cp
         LEFT JOIN calendar_settings cs ON cs.workspace_id = cp.workspace_id
         LEFT JOIN packages p ON p.id = cp.package_id AND p.workspace_id = cp.workspace_id
        WHERE cp.client_id = ANY($1)
         ${filter}
       ORDER BY cp.status = 'active' DESC, cp.created_at DESC
       LIMIT 200`,
      [myIds],
    );
    let rows = raw;
    if (recent) {
      const usable = (r) => packageState(r) === 'active';
      const activeKeys = new Set(raw.filter(usable).map((r) => `${r.client_id}|${r.package_id || r.name}`));
      rows = raw.filter((r) => usable(r) || !activeKeys.has(`${r.client_id}|${r.package_id || r.name}`));
    }

    const packages = rows.map((r) => {
      const m = byClient.get(r.client_id);
      return {
        ...serializeClientPackage(r),
        businessName: m?.businessName || 'Business',
        archived: !!m?.archived,
        // Slug lets the client portal link straight to the public booking
        // page for that business when redeeming credits.
        bookingSlug: r.workspace_slug || null,
        // The signed-in client's own name + email at this business, so
        // "Buy again" can fill in the checkout form.
        buyerName: m?.clientName || null,
        buyerEmail: m?.clientEmail || null,
        // When this business counts a session as used.
        useOn: r.package_use_on === 'completion' ? 'completion' : 'booking',
      };
    });
    return ok(res, { packages });
  } catch (err) {
    return serverError(res, err);
  }
}

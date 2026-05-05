// GET /api/me/memberships — every active subscription the user has
// across the businesses they're a client of. Used for the portal's
// Memberships card.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { serializeClientMembership } from '../../_lib/memberships.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { memberships: [] });

    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    const r = await sql.query(
      `SELECT cm.* FROM client_memberships cm
        WHERE cm.client_id = ANY($1)
          AND cm.status IN ('active', 'past_due', 'incomplete')
        ORDER BY cm.started_at DESC`,
      [myIds],
    );
    const out = r.rows.map((row) => ({
      ...serializeClientMembership(row),
      businessName: byClient.get(row.client_id)?.businessName || 'Business',
    }));
    return ok(res, { memberships: out });
  } catch (err) {
    return serverError(res, err);
  }
}

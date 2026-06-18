// GET /api/me/orders - the user's order history across every workspace
// they're a client of. Mirrors /api/me/bookings + /api/me/invoices.
//
// Only paid + refunded orders surface here (pending = a Stripe Checkout
// the user abandoned; we don't want their portal cluttered with them).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { myClientIds } from '../../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return ok(res, { orders: [] });

    const r = await sql.query(
      `SELECT o.id, o.workspace_id, o.client_id, o.items, o.subtotal, o.tax, o.total,
              o.status, o.paid_at, o.created_at,
              w.name AS workspace_name, cs.biz_name
         FROM orders o
         JOIN workspaces w ON w.id = o.workspace_id
         LEFT JOIN calendar_settings cs ON cs.workspace_id = o.workspace_id
        WHERE o.client_id = ANY($1::uuid[])
          AND o.status IN ('paid', 'refunded')
        ORDER BY o.paid_at DESC NULLS LAST, o.created_at DESC
        LIMIT 200`,
      [clientIds],
    );
    return ok(res, {
      orders: r.rows.map((o) => ({
        id:            o.id,
        businessName:  o.biz_name || o.workspace_name || 'Business',
        items:         Array.isArray(o.items) ? o.items : [],
        subtotal:      Number(o.subtotal || 0),
        tax:           Number(o.tax || 0),
        total:         Number(o.total || 0),
        status:        o.status,
        paidAt:        o.paid_at,
        createdAt:     o.created_at,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

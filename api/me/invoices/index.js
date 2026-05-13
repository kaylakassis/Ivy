// GET /api/me/invoices — list every invoice tied to the user's client
// records. Money math (totals incl. tax/discount) is computed in SQL so
// the client just renders.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { invoices: [] });

    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    let rows;
    try { ({ rows } = await sql.query(
      `SELECT i.id, i.client_id, i.number, i.status,
              i.issue_date, i.due_date, i.paid_at,
              GREATEST(
                (SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
                  FROM jsonb_array_elements(i.items) AS it) - i.discount,
                0
              ) * (1 + i.tax_rate / 100) AS total,
              i.tax_rate, i.discount
       FROM invoices i
       WHERE i.client_id = ANY($1)
         AND i.status <> 'draft'
       ORDER BY i.issue_date DESC, i.created_at DESC
       LIMIT 500`,
      [myIds],
    )); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[me/invoices] query failed (returning empty):', e.message);
      return ok(res, { invoices: [] });
    }

    const invoices = rows.map((r) => {
      const m = byClient.get(r.client_id);
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        issueDate: r.issue_date instanceof Date ? r.issue_date.toISOString().slice(0, 10) : r.issue_date,
        dueDate:   r.due_date   instanceof Date ? r.due_date.toISOString().slice(0, 10)   : r.due_date,
        paidAt:    r.paid_at,
        total:     Number(r.total || 0),
        businessName: m?.businessName || 'Business',
      };
    });
    return ok(res, { invoices });
  } catch (err) {
    return serverError(res, err);
  }
}

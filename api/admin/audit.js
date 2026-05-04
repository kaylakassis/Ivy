// GET /api/admin/audit?from=ISO&to=ISO&actor=&target=&action=&page=
// Reverse-chronological list of audit_events with the actor + target
// users joined for display. Filterable on every column the admin
// might care about.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const PAGE_SIZE = 100;

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const from = (req.query.from || '').toString();
    const to   = (req.query.to   || '').toString();
    const actor  = (req.query.actor  || '').toString().toLowerCase().trim();
    const target = (req.query.target || '').toString().toLowerCase().trim();
    const action = (req.query.action || '').toString().trim();
    const page   = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const where = [];
    const params = [];

    if (from) {
      const t = Date.parse(from);
      if (Number.isNaN(t)) return badRequest(res, 'Invalid from');
      params.push(new Date(t).toISOString());
      where.push(`a.created_at >= $${params.length}`);
    }
    if (to) {
      const t = Date.parse(to);
      if (Number.isNaN(t)) return badRequest(res, 'Invalid to');
      params.push(new Date(t).toISOString());
      where.push(`a.created_at < $${params.length}`);
    }
    if (actor)  { params.push(`%${actor}%`);  where.push(`LOWER(COALESCE(a.actor_email, '')) LIKE $${params.length}`); }
    if (target) { params.push(`%${target}%`); where.push(`LOWER(COALESCE(tu.email, ''))      LIKE $${params.length}`); }
    if (action) { params.push(action);        where.push(`a.action = $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(PAGE_SIZE, offset);

    const queryText = `
      SELECT a.id, a.actor_user_id, a.actor_email, a.target_user_id,
             a.action, a.meta, a.ip, a.user_agent, a.created_at,
             tu.email AS target_email, tu.name AS target_name
      FROM audit_events a
      LEFT JOIN users tu ON tu.id = a.target_user_id
      ${whereSql}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const totalText = `SELECT COUNT(*)::int AS n FROM audit_events a
                       LEFT JOIN users tu ON tu.id = a.target_user_id ${whereSql}`;

    const [r, t] = await Promise.all([
      sql.query(queryText, params),
      sql.query(totalText, params.slice(0, params.length - 2)),
    ]);

    return ok(res, {
      events: r.rows.map((row) => ({
        id: row.id,
        actorEmail: row.actor_email,
        targetEmail: row.target_email,
        targetName: row.target_name,
        action: row.action,
        meta: row.meta || {},
        ip: row.ip,
        createdAt: row.created_at,
      })),
      page,
      pageSize: PAGE_SIZE,
      total: t.rows[0]?.n || 0,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

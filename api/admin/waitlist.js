// GET /api/admin/waitlist - super-admin only.
//   ?format=json (default) → paginated list  { items, page, pageSize, total }
//   ?format=csv            → streamed CSV download of the whole list
//   ?q=<search>            → filter by email/name substring
//   ?status=pending|notified|converted → filter by status
//
// Surface in /admin → Waitlist tab.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const PAGE_SIZE = 50;
const CSV_PAGE = 5000;
const STATUSES = new Set(['pending', 'notified', 'converted']);

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const status = (req.query.status || '').toString();
    const statusFilter = STATUSES.has(status) ? status : null;

    if ((req.query.format || '').toString() === 'csv') {
      const actor = await getAdminActor(req);
      await recordAudit(req, { actor, action: 'admin.export', meta: { kind: 'waitlist' } });
      return writeCsv(res, { q, statusFilter });
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    // Build the WHERE dynamically. `$1`-style params to keep it injection-safe.
    const where = [];
    const params = [];
    if (q) { params.push(`%${q}%`); where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(name,'')) LIKE $${params.length})`); }
    if (statusFilter) { params.push(statusFilter); where.push(`status = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const listParams = [...params, PAGE_SIZE, offset];
    const { rows } = await sql.query(
      `SELECT id, email, name, source, status, created_at, notified_at, converted_at
         FROM waitlist_signups
         ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    const totalRes = await sql.query(`SELECT COUNT(*)::int AS n FROM waitlist_signups ${whereSql}`, params);

    return ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        source: r.source,
        status: r.status,
        createdAt: r.created_at,
        notifiedAt: r.notified_at,
        convertedAt: r.converted_at,
      })),
      page,
      pageSize: PAGE_SIZE,
      total: totalRes.rows[0]?.n || 0,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

async function writeCsv(res, { q, statusFilter }) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ivy-waitlist-${stamp}.csv"`);
  res.status(200);
  res.write(['email', 'name', 'source', 'status', 'created_at', 'notified_at', 'converted_at'].join(',') + '\n');

  const where = [];
  const params = [];
  if (q) { params.push(`%${q}%`); where.push(`(LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(name,'')) LIKE $${params.length})`); }
  if (statusFilter) { params.push(statusFilter); where.push(`status = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pageParams = [...params, CSV_PAGE, offset];
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await sql.query(
      `SELECT email, name, source, status, created_at, notified_at, converted_at
         FROM waitlist_signups
         ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );
    if (rows.length === 0) break;
    const lines = rows.map((r) => [
      r.email, r.name, r.source, r.status, iso(r.created_at), iso(r.notified_at), iso(r.converted_at),
    ].map(csvCell).join(','));
    res.write(lines.join('\n') + '\n');
    if (rows.length < CSV_PAGE) break;
    offset += CSV_PAGE;
  }
  return res.end();
}

function iso(v) { return v ? new Date(v).toISOString() : ''; }
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

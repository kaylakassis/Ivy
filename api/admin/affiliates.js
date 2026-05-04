// GET /api/admin/affiliates?from=ISO&to=ISO
//   List every affiliate with their use-counts in 24h / 7d / 30d / all
//   time, and revenue attributed (window + all time). Window defaults
//   to all-time if from/to omitted.
//
// POST /api/admin/affiliates  { userId, code?, displayName? }
//   Creates an affiliates row for an existing user. Generates a code
//   if not supplied. Caller is expected to also flip user_type via the
//   admin/users endpoint if they want the sidebar classification.
//
// PATCH /api/admin/affiliates/:id  { code?, active?, displayName? }
//   Rotate a code or deactivate.
//
// DELETE /api/admin/affiliates/:id
//   Remove the affiliate row. Past attributions stay in affiliate_uses
//   (FK is ON DELETE CASCADE so they actually go away — fine for v1).
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const CODE_RE = /^[A-Z0-9_-]{3,40}$/;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (req.method === 'GET')  return listAffiliates(req, res);
    if (req.method === 'POST') return createAffiliate(req, res);
    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function listAffiliates(req, res) {
  const fromRaw = (req.query.from || '').toString();
  const toRaw   = (req.query.to   || '').toString();
  const fromIso = fromRaw ? safeIso(fromRaw) : '1970-01-01T00:00:00Z';
  const toIso   = toRaw   ? safeIso(toRaw)   : new Date().toISOString();
  if (!fromIso || !toIso) return badRequest(res, 'Invalid from/to');

  // One join across the four windows so we don't hit the DB N+1 times.
  const { rows } = await sql.query(
    `SELECT
       a.id, a.code, a.display_name, a.active, a.created_at,
       u.id    AS user_id,
       u.email AS user_email,
       u.name  AS user_name,
       (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id) AS uses_total,
       (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id
          AND au.signed_up_at >= NOW() - INTERVAL '24 hours') AS uses_24h,
       (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id
          AND au.signed_up_at >= NOW() - INTERVAL '7 days')   AS uses_7d,
       (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id
          AND au.signed_up_at >= NOW() - INTERVAL '30 days')  AS uses_30d,
       (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id
          AND au.signed_up_at >= $1 AND au.signed_up_at < $2) AS uses_window,
       (SELECT COALESCE(SUM(monthly_value_cents), 0)::bigint FROM affiliate_uses au
          WHERE au.affiliate_id = a.id AND au.became_paid_at IS NOT NULL) AS revenue_total_cents,
       (SELECT COALESCE(SUM(monthly_value_cents), 0)::bigint FROM affiliate_uses au
          WHERE au.affiliate_id = a.id AND au.became_paid_at IS NOT NULL
            AND au.became_paid_at >= $1 AND au.became_paid_at < $2) AS revenue_window_cents
     FROM affiliates a
     JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC`,
    [fromIso, toIso],
  );

  return ok(res, {
    range: { from: fromIso, to: toIso },
    affiliates: rows.map((r) => ({
      id: r.id,
      code: r.code,
      displayName: r.display_name,
      active: r.active,
      createdAt: r.created_at,
      user: { id: r.user_id, email: r.user_email, name: r.user_name },
      uses: {
        last24h:  Number(r.uses_24h),
        last7d:   Number(r.uses_7d),
        last30d:  Number(r.uses_30d),
        inWindow: Number(r.uses_window),
        total:    Number(r.uses_total),
      },
      revenue: {
        windowCents: Number(r.revenue_window_cents) || 0,
        totalCents:  Number(r.revenue_total_cents) || 0,
      },
    })),
  });
}

async function createAffiliate(req, res) {
  const body = await readBody(req);
  const userId = body.userId ? String(body.userId) : null;
  const codeRaw = body.code ? String(body.code).trim().toUpperCase() : null;
  const displayName = body.displayName ? String(body.displayName).slice(0, 200) : null;

  if (!userId) return badRequest(res, 'userId is required');

  const u = await sql`SELECT id, name FROM users WHERE id = ${userId}`;
  if (u.rows.length === 0) return badRequest(res, 'Unknown user');

  const dup = await sql`SELECT 1 FROM affiliates WHERE user_id = ${userId}`;
  if (dup.rows.length > 0) return badRequest(res, 'That user already has an affiliate row.');

  const code = codeRaw && CODE_RE.test(codeRaw) ? codeRaw : await uniqueCode();
  if (codeRaw && !CODE_RE.test(codeRaw)) {
    return badRequest(res, 'Code must be 3–40 chars; A–Z, 0–9, _ or -.');
  }

  const ins = await sql`
    INSERT INTO affiliates (user_id, code, display_name)
    VALUES (${userId}, ${code}, ${displayName || u.rows[0].name || null})
    RETURNING id, code, display_name, active, created_at
  `;
  return created(res, { affiliate: ins.rows[0] });
}

async function uniqueCode() {
  for (let i = 0; i < 8; i++) {
    const c = randomCode();
    const r = await sql`SELECT 1 FROM affiliates WHERE code = ${c}`;
    if (r.rows.length === 0) return c;
  }
  return `THRYVE-${Date.now().toString(36).toUpperCase()}`;
}
function randomCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function safeIso(raw) {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

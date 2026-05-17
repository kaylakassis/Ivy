// GET /api/admin/export?kind=users|affiliates
// Streams a CSV download of every user or every affiliate.
//
// Returns text/csv with a Content-Disposition that prompts the browser
// to save it. Bypass the json wrapper because we're writing raw CSV.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';

const KINDS = new Set(['users', 'affiliates']);

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  const kind = (req.query.kind || 'users').toString();
  if (!KINDS.has(kind)) return badRequest(res, `Unknown kind: ${kind}`);

  try {
    // Audit: exporting user data is the highest-PII-risk admin
    // action. Captures who, when, which dataset.
    const actor = await getAdminActor(req);
    await recordAudit(req, { actor, action: 'admin.export', meta: { kind } });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="thryve-${kind}-${stamp}.csv"`);

    if (kind === 'users') return writeUsers(res);
    if (kind === 'affiliates') return writeAffiliates(res);
  } catch (err) {
    return serverError(res, err);
  }
}

// Pages the result set in chunks of PAGE_SIZE rather than loading
// the entire table into memory. At scale (50K users, 50K affiliates)
// the in-memory CSV grows past Vercel's 256MB function ceiling.
// Paged + streamed writes keep peak memory at one page.
const PAGE_SIZE = 5000;

async function writeUsers(res) {
  const headers = [
    'id', 'email', 'name', 'user_type', 'classification',
    'created_at', 'email_verified_at',
    'subscription_status', 'trial_ends_at', 'period_ends_at',
    'is_client', 'affiliate_code',
  ];
  res.status(200);
  res.write(headers.join(',') + '\n');

  let offset = 0;
  while (true) {
    const { rows } = await sql`
      SELECT
        u.id, u.email, u.name, u.user_type, u.created_at, u.email_verified_at,
        w.id AS workspace_id, w.subscription_status, w.trial_ends_at,
        w.subscription_period_end,
        EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id) AS is_client,
        af.code AS affiliate_code
      FROM users u
      LEFT JOIN workspaces w ON w.owner_id = u.id
      LEFT JOIN affiliates af ON af.user_id = u.id
      ORDER BY u.created_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `;
    if (rows.length === 0) break;
    const lines = rows.map((r) => [
      r.id, r.email, r.name, r.user_type, classify(r),
      iso(r.created_at), iso(r.email_verified_at),
      r.subscription_status, iso(r.trial_ends_at), iso(r.subscription_period_end),
      r.is_client ? 'true' : 'false',
      r.affiliate_code,
    ].map(csvCell).join(','));
    res.write(lines.join('\n') + '\n');
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return res.end();
}

async function writeAffiliates(res) {
  const headers = [
    'id', 'code', 'display_name', 'active',
    'user_email', 'user_name',
    'uses_24h', 'uses_7d', 'uses_30d', 'uses_total',
    'monthly_revenue_cents', 'created_at',
  ];
  res.status(200);
  res.write(headers.join(',') + '\n');

  let offset = 0;
  while (true) {
    const { rows } = await sql`
      SELECT
        a.id, a.code, a.display_name, a.active, a.created_at,
        u.email AS user_email, u.name AS user_name,
        (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id) AS uses_total,
        (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id AND au.signed_up_at >= NOW() - INTERVAL '24 hours') AS uses_24h,
        (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id AND au.signed_up_at >= NOW() - INTERVAL '7 days')   AS uses_7d,
        (SELECT COUNT(*)::int FROM affiliate_uses au WHERE au.affiliate_id = a.id AND au.signed_up_at >= NOW() - INTERVAL '30 days')  AS uses_30d,
        (SELECT COALESCE(SUM(monthly_value_cents), 0)::bigint FROM affiliate_uses au
          WHERE au.affiliate_id = a.id AND au.became_paid_at IS NOT NULL) AS revenue_cents
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `;
    if (rows.length === 0) break;
    const lines = rows.map((r) => [
      r.id, r.code, r.display_name, r.active ? 'true' : 'false',
      r.user_email, r.user_name,
      r.uses_24h, r.uses_7d, r.uses_30d, r.uses_total,
      r.revenue_cents, iso(r.created_at),
    ].map(csvCell).join(','));
    res.write(lines.join('\n') + '\n');
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return res.end();
}

function classify(row) {
  if (row.user_type === 'sponsored') return 'Sponsored';
  if (row.user_type === 'affiliate') return 'Affiliate';
  if (row.subscription_status === 'active') return 'Business-Active';
  if (row.subscription_status === 'trialing'
    && row.trial_ends_at && new Date(row.trial_ends_at) > new Date()) return 'Business-Trial';
  if (row.workspace_id) return 'Business-Inactive';
  if (row.is_client) return 'Client-only';
  return 'Unclaimed';
}
function iso(v) { return v ? new Date(v).toISOString() : ''; }
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // Quote if it contains comma, quote, or newline. Inner quotes doubled.
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

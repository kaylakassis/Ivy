// GET  /api/admin/users/:id/workspaces
// POST /api/admin/users/:id/workspaces  { removeWorkspaceId, allowData? }
//
// Resolves an owner who ended up with more than one business record (a
// sign-up race before workspaces were made one per owner). GET lists each of
// the owner's workspaces, oldest first (the one the app uses), with row
// counts per table so the super-admin can see where the real data lives.
// POST removes one of them:
//   - never the last one,
//   - never one with a live paid plan or trial attached (billing first),
//   - one that holds real data (clients, bookings, services...) only with
//     allowData: true, after the admin has seen the counts.
// Removal cascades like an account deletion of that business. Afterwards the
// one-per-owner unique index is created if no duplicates remain anywhere.
//
// Super-admin only. Counts only: no client names, notes or messages.
import { sql } from '../../../_lib/db.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../../../_lib/admin.js';
import { readBody } from '../../../_lib/body.js';
import { recordAudit } from '../../../_lib/audit.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// Records every new business gets automatically (settings rows). Having
// only these means nobody has used that business.
const SETUP_ONLY = new Set([
  'calendar_settings', 'workspace_profile', 'finance_settings', 'websites',
  'notification_preferences', 'workspace_settings', 'branding', 'admin_analytics_cache',
]);

async function workspaceTables() {
  const { rows } = await sql`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name`;
  return rows.map((r) => r.table_name).filter((n) => IDENT_RE.test(n));
}

async function countsFor(workspaceId, tables) {
  if (!tables.length) return {};
  // One query: a COUNT per table. Table names come from the catalog and are
  // checked against IDENT_RE; the workspace id is a bound parameter.
  const parts = tables.map((t) => `SELECT '${t}' AS t, COUNT(*)::int AS n FROM "${t}" WHERE workspace_id = $1`);
  const { rows } = await sql.query(parts.join(' UNION ALL '), [workspaceId]);
  const out = {};
  for (const r of rows) if (r.n > 0) out[r.t] = r.n;
  return out;
}

function hasLivePlan(w) {
  const now = Date.now();
  const future = (d) => d && new Date(d).getTime() > now;
  if (w.subscription_status === 'active' && (w.stripe_subscription_id || w.subscription_source === 'apple')) return true;
  if (w.subscription_status === 'trialing' && future(w.trial_ends_at) && (w.stripe_subscription_id || w.subscription_source === 'apple')) return true;
  if (w.subscription_status === 'past_due') return true;
  return false;
}

async function listFor(userId) {
  const { rows } = await sql`
    SELECT w.*, cs.biz_name, cs.slug
      FROM workspaces w
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
     WHERE w.owner_id = ${userId}
     ORDER BY w.created_at ASC, w.id ASC`;
  const tables = await workspaceTables();
  const out = [];
  for (const [i, w] of rows.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const counts = await countsFor(w.id, tables);
    const dataRows = Object.entries(counts)
      .filter(([t]) => !SETUP_ONLY.has(t))
      .reduce((s, [, n]) => s + n, 0);
    out.push({
      id: w.id,
      createdAt: w.created_at,
      inUse: i === 0,
      businessName: w.biz_name || w.name || null,
      slug: w.slug || null,
      subscriptionStatus: w.subscription_status || null,
      subscriptionSource: w.subscription_source || null,
      trialEndsAt: w.trial_ends_at || null,
      onboardedAt: w.onboarded_at || null,
      livePlan: hasLivePlan(w),
      dataRows,
      counts,
    });
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const id = String(req.query?.id || '');
    if (!UUID_RE.test(id)) return notFound(res, 'User not found');
    const u = (await sql`SELECT id, email FROM users WHERE id = ${id}`).rows[0];
    if (!u) return notFound(res, 'User not found');

    if (req.method === 'GET') {
      return ok(res, { workspaces: await listFor(u.id) });
    }

    const body = await readBody(req);
    const target = String(body?.removeWorkspaceId || '');
    if (!UUID_RE.test(target)) return badRequest(res, 'Pick which business to remove');
    const list = await listFor(u.id);
    if (list.length < 2) return badRequest(res, 'This person has only one business. Nothing to remove.');
    const w = list.find((x) => x.id === target);
    if (!w) return notFound(res, 'That business does not belong to this person');
    if (w.livePlan) {
      return badRequest(res, 'That business has a live plan or trial. Cancel or move the plan first, then remove it.');
    }
    if (w.dataRows > 0 && body?.allowData !== true) {
      return badRequest(res, `That business holds ${w.dataRows} records (clients, bookings, services and so on). Confirm you want them deleted.`);
    }

    const del = await sql`DELETE FROM workspaces WHERE id = ${target} AND owner_id = ${u.id} RETURNING id`;
    if (!del.rows.length) return notFound(res, 'That business was already removed');

    const actor = await getAdminActor(req).catch(() => null);
    await recordAudit(req, {
      actor, targetUserId: u.id, action: 'user.remove_duplicate_workspace',
      meta: { email: u.email, workspaceId: target, dataRows: w.dataRows, wasInUse: w.inUse },
    });

    // With the duplicates gone, add the one-business-per-owner guarantee.
    // The schema migration only creates it when no owner has two, and it
    // runs once, so it is (re)attempted here.
    let uniqueIndex = false;
    try {
      const dup = await sql`SELECT 1 FROM workspaces GROUP BY owner_id HAVING COUNT(*) > 1 LIMIT 1`;
      if (!dup.rows.length) {
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_owner ON workspaces(owner_id)`;
        uniqueIndex = true;
      }
    } catch { /* another owner still has two; the index waits */ }

    return ok(res, { removed: target, uniqueIndex, workspaces: await listFor(u.id) });
  } catch (err) {
    return serverError(res, err);
  }
}

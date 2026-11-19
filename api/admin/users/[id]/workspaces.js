// GET  /api/admin/users/:id/workspaces
// POST /api/admin/users/:id/workspaces  { removeWorkspaceId, allowData? }
// POST /api/admin/users/:id/workspaces  { makeClientAccount: true, allowData? }
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
import { workspaceTables, countsFor, dataRowsOf, hasLivePlan, clientSwitchCheck, convertToClientAccount } from '../../../_lib/accountKind.js';
import { invalidateUserCache } from '../../../_lib/auth.js';
import { invalidateOwnerWorkspace } from '../../../_lib/clientPortal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    const dataRows = dataRowsOf(counts);
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
      // clientSwitch: can this account be turned into a client account
      // (someone who created a business by mistake)? With the reason if not.
      const sw = await clientSwitchCheck(u.id, { allowData: true });
      const strict = sw.ok ? await clientSwitchCheck(u.id) : sw;
      return ok(res, {
        workspaces: await listFor(u.id),
        clientSwitch: sw.ok
          ? { eligible: true, dataRows: sw.dataRows, needsConfirm: !strict.ok }
          : { eligible: false, reason: sw.reason, message: sw.message },
      });
    }

    const body = await readBody(req);

    // Make this a client account: remove the one unused business. Never
    // with a plan or trial; records only after the admin has seen the count.
    if (body?.makeClientAccount === true) {
      const result = await convertToClientAccount(u.id, { allowData: body?.allowData === true });
      if (!result.ok) return badRequest(res, result.message, { code: `switch-${result.reason}`, dataRows: result.dataRows });
      invalidateOwnerWorkspace(u.id);
      invalidateUserCache(u.id);
      const adminActor = await getAdminActor(req).catch(() => null);
      await recordAudit(req, {
        actor: adminActor, targetUserId: u.id, action: 'user.became_client_account',
        meta: { email: u.email, workspaceId: result.workspaceId, dataRows: result.dataRows, by: 'admin' },
      });
      return ok(res, { ok: true, madeClientAccount: true, workspaces: [] });
    }
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

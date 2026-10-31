// GET    /api/programs/:id  → program + content + members (owner)
// PATCH  /api/programs/:id  → edit fields / publish / unpublish
// DELETE /api/programs/:id  → archive: no new sales, members keep access
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeProgram, serializeEnrollment, cleanProgramInput, checkProgramExtras, isUuid } from '../_lib/programs.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { loadModules, serializeModule, serializeLesson, courseOrder } from '../_lib/programCourse.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res); if (!workspaceId) return;
    const id = String(req.query.id || '');
    if (!isUuid(id)) return notFound(res, 'Program not found');
    const p = (await sql`SELECT * FROM programs WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
    if (!p) return notFound(res, 'Program not found');

    if (req.method === 'GET') {
      const modules = await loadModules(id, workspaceId);
      const items = courseOrder(modules, (await sql`SELECT * FROM program_items WHERE program_id = ${id} AND workspace_id = ${workspaceId} AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`).rows);
      const members = (await sql`
        SELECT e.*, c.name AS client_name, c.email AS client_email, co.name AS cohort_name, pc.code AS coupon_code FROM program_enrollments e
        JOIN clients c ON c.id = e.client_id
        LEFT JOIN program_cohorts co ON co.id = e.cohort_id AND co.deleted_at IS NULL
        LEFT JOIN program_coupons pc ON pc.id = e.coupon_id
        WHERE e.program_id = ${id} AND e.workspace_id = ${workspaceId} ORDER BY e.granted_at DESC`).rows;
      // Owner insight: completions per lesson, and each member's progress.
      const perItem = new Map((await sql`
        SELECT pp.item_id, COUNT(*)::int AS n FROM program_progress pp
          JOIN program_enrollments e ON e.client_id = pp.client_id AND e.program_id = pp.program_id AND e.status IN ('active','past_due')
         WHERE pp.program_id = ${id} AND pp.workspace_id = ${workspaceId} GROUP BY pp.item_id`).rows.map((r) => [r.item_id, r.n]));
      const live = new Set(items.map((i) => i.id));
      const perClient = new Map();
      for (const r of (await sql`SELECT client_id, item_id, completed_at FROM program_progress WHERE program_id = ${id} AND workspace_id = ${workspaceId}`).rows) {
        if (!live.has(r.item_id)) continue;
        const cur = perClient.get(r.client_id) || { n: 0, last: null };
        cur.n += 1;
        if (!cur.last || new Date(r.completed_at) > new Date(cur.last)) cur.last = r.completed_at;
        perClient.set(r.client_id, cur);
      }
      const activeMembers = members.filter((m) => m.status !== 'cancelled').length;
      return ok(res, {
        program: serializeProgram(p, { members: activeMembers, items: items.length }),
        items: items.map((r) => ({ ...serializeLesson(r), completedCount: perItem.get(r.id) || 0 })),
        modules: modules.map((m) => serializeModule(m, { lessons: items.filter((i) => i.module_id === m.id).length })),
        members: members.map((m) => {
          const pr = perClient.get(m.client_id) || { n: 0, last: null };
          return { ...serializeEnrollment(m), completedCount: pr.n, progressPercent: items.length ? Math.round((pr.n / items.length) * 100) : 0, lastActivityAt: pr.last };
        }),
        activeMembers,
      });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const v = cleanProgramInput(body, true);
      if (!v.ok) return badRequest(res, v.errors[0]);
      if (v.value.status === 'published' && p.status === 'archived') return badRequest(res, 'This program is archived.');
      const f = { ...p, ...v.value };
      const extra = await checkProgramExtras(f, workspaceId);
      if (extra) return badRequest(res, extra);
      const oneTime = f.billing === 'one_time';
      const { rows } = await sql`
        UPDATE programs SET title = ${f.title}, description = ${f.description}, cover_url = ${f.cover_url}, price_cents = ${f.price_cents},
          billing = ${f.billing}, community_enabled = ${f.community_enabled}, access_days = ${f.access_days}, status = ${f.status},
          leaderboard_enabled = ${!!f.leaderboard_enabled}, streak_mode = ${f.streak_mode || 'daily'}, delivery = ${f.delivery || 'evergreen'},
          trial_days = ${oneTime ? null : (f.trial_days || null)},
          bundle_package_id = ${oneTime ? (f.bundle_package_id || null) : null}, bundle_mode = ${oneTime && f.bundle_package_id ? (f.bundle_mode || null) : null},
          updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId} RETURNING *`;
      return ok(res, { program: serializeProgram(rows[0]) });
    }
    if (req.method === 'DELETE') {
      await sql`UPDATE programs SET status = 'archived', updated_at = NOW() WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return ok(res, { archived: true });
    }
    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}

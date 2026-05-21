// /api/goals/:id  — GET / PATCH / DELETE
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  fetchOwnedGoal, serializeGoal, computeGoalCurrent, VALID_GOAL_TYPES,
} from '../_lib/goals.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;
    const { id } = req.query;

    const goal = await fetchOwnedGoal({ id, workspaceId });
    if (!goal) return notFound(res, 'Goal not found');

    if (req.method === 'GET') {
      const current = goal.type === 'custom'
        ? Number(goal.current_manual || 0)
        : await computeGoalCurrent(workspaceId, goal.type);
      return ok(res, { goal: serializeGoal(goal, current) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('title' in body) {
        const v = (body.title || '').toString().trim();
        if (!v || v.length > 240) return badRequest(res, 'Title is required (max 240 chars)');
        push('title', v);
      }
      if ('type' in body) {
        if (!VALID_GOAL_TYPES.has(body.type)) return badRequest(res, 'Invalid type');
        push('type', body.type);
      }
      if ('target' in body) {
        const n = Number(body.target);
        if (!Number.isFinite(n) || n <= 0) return badRequest(res, 'target must be a positive number');
        push('target', n);
      }
      if ('current' in body || 'currentManual' in body) {
        const n = Number(body.current ?? body.currentManual ?? 0);
        if (!Number.isFinite(n) || n < 0) return badRequest(res, 'current must be a non-negative number');
        push('current_manual', n);
      }
      if ('deadline' in body) {
        if (body.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(body.deadline)) return badRequest(res, 'deadline must be YYYY-MM-DD');
        push('deadline', body.deadline || null);
      }
      if ('notes' in body) push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));

      if (sets.length === 0) {
        const current = goal.type === 'custom'
          ? Number(goal.current_manual || 0)
          : await computeGoalCurrent(workspaceId, goal.type);
        return ok(res, { goal: serializeGoal(goal, current) });
      }

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE goals SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      const row = rows[0];
      const current = row.type === 'custom'
        ? Number(row.current_manual || 0)
        : await computeGoalCurrent(workspaceId, row.type);
      return ok(res, { goal: serializeGoal(row, current) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM goals WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

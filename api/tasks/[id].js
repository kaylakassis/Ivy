// /api/tasks/:id  — GET / PATCH / DELETE
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedTask, fetchOwnedTaskWithProgress, serializeTask, VALID_TASK_TYPES } from '../_lib/goals.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const task = await fetchOwnedTask({ id, workspaceId });
    if (!task) return notFound(res, 'Task not found');

    if (req.method === 'GET') {
      const withProgress = await fetchOwnedTaskWithProgress({ id, workspaceId });
      return ok(res, { task: serializeTask(withProgress || task) });
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
        if (!VALID_TASK_TYPES.has(body.type)) return badRequest(res, 'Invalid type');
        push('type', body.type);
      }
      if ('clientId' in body) {
        const clientId = body.clientId ? String(body.clientId) : null;
        if (clientId) {
          const cl = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
          if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
        }
        push('client_id', clientId);
      }
      if ('done' in body) {
        const next = !!body.done;
        push('done', next);
        push('completed_at', next ? new Date().toISOString() : null);
        if (!next) push('completed_auto', false);
      }
      if ('dueDate' in body) {
        if (body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) return badRequest(res, 'dueDate must be YYYY-MM-DD');
        push('due_date', body.dueDate || null);
      }
      if ('notes' in body) push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));

      if (sets.length === 0) return ok(res, { task: serializeTask(task) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE tasks SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      await sql.query(queryText, values);
      const refreshed = await fetchOwnedTaskWithProgress({ id, workspaceId });
      return ok(res, { task: serializeTask(refreshed) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM tasks WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

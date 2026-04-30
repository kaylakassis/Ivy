// /api/tasks
//   GET  → list tasks (filterable: ?done=true|false)
//   POST → create

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeTask, VALID_TASK_TYPES, listTasksWithProgress } from '../_lib/goals.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const rows = await listTasksWithProgress(workspaceId, req.query.done);
      return ok(res, { tasks: rows.map(serializeTask) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const title = (body.title || '').toString().trim();
      const type = body.type || 'generic';
      const clientId = body.clientId ? String(body.clientId) : null;
      const dueDate = body.dueDate ? String(body.dueDate) : null;
      const notes = body.notes ? String(body.notes).slice(0, 4000) : null;
      const source = body.source ? String(body.source).slice(0, 60) : 'user';

      if (!title) return badRequest(res, 'Title is required');
      if (title.length > 240) return badRequest(res, 'Title too long');
      if (!VALID_TASK_TYPES.has(type)) return badRequest(res, 'Invalid type');
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return badRequest(res, 'dueDate must be YYYY-MM-DD');

      if (clientId) {
        const cl = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
        if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
      }

      const insert = await sql`
        INSERT INTO tasks (workspace_id, title, type, client_id, due_date, notes, source)
        VALUES (${workspaceId}, ${title}, ${type}, ${clientId}, ${dueDate}, ${notes}, ${source})
        RETURNING *
      `;
      return created(res, { task: serializeTask(insert.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

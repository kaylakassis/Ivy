// /api/goals
//   GET  → list goals with current values computed from related tables
//   POST → create

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeGoal, computeGoalCurrent, VALID_GOAL_TYPES,
} from '../_lib/goals.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT * FROM goals WHERE workspace_id = ${workspaceId}
        ORDER BY deadline NULLS LAST, created_at
      `;
      // Compute current values per goal type. Cache per-type within this
      // request so we don't run the same SUM/COUNT for every revenue goal.
      const cache = new Map();
      const out = [];
      for (const r of rows) {
        let current;
        if (r.type === 'custom') {
          current = Number(r.current_manual || 0);
        } else {
          if (!cache.has(r.type)) {
            // eslint-disable-next-line no-await-in-loop
            cache.set(r.type, await computeGoalCurrent(workspaceId, r.type));
          }
          current = cache.get(r.type);
        }
        out.push(serializeGoal(r, current));
      }
      return ok(res, { goals: out });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const title = (body.title || '').toString().trim();
      const type = body.type || 'custom';
      const target = Number(body.target);
      const currentManual = Number(body.current ?? body.currentManual ?? 0);
      const deadline = body.deadline ? String(body.deadline) : null;
      const notes = body.notes ? String(body.notes).slice(0, 4000) : null;

      if (!title) return badRequest(res, 'Title is required');
      if (title.length > 240) return badRequest(res, 'Title too long');
      if (!VALID_GOAL_TYPES.has(type)) return badRequest(res, 'Invalid type');
      if (!Number.isFinite(target) || target <= 0) return badRequest(res, 'target must be a positive number');
      if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return badRequest(res, 'deadline must be YYYY-MM-DD');

      const insert = await sql`
        INSERT INTO goals (workspace_id, title, type, target, current_manual, deadline, notes)
        VALUES (${workspaceId}, ${title}, ${type}, ${target}, ${currentManual}, ${deadline}, ${notes})
        RETURNING *
      `;
      const row = insert.rows[0];
      const current = type === 'custom'
        ? Number(row.current_manual || 0)
        : await computeGoalCurrent(workspaceId, type);
      return created(res, { goal: serializeGoal(row, current) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

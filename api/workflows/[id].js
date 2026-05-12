// /api/workflows/:id
//   GET    → single workflow + last 25 runs (for debugging "did it fire?")
//   PATCH  → update (full re-validate)
//   DELETE → remove (workflow_runs cascade)
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { validateWorkflowShape, serializeWorkflow } from '../_lib/workflows.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const existing = await sql`
      SELECT * FROM workflows WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (existing.rows.length === 0) return notFound(res, 'Workflow not found');
    const row = existing.rows[0];

    if (req.method === 'GET') {
      const runs = await sql`
        SELECT id, status, action_results, context, error, triggered_at, client_id
          FROM workflow_runs
         WHERE workflow_id = ${id}
         ORDER BY triggered_at DESC
         LIMIT 25
      `;
      return ok(res, {
        workflow: serializeWorkflow(row),
        runs: runs.rows.map((r) => ({
          id:           r.id,
          status:       r.status,
          actionResults: r.action_results || [],
          context:      r.context || {},
          error:        r.error || null,
          triggeredAt:  r.triggered_at,
          clientId:     r.client_id,
        })),
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Cheap toggle path — enabled-only PATCH doesn't need full
      // re-validation (no shape changes).
      if (Object.keys(body).length === 1 && 'enabled' in body) {
        const upd = await sql`
          UPDATE workflows SET enabled = ${!!body.enabled}, updated_at = NOW()
           WHERE id = ${id} AND workspace_id = ${workspaceId}
           RETURNING *
        `;
        return ok(res, { workflow: serializeWorkflow(upd.rows[0]) });
      }
      // Full update — merge incoming with existing then re-validate.
      const merged = {
        name:           body.name ?? row.name,
        description:    body.description ?? row.description,
        triggerType:    body.triggerType ?? row.trigger_type,
        triggerConfig:  body.triggerConfig ?? row.trigger_config,
        actions:        body.actions ?? row.actions,
        enabled:        body.enabled ?? row.enabled,
      };
      let clean;
      try { clean = validateWorkflowShape(merged); }
      catch (err) { return badRequest(res, err.message); }
      const upd = await sql`
        UPDATE workflows SET
          name           = ${clean.name},
          description    = ${clean.description},
          trigger_type   = ${clean.triggerType},
          trigger_config = ${JSON.stringify(clean.triggerConfig)}::jsonb,
          actions        = ${JSON.stringify(clean.actions)}::jsonb,
          enabled        = ${clean.enabled},
          updated_at     = NOW()
         WHERE id = ${id} AND workspace_id = ${workspaceId}
         RETURNING *
      `;
      return ok(res, { workflow: serializeWorkflow(upd.rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM workflows WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

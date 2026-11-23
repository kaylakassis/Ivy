// /api/workflows
//   GET  → list workflows for this workspace (newest first)
//   POST → create a new workflow
//
// Each row carries a small `lastRunSummary` derived from the most
// recent workflow_runs entry so the UI can show "Ran 2h ago · 3
// succeeded" without a follow-up fetch.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { validateWorkflowShape, serializeWorkflow } from '../_lib/workflows.js';
import { detectWorkflowSuggestion, explainWorkflowSuggestion } from '../_lib/workflowSuggest.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (req.method === 'GET') {
      // Partial-schema tolerant: empty list if any table is missing.
      try {
        const { rows } = await sql`
          SELECT w.*,
                 (SELECT jsonb_build_object(
                    'status', r.status,
                    'triggeredAt', r.triggered_at
                  ) FROM workflow_runs r
                   WHERE r.workflow_id = w.id
                   ORDER BY r.triggered_at DESC
                   LIMIT 1) AS last_run_summary
            FROM workflows w
           WHERE w.workspace_id = ${workspaceId}
           ORDER BY w.updated_at DESC
        `;
        // ?noticed=1 (the Automation screen): anything the owner does the
        // same way every time that Ivy could take over, with the evidence
        // behind it (their own clients and counts, never ids). A hiccup
        // here never hides the list.
        let noticed;
        if (req.query?.noticed === '1') {
          const dismissed = Array.isArray(user.ui_prefs?.dismissedWorkflowSuggestions) ? user.ui_prefs.dismissedWorkflowSuggestions : [];
          const [suggestion, evidence] = await Promise.all([
            detectWorkflowSuggestion(workspaceId, { dismissed }).catch(() => null),
            explainWorkflowSuggestion(workspaceId, { dismissed }).catch(() => null),
          ]);
          noticed = { suggestion: suggestion || null, evidence: suggestion ? (evidence || null) : null };
        }
        return ok(res, {
          workflows: rows.map((r) => serializeWorkflow(r, r.last_run_summary || null)),
          ...(noticed ? { noticed } : {}),
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[workflows GET] failed (returning empty):', e.message);
        return ok(res, { workflows: [] });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let clean;
      try { clean = validateWorkflowShape(body); }
      catch (err) { return badRequest(res, err.message); }
      const ins = await sql`
        INSERT INTO workflows (
          workspace_id, name, description, trigger_type, trigger_config, actions, enabled
        ) VALUES (
          ${workspaceId}, ${clean.name}, ${clean.description},
          ${clean.triggerType},
          ${JSON.stringify(clean.triggerConfig)}::jsonb,
          ${JSON.stringify(clean.actions)}::jsonb,
          ${clean.enabled}
        )
        RETURNING *
      `;
      return created(res, { workflow: serializeWorkflow(ins.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

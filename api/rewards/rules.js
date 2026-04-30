// /api/rewards/rules
//   GET  → list rules for current workspace
//   POST → create a new rule
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeRule, VALID_RULE_TYPES } from '../_lib/rewards.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const r = await sql`
        SELECT * FROM reward_rules WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
      `;
      return ok(res, { rules: r.rows.map(serializeRule) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const type        = body.type || 'visit';
      const name        = (body.name || '').toString().trim();
      const triggerText = body.triggerText ? String(body.triggerText).slice(0, 240) : null;
      const rewardText  = body.rewardText  ? String(body.rewardText).slice(0, 240)  : null;
      const threshold   = Number(body.threshold ?? 0);
      const active      = body.active !== false;

      if (!VALID_RULE_TYPES.has(type)) return badRequest(res, 'Invalid type');
      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 240) return badRequest(res, 'Name too long');
      if (!Number.isFinite(threshold) || threshold < 0) return badRequest(res, 'threshold must be a non-negative number');

      const insert = await sql`
        INSERT INTO reward_rules (workspace_id, type, name, trigger_text, reward_text, threshold, active)
        VALUES (${workspaceId}, ${type}, ${name}, ${triggerText}, ${rewardText}, ${threshold}, ${active})
        RETURNING *
      `;
      return created(res, { rule: serializeRule(insert.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

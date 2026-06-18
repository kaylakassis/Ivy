// /api/rewards/rules/:id  - PATCH / DELETE
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { serializeRule, VALID_RULE_TYPES } from '../../_lib/rewards.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const found = await sql`SELECT * FROM reward_rules WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    if (found.rows.length === 0) return notFound(res, 'Rule not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = []; const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('type' in body) {
        if (!VALID_RULE_TYPES.has(body.type)) return badRequest(res, 'Invalid type');
        push('type', body.type);
      }
      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v || v.length > 240) return badRequest(res, 'Name is required (max 240 chars)');
        push('name', v);
      }
      if ('triggerText' in body) push('trigger_text', body.triggerText ? String(body.triggerText).slice(0, 240) : null);
      if ('rewardText'  in body) push('reward_text',  body.rewardText  ? String(body.rewardText).slice(0, 240)  : null);
      if ('threshold' in body) {
        const n = Number(body.threshold);
        if (!Number.isFinite(n) || n < 0) return badRequest(res, 'threshold must be a non-negative number');
        push('threshold', n);
      }
      if ('active' in body) push('active', !!body.active);

      if (sets.length === 0) return ok(res, { rule: serializeRule(found.rows[0]) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE reward_rules SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { rule: serializeRule(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM reward_rules WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

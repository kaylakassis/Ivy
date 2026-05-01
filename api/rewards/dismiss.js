// /api/rewards/dismiss — POST { ruleId, clientId }
// Owner waves off an auto-detected eligibility. Stored as a redemption with
// status='dismissed' so the same milestone won't re-fire (the count of
// redemptions matches the count of earned reward "stamps").
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeRedemption } from '../_lib/rewards.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const ruleId = body.ruleId ? String(body.ruleId) : null;
    const clientId = body.clientId ? String(body.clientId) : null;
    if (!ruleId)   return badRequest(res, 'ruleId is required');
    if (!clientId) return badRequest(res, 'clientId is required');

    const cl = await sql`
      SELECT id, name FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}
    `;
    if (cl.rows.length === 0) return badRequest(res, 'Unknown client');

    const ru = await sql`
      SELECT id, reward_text FROM reward_rules WHERE id = ${ruleId} AND workspace_id = ${workspaceId}
    `;
    if (ru.rows.length === 0) return badRequest(res, 'Unknown rule');

    const ins = await sql`
      INSERT INTO reward_redemptions (
        workspace_id, rule_id, client_id, client_name, reward_text,
        status, auto_detected
      )
      VALUES (
        ${workspaceId}, ${ruleId}, ${clientId}, ${cl.rows[0].name}, ${ru.rows[0].reward_text},
        'dismissed', TRUE
      )
      RETURNING *
    `;
    return created(res, { redemption: serializeRedemption(ins.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

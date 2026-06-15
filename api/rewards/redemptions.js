// /api/rewards/redemptions
//   POST → log a new redemption (owner records that they gave a client a reward)
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
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
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const ruleId = body.ruleId ? String(body.ruleId) : null;
    const clientId = body.clientId ? String(body.clientId) : null;
    const rewardText = body.rewardText ? String(body.rewardText).slice(0, 240) : null;
    const notes = body.notes ? String(body.notes).slice(0, 1000) : null;

    if (!clientId) return badRequest(res, 'clientId is required');

    const cl = await sql`SELECT id, name FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
    if (cl.rows.length === 0) return badRequest(res, 'Unknown client');

    if (ruleId) {
      const ru = await sql`SELECT id, reward_text FROM reward_rules WHERE id = ${ruleId} AND workspace_id = ${workspaceId}`;
      if (ru.rows.length === 0) return badRequest(res, 'Unknown rule');
    }

    const insert = await sql`
      INSERT INTO reward_redemptions (workspace_id, rule_id, client_id, client_name, reward_text, notes)
      VALUES (${workspaceId}, ${ruleId}, ${clientId}, ${cl.rows[0].name}, ${rewardText}, ${notes})
      RETURNING *
    `;
    return created(res, { redemption: serializeRedemption(insert.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}

// /api/rewards/confirm - POST { ruleId, clientId, validityDays?, sendMessage? }
// Owner confirms an auto-detected eligibility. Inserts a redemption row with
// status='issued' and (by default) drops a chat message in the client's thread
// announcing the reward and its validity window.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { issueReward, serializeRedemption, serializeRule } from '../_lib/rewards.js';
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
    const validityDays = Number.isFinite(Number(body.validityDays))
      ? Math.max(1, Math.min(365, Number(body.validityDays)))
      : undefined;
    const sendMessage = body.sendMessage !== false;

    if (!ruleId)   return badRequest(res, 'ruleId is required');
    if (!clientId) return badRequest(res, 'clientId is required');

    const ruRows = await sql`
      SELECT * FROM reward_rules WHERE id = ${ruleId} AND workspace_id = ${workspaceId}
    `;
    if (ruRows.rows.length === 0) return badRequest(res, 'Unknown rule');
    const rule = serializeRule(ruRows.rows[0]);

    const { redemption, messageId } = await issueReward({
      workspaceId, rule, clientId, validityDays, sendMessage,
    });

    return created(res, {
      redemption: serializeRedemption(redemption),
      messageId,
    });
  } catch (err) {
    if (err.status === 400) return badRequest(res, err.message);
    return serverError(res, err);
  }
}

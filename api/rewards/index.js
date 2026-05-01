// /api/rewards
//   GET    → full state: settings, rules, redemptions, KPIs
//   PATCH  → toggle launched (body { launched: true } sets launched_at; false clears)

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  ensureRewardSettings, serializeRule, serializeRedemption, rewardKpis,
  pendingRewards,
} from '../_lib/rewards.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const settings = await ensureRewardSettings(workspaceId);
      const rules = await sql`
        SELECT * FROM reward_rules WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
      `;
      const redemptions = await sql`
        SELECT * FROM reward_redemptions WHERE workspace_id = ${workspaceId}
        ORDER BY redeemed_at DESC
        LIMIT 200
      `;
      const kpis = await rewardKpis(workspaceId);
      const pending = await pendingRewards(workspaceId);

      return ok(res, {
        rewards: {
          settings: { launchedAt: settings.launched_at, launched: !!settings.launched_at },
          rules: rules.rows.map(serializeRule),
          redemptions: redemptions.rows.map(serializeRedemption),
          kpis,
          pending,
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      let launchedAt;
      if (body.launched === true)  launchedAt = new Date().toISOString();
      if (body.launched === false) launchedAt = null;
      else if (!('launched' in body)) {
        const r = await ensureRewardSettings(workspaceId);
        return ok(res, { settings: { launchedAt: r.launched_at, launched: !!r.launched_at } });
      }
      // ensure exists then update
      await ensureRewardSettings(workspaceId);
      const upd = await sql`
        UPDATE reward_settings SET launched_at = ${launchedAt}
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      const r = upd.rows[0];
      return ok(res, { settings: { launchedAt: r.launched_at, launched: !!r.launched_at } });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

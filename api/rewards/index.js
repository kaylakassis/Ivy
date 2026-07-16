// /api/rewards
//   GET    → full state: settings, rules, redemptions, KPIs
//   PATCH  → toggle launched (body { launched: true } sets launched_at; false clears)

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  ensureRewardSettings, serializeRule, serializeRedemption, rewardKpis,
  pendingRewards,
} from '../_lib/rewards.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      // Per-query try/catch - any single missing table degrades to an
      // empty fallback rather than 500ing the whole Rewards tab.
      const safe = async (p, fallback) => { try { return await p; } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[rewards GET] sub-query failed:', e.message);
        return fallback;
      } };
      const settings    = await safe(ensureRewardSettings(workspaceId), { launched_at: null });
      const rules       = await safe(sql`SELECT * FROM reward_rules WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC`, { rows: [] });
      const redemptions = await safe(sql`SELECT * FROM reward_redemptions WHERE workspace_id = ${workspaceId} ORDER BY redeemed_at DESC LIMIT 200`, { rows: [] });
      const kpis        = await safe(rewardKpis(workspaceId), { totalIssued: 0, redeemed: 0, outstanding: 0 });
      const pending     = await safe(pendingRewards(workspaceId), []);

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
      if (!('launched' in body)) {
        const r = await ensureRewardSettings(workspaceId);
        return ok(res, { settings: { launchedAt: r.launched_at, launched: !!r.launched_at } });
      }
      // Strict boolean only - a truthy non-boolean used to fall through
      // with launchedAt undefined and silently pause the program.
      if (typeof body.launched !== 'boolean') {
        return badRequest(res, 'launched must be true or false');
      }
      const launchedAt = body.launched ? new Date().toISOString() : null;
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

// GET/PATCH /api/onboarding/profile
//
// The owner-stated answers from the onboarding "About you" step. Stored
// in workspace_profile (one row per workspace). Two consumers:
//   • Ivy reads them (via workspaceContext) to personalize coaching.
//   • The admin Overview rolls the preset answers into aggregate
//     distributions.
//
// Onboarding endpoints are EXEMPT from the subscription gate (an owner
// must be able to finish setup before/regardless of billing), so this
// uses ensureWorkspace, not ensureActiveWorkspace - same as the rest of
// api/onboarding/*.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

// Allowed preset option ids per question. Free-text fields are length-
// capped but otherwise unconstrained. Keeping the allowlist server-side
// means the admin aggregates only ever group over known values.
const PRESETS = {
  goal:       new Set(['grow_revenue', 'more_clients', 'save_time', 'look_pro']),
  challenge:  new Set(['leads', 'no_shows', 'getting_paid', 'organized', 'marketing']),
  heard_from: new Set(['instagram', 'tiktok', 'google', 'referral']),
  stage:      new Set(['starting', 'side_hustle', 'established', 'scaling']),
};
const FREE_TEXT_MAX = 500;

function cleanPreset(field, v) {
  if (v == null || v === '') return null;
  const s = String(v);
  return PRESETS[field].has(s) ? s : null;
}
function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, FREE_TEXT_MAX) : null;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT goal, goal_other, challenge, challenge_other, ideal_client,
               heard_from, heard_from_other, stage
          FROM workspace_profile WHERE workspace_id = ${workspaceId}
      `;
      return ok(res, { profile: serialize(rows[0] || null) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const goal          = cleanPreset('goal', body.goal);
      const challenge     = cleanPreset('challenge', body.challenge);
      const heardFrom     = cleanPreset('heard_from', body.heardFrom ?? body.heard_from);
      const stage         = cleanPreset('stage', body.stage);
      // "_other" free text only kept when the matching preset is unset
      // (the UI shows the Other field in place of a preset choice).
      const goalOther      = goal ? null : cleanText(body.goalOther ?? body.goal_other);
      const challengeOther = challenge ? null : cleanText(body.challengeOther ?? body.challenge_other);
      const heardOther     = heardFrom ? null : cleanText(body.heardFromOther ?? body.heard_from_other);
      const idealClient    = cleanText(body.idealClient ?? body.ideal_client);

      const { rows } = await sql`
        INSERT INTO workspace_profile (
          workspace_id, goal, goal_other, challenge, challenge_other,
          ideal_client, heard_from, heard_from_other, stage, updated_at
        ) VALUES (
          ${workspaceId}, ${goal}, ${goalOther}, ${challenge}, ${challengeOther},
          ${idealClient}, ${heardFrom}, ${heardOther}, ${stage}, NOW()
        )
        ON CONFLICT (workspace_id) DO UPDATE SET
          goal             = EXCLUDED.goal,
          goal_other       = EXCLUDED.goal_other,
          challenge        = EXCLUDED.challenge,
          challenge_other  = EXCLUDED.challenge_other,
          ideal_client     = EXCLUDED.ideal_client,
          heard_from       = EXCLUDED.heard_from,
          heard_from_other = EXCLUDED.heard_from_other,
          stage            = EXCLUDED.stage,
          updated_at       = NOW()
        RETURNING goal, goal_other, challenge, challenge_other, ideal_client,
                  heard_from, heard_from_other, stage
      `;
      return ok(res, { profile: serialize(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

function serialize(r) {
  if (!r) return null;
  return {
    goal:           r.goal || null,
    goalOther:      r.goal_other || null,
    challenge:      r.challenge || null,
    challengeOther: r.challenge_other || null,
    idealClient:    r.ideal_client || null,
    heardFrom:      r.heard_from || null,
    heardFromOther: r.heard_from_other || null,
    stage:          r.stage || null,
  };
}

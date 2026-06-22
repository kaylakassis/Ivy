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
// Multi-select variant: accepts an array, drops anything not in the
// allowlist, dedups while preserving order. Cap of 10 entries so a
// malformed client can't flood the row with a giant array.
function cleanPresetArray(field, arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    if (!PRESETS[field].has(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v); out.push(v);
    if (out.length >= 10) break;
  }
  return out;
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
               heard_from, heard_from_other, stage,
               goal_ids, challenge_ids, heard_from_ids, stage_ids
          FROM workspace_profile WHERE workspace_id = ${workspaceId}
      `;
      return ok(res, { profile: serialize(rows[0] || null) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Multi-select arrays take precedence when supplied. Fall back to
      // the single legacy field so existing callers (admin tools, older
      // mobile builds) keep working.
      const goalIds       = cleanPresetArray('goal',       body.goalIds       ?? body.goal_ids);
      const challengeIds  = cleanPresetArray('challenge',  body.challengeIds  ?? body.challenge_ids);
      const heardIds      = cleanPresetArray('heard_from', body.heardFromIds  ?? body.heard_from_ids);
      const stageIds      = cleanPresetArray('stage',      body.stageIds      ?? body.stage_ids);
      const fallbackGoal  = cleanPreset('goal',       body.goal);
      const fallbackChal  = cleanPreset('challenge',  body.challenge);
      const fallbackHeard = cleanPreset('heard_from', body.heardFrom ?? body.heard_from);
      const fallbackStage = cleanPreset('stage',      body.stage);
      // Final array shape: arrays-first, single-field fallback wrapped.
      const goalArr      = goalIds.length      ? goalIds      : (fallbackGoal  ? [fallbackGoal]  : []);
      const challengeArr = challengeIds.length ? challengeIds : (fallbackChal  ? [fallbackChal]  : []);
      const heardArr     = heardIds.length     ? heardIds     : (fallbackHeard ? [fallbackHeard] : []);
      const stageArr     = stageIds.length     ? stageIds     : (fallbackStage ? [fallbackStage] : []);
      // Single columns kept in sync with arr[0] so legacy readers (admin
      // aggregates + Ivy workspaceContext) keep working unchanged.
      const goal          = goalArr[0]      || null;
      const challenge     = challengeArr[0] || null;
      const heardFrom     = heardArr[0]     || null;
      const stage         = stageArr[0]     || null;
      // "_other" free text only kept when the matching preset is unset
      // (the UI shows the Other field in place of a preset choice).
      const goalOther      = goal ? null : cleanText(body.goalOther ?? body.goal_other);
      const challengeOther = challenge ? null : cleanText(body.challengeOther ?? body.challenge_other);
      const heardOther     = heardFrom ? null : cleanText(body.heardFromOther ?? body.heard_from_other);
      const idealClient    = cleanText(body.idealClient ?? body.ideal_client);

      const { rows } = await sql`
        INSERT INTO workspace_profile (
          workspace_id, goal, goal_other, challenge, challenge_other,
          ideal_client, heard_from, heard_from_other, stage,
          goal_ids, challenge_ids, heard_from_ids, stage_ids, updated_at
        ) VALUES (
          ${workspaceId}, ${goal}, ${goalOther}, ${challenge}, ${challengeOther},
          ${idealClient}, ${heardFrom}, ${heardOther}, ${stage},
          ${JSON.stringify(goalArr)}::jsonb,
          ${JSON.stringify(challengeArr)}::jsonb,
          ${JSON.stringify(heardArr)}::jsonb,
          ${JSON.stringify(stageArr)}::jsonb,
          NOW()
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
          goal_ids         = EXCLUDED.goal_ids,
          challenge_ids    = EXCLUDED.challenge_ids,
          heard_from_ids   = EXCLUDED.heard_from_ids,
          stage_ids        = EXCLUDED.stage_ids,
          updated_at       = NOW()
        RETURNING goal, goal_other, challenge, challenge_other, ideal_client,
                  heard_from, heard_from_other, stage,
                  goal_ids, challenge_ids, heard_from_ids, stage_ids
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
  // Hydrate arrays from the JSONB column when present; fall back to a
  // single-element array of the legacy column so an older row (saved
  // before the multi-select migration) still shows up as a selection in
  // the picker.
  const asArr = (jsonb, legacy) => {
    if (Array.isArray(jsonb) && jsonb.length) return jsonb;
    return legacy ? [legacy] : [];
  };
  return {
    goal:           r.goal || null,
    goalOther:      r.goal_other || null,
    goalIds:        asArr(r.goal_ids,       r.goal),
    challenge:      r.challenge || null,
    challengeOther: r.challenge_other || null,
    challengeIds:   asArr(r.challenge_ids,  r.challenge),
    idealClient:    r.ideal_client || null,
    heardFrom:      r.heard_from || null,
    heardFromOther: r.heard_from_other || null,
    heardFromIds:   asArr(r.heard_from_ids, r.heard_from),
    stage:          r.stage || null,
    stageIds:       asArr(r.stage_ids,      r.stage),
  };
}

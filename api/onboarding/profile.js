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
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { US_STATE_CODES, US_COUNTRY } from '../../src/lib/locations.js';
import { missingRequiredAnswers } from '../_lib/onboardingAnswers.js';

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
function cleanText(v, max = FREE_TEXT_MAX) {
  if (v == null || typeof v === 'object') return null;
  // Control characters out, whitespace collapsed: these strings are shown
  // back in the admin view and fed to Ivy as plain text.
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
const COUNTRY_MAX = 80;
const REFERRAL_NAME_MAX = 120;
const has = (o, ...keys) => keys.some((k) => Object.prototype.hasOwnProperty.call(o, k));
// "Where is your business based?" A US state code from the allowlist wins
// (country is then the US); otherwise the typed or picked country.
// Unknown codes are dropped like unknown presets, never a 400.
function cleanLocation(body) {
  const rawState = body.locationState ?? body.location_state;
  const code = typeof rawState === 'string' ? rawState.trim().toUpperCase() : '';
  if (US_STATE_CODES.has(code)) return { state: code, country: US_COUNTRY };
  const country = cleanText(body.locationCountry ?? body.location_country, COUNTRY_MAX);
  return { state: null, country };
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
               goal_ids, challenge_ids, heard_from_ids, stage_ids,
               location_state, location_country, referral_name
          FROM workspace_profile WHERE workspace_id = ${workspaceId}
      `;
      return ok(res, { profile: serialize(rows[0] || null), missing: missingRequiredAnswers(rows[0] || null) });
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
      // "_other" free text is kept whenever it was typed, even alongside
      // presets: the questions are multi-select, so "Instagram + Other:
      // my cousin's podcast" is one answer. (It used to be dropped when
      // any preset was also picked.)
      const goalOther      = cleanText(body.goalOther ?? body.goal_other);
      const challengeOther = cleanText(body.challengeOther ?? body.challenge_other);
      const heardOther     = cleanText(body.heardFromOther ?? body.heard_from_other);
      const idealClient    = cleanText(body.idealClient ?? body.ideal_client);
      // Newer answers. Only written when the request carries them, so an
      // older app build (which never sends them) re-saving the About step
      // can't wipe what a newer build stored.
      const locationSent = has(body, 'locationState', 'location_state', 'locationCountry', 'location_country');
      const loc = locationSent ? cleanLocation(body) : { state: null, country: null };
      // The referrer's name only means something next to "Friend / referral":
      // cleared when that isn't picked, kept as stored when an older build
      // re-saves with referral still picked but no name field.
      const referralPicked = heardArr.includes('referral');
      const referralSent = has(body, 'referralName', 'referral_name');
      const referralName = referralSent && referralPicked
        ? cleanText(body.referralName ?? body.referral_name, REFERRAL_NAME_MAX)
        : null;
      const referralKeep = referralPicked && !referralSent;

      // Required answers are never erased by an empty one. Every current
      // screen requires them, so an empty answer only arrives from an older
      // app build whose About step left the question optional (or never
      // asked it). Without this, re-saving there would wipe what the owner
      // already answered and the required-questions sheet would come back.
      const keepGoal      = goalArr.length === 0 && !goalOther;
      const keepChallenge = challengeArr.length === 0 && !challengeOther;
      const keepHeard     = heardArr.length === 0 && !heardOther;
      const keepStage     = stageArr.length === 0;
      // An empty location from a new build is the same story.
      const locationWrite = locationSent && !!(loc.state || loc.country);

      const { rows } = await sql`
        INSERT INTO workspace_profile (
          workspace_id, goal, goal_other, challenge, challenge_other,
          ideal_client, heard_from, heard_from_other, stage,
          goal_ids, challenge_ids, heard_from_ids, stage_ids,
          location_state, location_country, referral_name, updated_at
        ) VALUES (
          ${workspaceId}, ${goal}, ${goalOther}, ${challenge}, ${challengeOther},
          ${idealClient}, ${heardFrom}, ${heardOther}, ${stage},
          ${JSON.stringify(goalArr)}::jsonb,
          ${JSON.stringify(challengeArr)}::jsonb,
          ${JSON.stringify(heardArr)}::jsonb,
          ${JSON.stringify(stageArr)}::jsonb,
          ${loc.state}, ${loc.country}, ${referralName},
          NOW()
        )
        ON CONFLICT (workspace_id) DO UPDATE SET
          goal             = CASE WHEN ${keepGoal} THEN workspace_profile.goal ELSE EXCLUDED.goal END,
          goal_other       = CASE WHEN ${keepGoal} THEN workspace_profile.goal_other ELSE EXCLUDED.goal_other END,
          challenge        = CASE WHEN ${keepChallenge} THEN workspace_profile.challenge ELSE EXCLUDED.challenge END,
          challenge_other  = CASE WHEN ${keepChallenge} THEN workspace_profile.challenge_other ELSE EXCLUDED.challenge_other END,
          ideal_client     = EXCLUDED.ideal_client,
          heard_from       = CASE WHEN ${keepHeard} THEN workspace_profile.heard_from ELSE EXCLUDED.heard_from END,
          heard_from_other = CASE WHEN ${keepHeard} THEN workspace_profile.heard_from_other ELSE EXCLUDED.heard_from_other END,
          stage            = CASE WHEN ${keepStage} THEN workspace_profile.stage ELSE EXCLUDED.stage END,
          goal_ids         = CASE WHEN ${keepGoal} THEN workspace_profile.goal_ids ELSE EXCLUDED.goal_ids END,
          challenge_ids    = CASE WHEN ${keepChallenge} THEN workspace_profile.challenge_ids ELSE EXCLUDED.challenge_ids END,
          heard_from_ids   = CASE WHEN ${keepHeard} THEN workspace_profile.heard_from_ids ELSE EXCLUDED.heard_from_ids END,
          stage_ids        = CASE WHEN ${keepStage} THEN workspace_profile.stage_ids ELSE EXCLUDED.stage_ids END,
          location_state   = CASE WHEN ${locationWrite} THEN EXCLUDED.location_state   ELSE workspace_profile.location_state END,
          location_country = CASE WHEN ${locationWrite} THEN EXCLUDED.location_country ELSE workspace_profile.location_country END,
          referral_name    = CASE WHEN ${referralKeep} THEN workspace_profile.referral_name ELSE EXCLUDED.referral_name END,
          updated_at       = NOW()
        RETURNING goal, goal_other, challenge, challenge_other, ideal_client,
                  heard_from, heard_from_other, stage,
                  goal_ids, challenge_ids, heard_from_ids, stage_ids,
                  location_state, location_country, referral_name
      `;
      return ok(res, { profile: serialize(rows[0]), missing: missingRequiredAnswers(rows[0]) });
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
    locationState:   r.location_state || null,
    locationCountry: r.location_country || null,
    referralName:    r.referral_name || null,
  };
}

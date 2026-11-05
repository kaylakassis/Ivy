// The required onboarding answers (the "About you" questions every owner
// must answer): how they heard about Ivy, where the business is based,
// business stage, at least one goal and at least one thing draining them.
//
// One definition, used by:
//   • GET /api/me (onboardingAnswersMissing), which drives the required
//     "A few quick questions" sheet in the owner app;
//   • GET/PATCH /api/onboarding/profile (missing);
//   • the super-admin Users list filter "Missing onboarding answers" and the
//     per-user onboarding panel.
// The client mirror is missingFromAbout() in src/features/onboarding/
// aboutFields.jsx. Keep the two in step.
//
// A typed "Other" answer counts as answered. Old rows that only have the
// legacy single-value columns (saved before multi-select) count too.

export const REQUIRED_ANSWERS = ['heardFrom', 'location', 'stage', 'goals', 'challenges'];

const nonEmptyArr = (v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim());
const text = (v) => typeof v === 'string' && v.trim().length > 0;

// workspace_profile row (snake_case, or null when the owner never saved
// the About step) → the required answer keys still missing, in a stable
// order. An empty array means everything required is answered.
export function missingRequiredAnswers(p) {
  if (!p) return [...REQUIRED_ANSWERS];
  const missing = [];
  if (!(nonEmptyArr(p.heard_from_ids) || text(p.heard_from) || text(p.heard_from_other))) missing.push('heardFrom');
  if (!(text(p.location_state) || text(p.location_country))) missing.push('location');
  if (!(nonEmptyArr(p.stage_ids) || text(p.stage))) missing.push('stage');
  if (!(nonEmptyArr(p.goal_ids) || text(p.goal) || text(p.goal_other))) missing.push('goals');
  if (!(nonEmptyArr(p.challenge_ids) || text(p.challenge) || text(p.challenge_other))) missing.push('challenges');
  return missing;
}

// Same rule as SQL, over a workspace_profile alias. TRUE when every
// required answer is present. A fixed string (no request input), so it can
// be dropped into a hand-built query safely.
export function requiredAnsweredSql(alias = 'wp') {
  const arr = (col) => `(jsonb_typeof(${alias}.${col}) = 'array' AND jsonb_array_length(${alias}.${col}) > 0)`;
  const txt = (col) => `(COALESCE(BTRIM(${alias}.${col}), '') <> '')`;
  return `(
    (${arr('heard_from_ids')} OR ${txt('heard_from')} OR ${txt('heard_from_other')})
    AND (${txt('location_state')} OR ${txt('location_country')})
    AND (${arr('stage_ids')} OR ${txt('stage')})
    AND (${arr('goal_ids')} OR ${txt('goal')} OR ${txt('goal_other')})
    AND (${arr('challenge_ids')} OR ${txt('challenge')} OR ${txt('challenge_other')})
  )`;
}

// SQL expression: how many required answers are missing (0-5) for alias.
export function missingCountSql(alias = 'wp') {
  const arr = (col) => `(jsonb_typeof(${alias}.${col}) = 'array' AND jsonb_array_length(${alias}.${col}) > 0)`;
  const txt = (col) => `(COALESCE(BTRIM(${alias}.${col}), '') <> '')`;
  const miss = (cond) => `(CASE WHEN ${cond} THEN 0 ELSE 1 END)`;
  return `(
    ${miss(`${arr('heard_from_ids')} OR ${txt('heard_from')} OR ${txt('heard_from_other')}`)}
    + ${miss(`${txt('location_state')} OR ${txt('location_country')}`)}
    + ${miss(`${arr('stage_ids')} OR ${txt('stage')}`)}
    + ${miss(`${arr('goal_ids')} OR ${txt('goal')} OR ${txt('goal_other')}`)}
    + ${miss(`${arr('challenge_ids')} OR ${txt('challenge')} OR ${txt('challenge_other')}`)}
  )`;
}

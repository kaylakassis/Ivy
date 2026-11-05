// GET /api/admin/users/:id/onboarding
//
// One owner's onboarding answers for the super-admin's Users view: how
// they heard about Ivy, where the business is based, stage, goals,
// challenges, ideal client, the app they were switching from, and how far
// through the wizard they got (current / completed / skipped steps with
// the server-stamped first-seen times) and when they finished.
//
// Super-admin only (same gate as the rest of /api/admin). Returns only the
// owner's own answers about their business. Nothing about their clients,
// bookings, invoices or messages. Accounts that signed up before a question
// existed simply come back with null for it; the UI says "Not answered".
import { sql } from '../../../_lib/db.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { requireSuperAdmin } from '../../../_lib/admin.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';
import { missingRequiredAnswers, REQUIRED_ANSWERS } from '../../../_lib/onboardingAnswers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// Hydrate a multi-select answer from the JSONB array, falling back to the
// legacy single column for rows saved before multi-select.
const ids = (jsonb, legacy) => {
  const a = arr(jsonb);
  if (a.length) return a;
  return legacy ? [legacy] : [];
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const id = String(req.query?.id || '');
    if (!UUID_RE.test(id)) return notFound(res, 'User not found');

    const { rows } = await sql`
      SELECT u.id, u.onboarding_state,
             w.id AS workspace_id, w.created_at AS workspace_created_at,
             w.onboarded_at, w.business_type,
             cs.biz_name, cs.category
        FROM users u
        LEFT JOIN workspaces w ON w.owner_id = u.id
        LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
       WHERE u.id = ${id}
       ORDER BY w.created_at ASC NULLS LAST
       LIMIT 1
    `;
    if (rows.length === 0) return notFound(res, 'User not found');
    const row = rows[0];

    if (!row.workspace_id) {
      return ok(res, {
        workspace: null,
        answers: null,
        progress: null,
        signupReferral: null,
        message: 'This account has no business, so there is no onboarding to show.',
      });
    }

    const [profileRes, refRes] = await Promise.all([
      sql`
        SELECT goal, goal_other, goal_ids, challenge, challenge_other, challenge_ids,
               ideal_client, heard_from, heard_from_other, heard_from_ids,
               stage, stage_ids, location_state, location_country, referral_name,
               created_at, updated_at
          FROM workspace_profile WHERE workspace_id = ${row.workspace_id}
      `,
      // The ?ref= code they signed up with, if any (affiliate partner or a
      // friend's "refer one, get one" code). Just the code; nothing else
      // about the other account.
      sql`
        SELECT 'affiliate' AS kind, a.code
          FROM affiliate_uses au JOIN affiliates a ON a.id = au.affiliate_id
         WHERE au.referred_user_id = ${id}
        UNION ALL
        SELECT 'friend' AS kind, r.code
          FROM referrals r
         WHERE r.referred_user_id = ${id}
        LIMIT 1
      `.catch(() => ({ rows: [] })),
    ]);
    const p = profileRes.rows[0] || null;
    const st = (row.onboarding_state && typeof row.onboarding_state === 'object') ? row.onboarding_state : {};
    const stamps = {};
    if (st.stepTimestamps && typeof st.stepTimestamps === 'object') {
      for (const [k, v] of Object.entries(st.stepTimestamps)) {
        if (typeof v === 'string') stamps[k] = v;
      }
    }

    return ok(res, {
      workspace: {
        id: row.workspace_id,
        businessName: row.biz_name || null,
        category: row.category || null,
        businessType: row.business_type || null,
        createdAt: row.workspace_created_at,
      },
      answers: p ? {
        heardFrom:      ids(p.heard_from_ids, p.heard_from),
        heardFromOther: p.heard_from_other || null,
        referralName:   p.referral_name || null,
        locationState:  p.location_state || null,
        locationCountry: p.location_country || null,
        stage:          ids(p.stage_ids, p.stage),
        goals:          ids(p.goal_ids, p.goal),
        goalOther:      p.goal_other || null,
        challenges:     ids(p.challenge_ids, p.challenge),
        challengeOther: p.challenge_other || null,
        idealClient:    p.ideal_client || null,
        answeredAt:     p.created_at || null,
        updatedAt:      p.updated_at || null,
      } : null,
      // The required questions (same rule as the owner app's required
      // sheet): which are still missing for this owner.
      required: (() => {
        const missing = missingRequiredAnswers(p);
        return { total: REQUIRED_ANSWERS.length, missing, answered: missing.length === 0 };
      })(),
      switchFrom: typeof st.switchFrom === 'string' ? st.switchFrom : null,
      progress: {
        currentStep:    typeof st.currentStep === 'string' ? st.currentStep : null,
        completedSteps: arr(st.completedSteps),
        skippedSteps:   arr(st.skippedSteps),
        stepTimestamps: stamps,
        lastActiveAt:   typeof st.lastActiveAt === 'string' ? st.lastActiveAt : null,
        finishedAt:     row.onboarded_at || null,
      },
      signupReferral: refRes.rows[0] ? { kind: refRes.rows[0].kind, code: refRes.rows[0].code } : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

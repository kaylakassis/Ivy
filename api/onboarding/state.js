// GET/PATCH /api/onboarding/state
//
// Persists the onboarding wizard's navigational state (current step,
// completed steps, skipped steps) so an owner who closes the tab in
// the middle of setup picks up exactly where they left off.
//
// Form data (business name, services, etc.) is NOT stored here — each
// step writes to its real table via existing endpoints (PATCH /calendar,
// PUT /calendar/services, etc.). This endpoint is purely about
// wizard navigation.
//
// Shape that comes back from GET / accepts from PATCH:
//   {
//     currentStep: 'services',
//     completedSteps: ['welcome', 'business'],
//     skippedSteps: [],
//     dismissedChecklistItems: [],
//     lastActiveAt: '<ISO>',
//   }
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

// Whitelist of step ids the client can claim it's on. Keeps the JSONB
// blob from being filled with arbitrary keys.
const VALID_STEPS = new Set([
  'welcome', 'business', 'services', 'availability',
  'payments', 'branding', 'first_client', 'website',
  'tour', 'done',
]);

function normalizeState(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const completedSteps = Array.isArray(s.completedSteps)
    ? s.completedSteps.filter((x) => typeof x === 'string' && VALID_STEPS.has(x))
    : [];
  const skippedSteps = Array.isArray(s.skippedSteps)
    ? s.skippedSteps.filter((x) => typeof x === 'string' && VALID_STEPS.has(x))
    : [];
  const dismissedChecklistItems = Array.isArray(s.dismissedChecklistItems)
    ? s.dismissedChecklistItems.filter((x) => typeof x === 'string').slice(0, 50)
    : [];
  return {
    currentStep: VALID_STEPS.has(s.currentStep) ? s.currentStep : 'welcome',
    completedSteps,
    skippedSteps,
    dismissedChecklistItems,
    lastActiveAt: s.lastActiveAt || null,
  };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const { rows } = await sql`SELECT onboarding_state FROM users WHERE id = ${user.id}`;
      return ok(res, { state: normalizeState(rows[0]?.onboarding_state) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Read existing first so a partial PATCH only updates the keys
      // the client supplied — closing the tab between two PATCHes
      // shouldn't blow away the half they already committed.
      const { rows } = await sql`SELECT onboarding_state FROM users WHERE id = ${user.id}`;
      const current = normalizeState(rows[0]?.onboarding_state);

      const next = {
        currentStep:             body.currentStep ?? current.currentStep,
        completedSteps:          Array.isArray(body.completedSteps) ? body.completedSteps : current.completedSteps,
        skippedSteps:            Array.isArray(body.skippedSteps)   ? body.skippedSteps   : current.skippedSteps,
        dismissedChecklistItems: Array.isArray(body.dismissedChecklistItems)
          ? body.dismissedChecklistItems
          : current.dismissedChecklistItems,
        lastActiveAt: new Date().toISOString(),
      };
      const normalized = normalizeState(next);
      if (normalized.completedSteps.length > 50 || normalized.skippedSteps.length > 50) {
        return badRequest(res, 'Too many step entries');
      }
      await sql`
        UPDATE users SET onboarding_state = ${JSON.stringify(normalized)}::jsonb,
                         updated_at = NOW()
         WHERE id = ${user.id}
      `;
      return ok(res, { state: normalized });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

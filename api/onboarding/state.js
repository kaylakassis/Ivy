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
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

// Defensive: this column was added in a later migration. On a cold-
// started function whose probe succeeds with partial schema, the
// SELECT below would otherwise 500 silently. We try to add it inline
// once per process so the wizard's "Let's go" can never 500 because
// of missing schema.
let columnHealed = false;
async function healColumn() {
  if (columnHealed) return;
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}'::jsonb`;
    columnHealed = true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[onboarding/state] self-heal ALTER failed (will rely on bootstrap):', e.message);
  }
}

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

// Run a `users.onboarding_state` read with self-heal: if the column
// doesn't exist (cold deploy, partial migration), we ADD it inline and
// retry once. Beyond that retry we bubble up so the user sees an error.
async function readState(userId) {
  try {
    const r = await sql`SELECT onboarding_state FROM users WHERE id = ${userId}`;
    return r.rows[0]?.onboarding_state;
  } catch (e) {
    if (/onboarding_state.*does not exist|column .* does not exist/i.test(e.message || '')) {
      await healColumn();
      const r = await sql`SELECT onboarding_state FROM users WHERE id = ${userId}`;
      return r.rows[0]?.onboarding_state;
    }
    throw e;
  }
}

async function writeState(userId, jsonStr) {
  try {
    await sql`UPDATE users SET onboarding_state = ${jsonStr}::jsonb, updated_at = NOW() WHERE id = ${userId}`;
  } catch (e) {
    if (/onboarding_state.*does not exist|column .* does not exist/i.test(e.message || '')) {
      await healColumn();
      await sql`UPDATE users SET onboarding_state = ${jsonStr}::jsonb, updated_at = NOW() WHERE id = ${userId}`;
      return;
    }
    throw e;
  }
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    // Belt + suspenders: requireUser triggers ensureSchemaApplied via
    // auth.js, but if the probe succeeds against partial schema this
    // is our backstop. The actual reads/writes also self-heal below.
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const raw = await readState(user.id);
      return ok(res, { state: normalizeState(raw) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Read existing first so a partial PATCH only updates the keys
      // the client supplied — closing the tab between two PATCHes
      // shouldn't blow away the half they already committed.
      const current = normalizeState(await readState(user.id));

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
      await writeState(user.id, JSON.stringify(normalized));
      return ok(res, { state: normalized });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

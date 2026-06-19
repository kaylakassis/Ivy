// GET/PATCH /api/onboarding/state
//
// Persists the onboarding wizard's navigational state (current step,
// completed steps, skipped steps) so an owner who closes the tab in
// the middle of setup picks up exactly where they left off.
//
// Form data (business name, services, etc.) is NOT stored here - each
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
//     stepTimestamps: { welcome: '<ISO>', business: '<ISO>', ... },  // funnel drop-off
//     lastActiveAt: '<ISO>',
//   }
//
// stepTimestamps is FIRST-SEEN times, recorded server-side - the first
// PATCH whose currentStep names a step not yet in the map stamps it. The
// client never sends timestamps; that keeps the drop-off measurement
// honest (a user can't backfill timestamps for steps they skipped).
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
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
  'welcome', 'business', 'about', 'services', 'availability',
  'first_product',                              // product-only flow replaces 'services' with this
  'payments', 'branding', 'first_client', 'website',
  'tour', 'done',
]);

const VALID_BUSINESS_TYPES = new Set(['service', 'product', 'both']);

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
  // Per-step first-seen timestamps. Filter keys to VALID_STEPS so a stale
  // step id from a prior version can't pollute the map.
  const stepTimestamps = {};
  if (s.stepTimestamps && typeof s.stepTimestamps === 'object') {
    for (const [k, v] of Object.entries(s.stepTimestamps)) {
      if (VALID_STEPS.has(k) && typeof v === 'string') stepTimestamps[k] = v;
    }
  }
  return {
    currentStep: VALID_STEPS.has(s.currentStep) ? s.currentStep : 'welcome',
    completedSteps,
    skippedSteps,
    dismissedChecklistItems,
    stepTimestamps,
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
      // Carry business_type alongside wizard state so the OnboardingPage
      // can render the right step set on first paint without an extra
      // round trip. Self-heal: if the column hasn't been added yet,
      // default to 'both' (the schema default) instead of 500-ing.
      let businessType = 'both';
      try {
        const workspaceId = await ensureWorkspace(user.id);
        const w = await sql`SELECT business_type FROM workspaces WHERE id = ${workspaceId}`;
        businessType = w.rows[0]?.business_type || 'both';
      } catch { /* missing column on a cold deploy - fall back to default */ }
      return ok(res, { state: normalizeState(raw), businessType });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Read existing first so a partial PATCH only updates the keys
      // the client supplied - closing the tab between two PATCHes
      // shouldn't blow away the half they already committed.
      const current = normalizeState(await readState(user.id));

      // Server-stamp the FIRST time each step is reached. We look at the
      // resolved nextCurrentStep AND every step in the completedSteps
      // array (in case the client jumped past one) so the funnel can
      // compute per-step drop-off without trusting client clocks.
      const nowIso = new Date().toISOString();
      const nextCurrentStep = body.currentStep ?? current.currentStep;
      const stepTimestamps = { ...current.stepTimestamps };
      const stampIfNew = (id) => {
        if (VALID_STEPS.has(id) && !stepTimestamps[id]) stepTimestamps[id] = nowIso;
      };
      stampIfNew(nextCurrentStep);
      const nextCompleted = Array.isArray(body.completedSteps) ? body.completedSteps : current.completedSteps;
      for (const id of nextCompleted) stampIfNew(id);

      const next = {
        currentStep:             nextCurrentStep,
        completedSteps:          nextCompleted,
        skippedSteps:            Array.isArray(body.skippedSteps)   ? body.skippedSteps   : current.skippedSteps,
        dismissedChecklistItems: Array.isArray(body.dismissedChecklistItems)
          ? body.dismissedChecklistItems
          : current.dismissedChecklistItems,
        stepTimestamps,
        lastActiveAt: nowIso,
      };
      const normalized = normalizeState(next);
      if (normalized.completedSteps.length > 50 || normalized.skippedSteps.length > 50) {
        return badRequest(res, 'Too many step entries');
      }
      await writeState(user.id, JSON.stringify(normalized));

      // Business type writes go to workspaces (not the JSONB state) so
      // the rest of the app can use a single source of truth via a
      // simple column read. We accept it on the same PATCH so the
      // Welcome step's "What do you sell?" radio commits in one round
      // trip with the step advance.
      let businessType = 'both';
      if (body.businessType && VALID_BUSINESS_TYPES.has(body.businessType)) {
        try {
          const workspaceId = await ensureWorkspace(user.id);
          await sql`UPDATE workspaces SET business_type = ${body.businessType} WHERE id = ${workspaceId}`;
          businessType = body.businessType;
        } catch (e) {
          // Don't fail the wizard PATCH on a schema-laggy cold deploy
          // - the column will heal on next refresh.
          // eslint-disable-next-line no-console
          console.error('[onboarding/state] business_type write failed:', e.message);
        }
      } else {
        try {
          const workspaceId = await ensureWorkspace(user.id);
          const w = await sql`SELECT business_type FROM workspaces WHERE id = ${workspaceId}`;
          businessType = w.rows[0]?.business_type || 'both';
        } catch { /* fall back */ }
      }
      return ok(res, { state: normalized, businessType });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

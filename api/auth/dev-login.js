// GET /api/auth/dev-login?token=<DEV_LOGIN_SECRET>&state=<preset>
//
// Passwordless QA login. Logs you into ONE dedicated QA-only account
// (qa@getivyos.com by default) - never a real user - and optionally forces
// that account's workspace into a known state so you can visually test the
// paywall, trial, active, and onboarding screens. Issues a normal session
// cookie and 302-redirects into the app, so it works as a one-click
// bookmark.
//
// States (`?state=`):
//   • onboarding (default for a fresh QA account) - resets onboarding +
//     walkthrough and drops the sub to incomplete, so you re-walk setup
//     from the top and hit the fresh new-user funnel.
//   • paywall  - onboarded, subscription incomplete → the hard paywall +
//     priming screens render immediately.
//   • trial    - trialing with 14 days left (the normal in-trial app).
//   • active   - paying subscriber, full access.
//
// SECURITY
//   • OFF by default. Without DEV_LOGIN_SECRET set (and >= 16 chars) the
//     endpoint returns 404 - invisible. A wrong token also returns 404, so
//     the route can't be probed for existence.
//   • Timing-safe token comparison.
//   • Only ever touches the dedicated QA account, resolved by a fixed
//     email - the `state` param cannot address any other workspace.
//   • The QA user is a plain owner (user_type='regular'), NOT an admin, so
//     even if the link leaked the blast radius is one throwaway account.
import crypto from 'node:crypto';
import { sql, warmupDb } from '../_lib/db.js';
import { hashPassword, signSession, setSessionCookie } from '../_lib/auth.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { evictWorkspaceGateCache } from '../_lib/workspaceGate.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../_lib/legal.js';
import { serverError } from '../_lib/json.js';

const QA_EMAIL = (process.env.QA_USER_EMAIL || 'qa@getivyos.com').toLowerCase();
const MIN_SECRET_LEN = 16;
const VALID_STATES = new Set(['onboarding', 'paywall', 'trial', 'active']);

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch; compare lengths first but
  // still run a constant-time compare against a same-length buffer so the
  // early return doesn't leak length via timing.
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Ensure the single QA user + its workspace exist. Idempotent: re-uses the
// row on every subsequent call. The password is a throwaway random hash -
// there is intentionally no password that logs into this account; the
// secret link is the only door.
async function ensureQaAccount() {
  const found = await sql`SELECT id FROM users WHERE email = ${QA_EMAIL} LIMIT 1`;
  let userId = found.rows[0]?.id;
  if (!userId) {
    const pw = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
    const ins = await sql`
      INSERT INTO users (email, password_hash, name, email_verified_at,
                         terms_version, terms_accepted_at,
                         privacy_version, privacy_accepted_at, user_type)
      VALUES (${QA_EMAIL}, ${pw}, 'QA Tester', NOW(),
              ${CURRENT_TERMS_VERSION}, NOW(),
              ${CURRENT_PRIVACY_VERSION}, NOW(), 'regular')
      RETURNING id`;
    userId = ins.rows[0].id;
  }
  const ws = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
  let workspaceId = ws.rows[0]?.id;
  if (!workspaceId) {
    const insW = await sql`INSERT INTO workspaces (owner_id, name) VALUES (${userId}, 'QA Workspace') RETURNING id`;
    workspaceId = insW.rows[0].id;
  }
  return { userId, workspaceId };
}

// Force the QA workspace (and a couple of user flags) into the requested
// preset. Every write is scoped to the QA ids resolved above.
async function applyState(workspaceId, userId, state) {
  switch (state) {
    case 'onboarding':
      // Fresh new-user: re-walk onboarding + walkthrough, sub inactive so
      // finishing onboarding lands on the real hard paywall.
      await sql`UPDATE workspaces SET
          subscription_status = 'incomplete', trial_ends_at = NULL,
          trial_started_at = NULL, converted_at = NULL,
          paywall_first_seen_at = NULL, subscription_period_end = NULL,
          onboarded_at = NULL
        WHERE id = ${workspaceId}`;
      await sql`UPDATE users SET onboarding_state = '{}'::jsonb,
          walkthrough_completed_at = NULL WHERE id = ${userId}`;
      break;
    case 'paywall':
      // Onboarding done, subscription incomplete → hard paywall now.
      await sql`UPDATE workspaces SET
          subscription_status = 'incomplete', trial_ends_at = NULL,
          trial_started_at = NULL, converted_at = NULL,
          subscription_period_end = NULL, onboarded_at = NOW()
        WHERE id = ${workspaceId}`;
      await sql`UPDATE users SET walkthrough_completed_at = NOW() WHERE id = ${userId}`;
      break;
    case 'trial':
      await sql`UPDATE workspaces SET
          subscription_status = 'trialing',
          trial_ends_at = NOW() + INTERVAL '14 days',
          trial_started_at = NOW(), converted_at = NULL,
          subscription_period_end = NULL, onboarded_at = NOW()
        WHERE id = ${workspaceId}`;
      await sql`UPDATE users SET walkthrough_completed_at = NOW() WHERE id = ${userId}`;
      break;
    case 'active':
      await sql`UPDATE workspaces SET
          subscription_status = 'active',
          subscription_period_end = NOW() + INTERVAL '30 days',
          converted_at = COALESCE(converted_at, NOW()),
          trial_ends_at = NULL, onboarded_at = NOW()
        WHERE id = ${workspaceId}`;
      await sql`UPDATE users SET walkthrough_completed_at = NOW() WHERE id = ${userId}`;
      break;
    default:
      return false;
  }
  // Drop the per-lambda positive cache so the next request sees the new
  // state immediately instead of a stale "active".
  evictWorkspaceGateCache(workspaceId);
  return true;
}

export default async function handler(req, res) {
  const secret = process.env.DEV_LOGIN_SECRET;
  // Disabled unless explicitly configured with a non-trivial secret.
  // 404 (not 403) keeps the endpoint invisible when off.
  if (!secret || secret.length < MIN_SECRET_LEN) {
    if (secret) console.warn('[dev-login] DEV_LOGIN_SECRET is too short (<16 chars); endpoint stays disabled.');
    return res.status(404).json({ error: 'Not found' });
  }
  const token = req.query?.token;
  if (!token || !timingSafeEqual(token, secret)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    await warmupDb();
    await ensureSchemaApplied();
    const { userId, workspaceId } = await ensureQaAccount();

    const state = typeof req.query?.state === 'string' ? req.query.state.toLowerCase() : '';
    if (state) {
      if (!VALID_STATES.has(state)) {
        return res.status(400).json({ error: `Unknown state '${state}'. Use one of: onboarding, paywall, trial, active.` });
      }
      await applyState(workspaceId, userId, state);
    }

    setSessionCookie(res, signSession(userId));

    // Land where the chosen state is visible. Onboarding goes straight to
    // the wizard (it sits outside RoleRouter); everything else to the app
    // root, where RoleRouter routes the owner to the dashboard.
    const dest = state === 'onboarding' ? '/onboarding' : '/';
    res.writeHead(302, { Location: dest });
    return res.end();
  } catch (err) {
    return serverError(res, err);
  }
}

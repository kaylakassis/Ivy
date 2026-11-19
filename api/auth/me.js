// GET /api/auth/me - returns the current user or 401.
import { sql } from '../_lib/db.js';
import { requireUser, readSession, isNativeClient } from '../_lib/auth.js';
import { emailIsSuperAdmin, ensureSuperAdminPromotion } from '../_lib/admin.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, hasAcceptedCurrentTerms, hasAcceptedCurrentPrivacy } from '../_lib/legal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

// Can this copy of the app show the current Privacy Policy? The iPhone app
// carries its own copy of the policy and its version. A build from before
// an update would show the old text and then fail to record acceptance of
// the new version (api/me/accept-terms.js only records the current one),
// leaving the person stuck behind the notice. So:
//   - a client that says which version it carries (?pv=) is asked only
//     when that is the current version;
//   - an iPhone app that says nothing is an older build: not asked. It
//     keeps working and asks once the app is updated;
//   - a browser that says nothing gets the notice as before (the website
//     always serves the current policy).
function clientCanShowCurrentPrivacy(req) {
  const pv = String(req.query?.pv || '').trim();
  if (pv) return pv === CURRENT_PRIVACY_VERSION;
  return !isNativeClient(req);
}

// Same question for the Terms, and stricter, because the Terms prompt is a
// wall, not a notice: only a copy of the app that says it carries the
// current Terms (?tv=) is asked. An older iPhone app, or a browser tab
// left open from before the update, would show the old text and then fail
// to record acceptance, locking the person out of their own account. They
// keep working and are asked the next time the app or page is fresh.
function clientCanShowCurrentTerms(req) {
  return String(req.query?.tv || '').trim() === CURRENT_TERMS_VERSION;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return; // requireUser already responded

    // Auto-promote known super-admin emails to user_type='super_admin'
    // in the DB so subsequent requireSuperAdmin checks can rely on the
    // column even if env-var routing drifts. Idempotent + best-effort.
    await ensureSuperAdminPromotion(user);

    // Surface impersonation state to the frontend so it can show a
    // "you're viewing as X - stop" banner and post to the stop endpoint.
    const session = readSession(req);
    let impersonating = null;
    if (session?.imp) {
      const ar = await sql`SELECT email FROM users WHERE id = ${session.imp}`;
      impersonating = {
        actorEmail: ar.rows[0]?.email || null,
        targetEmail: user.email,
      };
    }

    // Terms-staleness signal so the frontend can show a forced
    // re-accept modal. needsTermsAcceptance covers two cases:
    // (a) user predates the column entirely (terms_version is NULL),
    // (b) we bumped the version and they haven't re-accepted yet.
    const needsTermsAcceptance = !hasAcceptedCurrentTerms(user) && clientCanShowCurrentTerms(req);

    return ok(res, {
      // Surface isSuperAdmin from either path so the frontend knows
      // whether to render the Admin tab. Email-match OR db-column.
      user: { ...user, isSuperAdmin: emailIsSuperAdmin(user.email) || user.user_type === 'super_admin' },
      impersonating,
      terms: {
        currentVersion: CURRENT_TERMS_VERSION,
        acceptedVersion: user.terms_version || null,
        acceptedAt: user.terms_accepted_at || null,
        needsAcceptance: needsTermsAcceptance,
      },
      // Privacy Policy updates are shown as a notice the person
      // acknowledges (src/components/PrivacyUpdateNotice.jsx), not a gate.
      // Older iPhone builds ignore this field.
      privacy: {
        currentVersion: CURRENT_PRIVACY_VERSION,
        acceptedVersion: user.privacy_version || null,
        acceptedAt: user.privacy_accepted_at || null,
        needsAcknowledgement: !hasAcceptedCurrentPrivacy(user) && clientCanShowCurrentPrivacy(req),
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

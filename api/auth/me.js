// GET /api/auth/me - returns the current user or 401.
import { sql } from '../_lib/db.js';
import { requireUser, readSession } from '../_lib/auth.js';
import { emailIsSuperAdmin, ensureSuperAdminPromotion } from '../_lib/admin.js';
import { CURRENT_TERMS_VERSION, hasAcceptedCurrentTerms } from '../_lib/legal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

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
    const needsTermsAcceptance = !hasAcceptedCurrentTerms(user);

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
    });
  } catch (err) {
    return serverError(res, err);
  }
}

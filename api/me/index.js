// GET /api/me - returns the user-context object: which workspace they own
// (if any), which businesses they're a client of, and a "summary" snapshot
// the client home dashboard renders (counts of unread messages, upcoming
// bookings, pending invoices/docs).
import { sql } from '../_lib/db.js';
import { requireUser, isNativeClient } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { userContext, ids } from '../_lib/clientPortal.js';
import { missingRequiredAnswers } from '../_lib/onboardingAnswers.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { hasPendingCompInvite } from '../_lib/signupPerks.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const ctx = await userContext(user);

    // The RevenueCat webhook only applies Apple purchases to a workspace
    // its owner has identified from the iPhone app. Newer builds call
    // /api/billing/iap-identify; builds already in the App Store do not,
    // but every launch of the app calls this endpoint as the signed-in
    // owner with the native platform marker, which is the same proof.
    // Stamp once (IS NULL) so it costs one indexed no-op afterwards.
    if (isNativeClient(req) && ctx.owns?.id) {
      await sql`
        UPDATE workspaces SET revenuecat_user_id = ${ctx.owns.id}
         WHERE id = ${ctx.owns.id} AND owner_id = ${user.id} AND revenuecat_user_id IS NULL
      `.catch(() => { /* never block /me on the stamp */ });
    }

    // Required onboarding answers still missing for this owner (empty for
    // everyone else). The owner app shows a required "A few quick
    // questions" sheet while this is non-empty. Additive field: older app
    // builds ignore it. A lookup failure never blocks /me.
    const onboardingAnswersMissing = ctx.owns?.id
      ? await loadMissingAnswers(ctx.owns.id)
      : [];

    // An owner who has not confirmed their email yet, with a comp invite
    // waiting on that address: the paywall shows "Confirm your email to
    // unlock your free access" instead of the plans. Only ever checks the
    // signed-in user's own address. Additive field.
    const pendingCompInvite = ctx.owns?.id && !user.email_verified_at
      ? await hasPendingCompInvite(user)
      : false;

    if (!ctx.isClient) {
      // Owner-only - return context with empty summary.
      return ok(res, { ...ctx, onboardingAnswersMissing, pendingCompInvite, summary: emptySummary() });
    }

    const myIds = ids(ctx.memberships);
    // Use ARRAY[$1...] style via sql.query so we can pass an array param.
    const summary = await loadSummary(myIds);
    return ok(res, { ...ctx, onboardingAnswersMissing, pendingCompInvite, summary });
  } catch (err) {
    return serverError(res, err);
  }
}

async function loadMissingAnswers(workspaceId) {
  try {
    const { rows } = await sql`
      SELECT heard_from, heard_from_other, heard_from_ids, location_state, location_country,
             stage, stage_ids, goal, goal_other, goal_ids, challenge, challenge_other, challenge_ids
        FROM workspace_profile WHERE workspace_id = ${workspaceId}
    `;
    return missingRequiredAnswers(rows[0] || null);
  } catch {
    return [];
  }
}

function emptySummary() {
  return { unreadMessages: 0, upcomingBookings: 0, openInvoices: 0, pendingDocs: 0, pendingReviews: 0 };
}

async function loadSummary(clientIds) {
  if (!clientIds.length) return emptySummary();
  // Single round-trip with parallel sub-queries keeps page loads snappy.
  const [unread, upcoming, openInv, pending, pendingReviews] = await Promise.all([
    sql.query(
      `SELECT COALESCE(SUM(unread_client), 0)::int AS n
         FROM message_threads WHERE client_id = ANY($1)`,
      [clientIds],
    ),
    sql.query(
      // "Upcoming" is judged in each booking's OWN business timezone (a client
      // can belong to businesses in different zones), falling back to UTC.
      `SELECT COUNT(*)::int AS n FROM bookings b
         LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
         WHERE b.client_id = ANY($1) AND b.cancelled_at IS NULL
         AND b.date >= (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date`,
      [clientIds],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS n FROM invoices
         WHERE client_id = ANY($1) AND status IN ('sent','overdue')`,
      [clientIds],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS n FROM documents
         WHERE recipient_client_id = ANY($1) AND status = 'sent'`,
      [clientIds],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS n FROM bookings b
         LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
         WHERE b.client_id = ANY($1)
           AND b.cancelled_at IS NULL
           AND b.date >= (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date - INTERVAL '60 days'
           AND b.date <= (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date
           AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)`,
      [clientIds],
    ),
  ]);
  return {
    unreadMessages:   unread.rows[0]?.n   || 0,
    upcomingBookings: upcoming.rows[0]?.n || 0,
    openInvoices:     openInv.rows[0]?.n  || 0,
    pendingDocs:      pending.rows[0]?.n  || 0,
    pendingReviews:   pendingReviews.rows[0]?.n || 0,
  };
}

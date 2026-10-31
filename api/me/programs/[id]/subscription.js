// DELETE /api/me/programs/:id/subscription → cancel the client's own
// program subscription at the end of the current period (Stripe, on the
// coach's connected account). The webhook mirrors the final state; access
// continues until the paid period ends. cancel_at_period_end is stamped
// locally right away so the portal shows "Access until <date>" without
// waiting for the webhook.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { myClientIds, ids } from '../../../_lib/clientPortal.js';
import { loadStripeCreds } from '../../../_lib/stripeCreds.js';
import { cancelSubscription } from '../../../_lib/stripe.js';
import { isUuid } from '../../../_lib/programs.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const programId = String(req.query.id || '');
    if (!isUuid(programId)) return notFound(res, 'Program not found');
    const myIds = ids(await myClientIds(user));
    if (!myIds.length) return notFound(res, 'Program not found');
    const e = (await sql.query(
      `SELECT * FROM program_enrollments WHERE program_id = $1 AND client_id = ANY($2) AND status IN ('active','past_due') ORDER BY granted_at DESC LIMIT 1`,
      [programId, myIds])).rows[0];
    if (!e) return notFound(res, 'Program not found');
    if (!e.stripe_subscription_id) return badRequest(res, 'This program is not on a subscription.');
    if (e.cancel_at_period_end) return ok(res, { cancelled: true, atPeriodEnd: true, accessUntil: e.current_period_end, alreadyScheduled: true });
    const creds = await loadStripeCreds(e.workspace_id);
    await cancelSubscription({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, subscriptionId: e.stripe_subscription_id, atPeriodEnd: true });
    // Scoped to the client ids we just verified, so a regression above can
    // never be coerced into touching someone else's enrollment.
    await sql.query(
      `UPDATE program_enrollments SET cancel_at_period_end = TRUE, updated_at = NOW() WHERE id = $1 AND client_id = ANY($2)`,
      [e.id, myIds],
    );
    return ok(res, { cancelled: true, atPeriodEnd: true, accessUntil: e.current_period_end });
  } catch (err) { return serverError(res, err); }
}

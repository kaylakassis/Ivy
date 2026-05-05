// DELETE /api/me/memberships/:id
//
// Cancels the named subscription on Stripe (cancel_at_period_end =
// TRUE so the member keeps access until the period ends). The
// webhook then mirrors the cancel into client_memberships.status.
//
// :id is the client_memberships row id, not the Stripe subscription
// id. Strict ownership check via myClientIds before any Stripe call.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { cancelSubscription } from '../../_lib/stripe.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { id } = req.query;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'Membership not found');

    const r = await sql.query(
      `SELECT cm.* FROM client_memberships cm
        WHERE cm.id = $1 AND cm.client_id = ANY($2)
        LIMIT 1`,
      [id, myIds],
    );
    const cm = r.rows[0];
    if (!cm) return notFound(res, 'Membership not found');
    if (cm.status === 'cancelled') return badRequest(res, 'Already cancelled');
    if (!cm.stripe_subscription_id) return badRequest(res, 'No Stripe subscription on file');

    try {
      const creds = await loadStripeCreds(cm.workspace_id);
      await cancelSubscription({
        secretKey: creds.secretKey,
        subscriptionId: cm.stripe_subscription_id,
        atPeriodEnd: true,
      });
      // The customer.subscription.updated webhook will flip status to
      // cancelled when the period actually ends. Mark cancel_at_period_end
      // locally now so the UI can show "cancels on Mar 31" immediately.
      await sql`
        UPDATE client_memberships SET cancel_at_period_end = TRUE, updated_at = NOW()
         WHERE id = ${id}
      `;
      return ok(res, { cancelled: true, atPeriodEnd: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[me/memberships cancel] failed:', err.message);
      return serverError(res, err);
    }
  } catch (err) {
    return serverError(res, err);
  }
}

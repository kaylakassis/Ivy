// DELETE /api/me/payment-methods/:clientId
//
// Detaches the saved card on the user's clients row at the named
// workspace. clientId in the URL is the clients.id (per workspace),
// not the Stripe customer id - strict ownership check via
// myClientIds before any Stripe / DB write happens.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { detachPaymentMethod } from '../../_lib/stripe.js';
import { methodNotAllowed, noContent, notFound, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { clientId } = req.query;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (!myIds.includes(clientId)) return notFound(res, 'Card not found');

    const r = await sql`
      SELECT id, workspace_id, payment_method_id
        FROM clients WHERE id = ${clientId} LIMIT 1
    `;
    const c = r.rows[0];
    if (!c?.payment_method_id) return noContent(res); // already gone

    // Try to detach in Stripe first - best-effort. If the workspace
    // disconnected Stripe (or the PM was already removed there), we
    // still scrub the local row so the portal stops claiming there's
    // a card on file.
    try {
      const creds = await loadStripeCreds(c.workspace_id);
      await detachPaymentMethod({
        secretKey:       creds.secretKey,
        stripeAccount:   creds.stripeAccount,
        paymentMethodId: c.payment_method_id,
      });
    } catch {
      // ignore - we still want to scrub locally below
    }

    // Defense-in-depth: re-scope to id = ANY(myIds) so a future
    // regression in the lookup above can't blank another tenant's
    // saved card.
    await sql.query(
      `UPDATE clients SET
         payment_method_id = NULL,
         payment_method_brand = NULL,
         payment_method_last4 = NULL,
         payment_method_exp_month = NULL,
         payment_method_exp_year = NULL,
         updated_at = NOW()
        WHERE id = $1 AND id = ANY($2)`,
      [clientId, myIds],
    );
    return noContent(res);
  } catch (err) {
    return serverError(res, err);
  }
}

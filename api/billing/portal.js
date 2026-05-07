// POST /api/billing/portal
// Returns a Stripe Customer Portal URL where the owner can update their
// card, view invoices, or cancel. Requires an existing stripe_customer_id
// — only set after the first successful subscription checkout.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { createBillingPortalSession, platformStripeSecret } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const secretKey = platformStripeSecret();
    if (!secretKey) {
      return badRequest(res, 'Subscription billing is not configured yet.');
    }

    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT stripe_customer_id FROM workspaces WHERE id = ${workspaceId}
    `;
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
      return badRequest(res, 'No billing record yet — subscribe first to open the portal.');
    }

    const session = await createBillingPortalSession({
      secretKey, customerId,
      returnUrl: `${appUrl()}/account`,
    });
    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}

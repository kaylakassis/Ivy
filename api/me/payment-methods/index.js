// /api/me/payment-methods
//   GET → list saved cards across every business the user is a
//         client of (one card per (workspace, client) pair).
//   POST → start a "save a card" flow. Body: { workspaceId } —
//         must be a workspace the user has a clients-row in.
//         Mints a Stripe Checkout in setup mode and returns the
//         redirect URL. After completion the workspace's webhook
//         (checkout.session.completed with mode='setup') stores
//         the new payment_method on the client row.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { findOrCreateCustomer, createSetupCheckoutSession } from '../../_lib/stripe.js';
import { appUrl } from '../../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { cards: [] });

    if (req.method === 'GET') {
      // Surface saved cards across every workspace the user is a
      // client of. We never return Stripe ids — only display
      // fragments the portal can render.
      const r = await sql.query(
        `SELECT c.id AS client_id, c.workspace_id,
                c.payment_method_id, c.payment_method_brand,
                c.payment_method_last4, c.payment_method_exp_month,
                c.payment_method_exp_year,
                cs.biz_name
           FROM clients c
           LEFT JOIN calendar_settings cs ON cs.workspace_id = c.workspace_id
          WHERE c.id = ANY($1)
          ORDER BY cs.biz_name ASC NULLS LAST`,
        [myIds],
      );
      const cards = r.rows.map((row) => ({
        clientId:    row.client_id,
        businessName: row.biz_name || 'Business',
        hasCard:     !!row.payment_method_id,
        brand:       row.payment_method_brand || null,
        last4:       row.payment_method_last4 || null,
        expMonth:    row.payment_method_exp_month || null,
        expYear:     row.payment_method_exp_year || null,
      }));
      return ok(res, { cards });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      if (!clientId) return badRequest(res, 'clientId is required');
      if (!myIds.includes(clientId)) return badRequest(res, 'Unknown client');

      const r = await sql`
        SELECT id, workspace_id, name, email, stripe_customer_id
          FROM clients WHERE id = ${clientId} LIMIT 1
      `;
      const c = r.rows[0];
      if (!c?.email) return badRequest(res, 'No email on file — set one with the business first.');

      let creds;
      try { creds = await loadStripeCreds(c.workspace_id); }
      catch (e) {
        return badRequest(res, e.code === 'no_stripe_connection'
          ? "This business hasn't enabled card payments yet."
          : e.message);
      }

      // Reuse the workspace's existing Stripe customer for this
      // client if we have one, otherwise mint + persist.
      let customerId = c.stripe_customer_id;
      if (!customerId) {
        const cust = await findOrCreateCustomer({
          secretKey: creds.secretKey,
          email: c.email, name: c.name,
          workspaceId: c.workspace_id, clientId: c.id,
        });
        customerId = cust.id;
        // Defense-in-depth: pin the workspace_id on the UPDATE so a
        // future regression in the SELECT above can't link a Stripe
        // customer to another tenant's client row.
        await sql`
          UPDATE clients SET stripe_customer_id = ${customerId}, updated_at = NOW()
            WHERE id = ${c.id} AND workspace_id = ${c.workspace_id}
        `;
      }

      const base = appUrl();
      const session = await createSetupCheckoutSession({
        secretKey: creds.secretKey,
        customerId,
        workspaceId: c.workspace_id,
        clientId: c.id,
        successUrl: `${base}/me/billing?save=ok`,
        cancelUrl:  `${base}/me/billing?save=cancel`,
      });
      return ok(res, { url: session.url });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

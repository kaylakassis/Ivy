// /api/memberships
//   GET  → list every membership tier the workspace has defined
//          (active + inactive — owner sees all).
//   POST → create a new tier. If Stripe is connected, also provisions
//          a Stripe Product + recurring Price on the connected
//          account so the public sign-up flow can hand the price id
//          to a Checkout subscription session.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeMembership, cleanMembershipInput } from '../_lib/memberships.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { createMembershipProduct } from '../_lib/stripe.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const r = await sql`
        SELECT * FROM memberships
         WHERE workspace_id = ${workspaceId}
         ORDER BY active DESC, display_order ASC, created_at DESC
      `;
      return ok(res, { memberships: r.rows.map(serializeMembership) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const v = cleanMembershipInput(body);
      if (!v.ok) return badRequest(res, v.error);
      const m = v.sanitized;

      // Try to provision Stripe product + price up front. Owners who
      // haven't connected Stripe yet still get the row written so they
      // can connect later — the public sign-up button is gated on
      // stripe_price_id being non-null.
      let stripeProductId = null;
      let stripePriceId = null;
      let stripeError = null;
      try {
        const creds = await loadStripeCreds(workspaceId);
        const ids = await createMembershipProduct({
          secretKey: creds.secretKey,
          name: m.name,
          description: m.description,
          priceCents: m.priceCents,
          interval: m.interval,
          currency: creds.currency,
        });
        stripeProductId = ids.productId;
        stripePriceId = ids.priceId;
      } catch (err) {
        stripeError = err.code === 'no_stripe_connection'
          ? 'Connect Stripe to start collecting membership payments.'
          : err.message;
      }

      const ins = await sql`
        INSERT INTO memberships (
          workspace_id, name, description, price_cents, interval,
          stripe_product_id, stripe_price_id, perks, active, display_order
        ) VALUES (
          ${workspaceId}, ${m.name}, ${m.description}, ${m.priceCents}, ${m.interval},
          ${stripeProductId}, ${stripePriceId},
          ${JSON.stringify(m.perks)}::jsonb, ${m.active}, ${m.displayOrder}
        )
        RETURNING *
      `;
      return created(res, {
        membership: serializeMembership(ins.rows[0]),
        stripeError,
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

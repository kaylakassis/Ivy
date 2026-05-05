// POST /api/memberships/checkout   body: { membershipId, slug, name, email }
//
// Public, no-auth. Mints a Stripe Checkout subscription session for
// a membership tier on a given workspace's public booking page.
// Workspace is resolved by `slug` (NOT trusted from the membership
// row — same defense-in-depth pattern as /api/calendar/public/contact).
//
// On checkout success, the workspace's webhook (subscription mode)
// creates the client_memberships row + links to a Stripe customer.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { validEmail } from '../_lib/auth.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { findOrCreateCustomer, createMembershipCheckoutSession } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `mship:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const slug = (body.slug || '').toString().toLowerCase().trim();
    const membershipId = body.membershipId ? String(body.membershipId) : null;
    const buyerName = (body.name || '').toString().trim().slice(0, 200);
    const buyerEmail = (body.email || '').toString().trim().toLowerCase().slice(0, 200);
    if (!slug) return badRequest(res, 'slug is required');
    if (!membershipId) return badRequest(res, 'membershipId is required');
    if (!buyerName) return badRequest(res, 'Please share your name.');
    if (!validEmail(buyerEmail)) return badRequest(res, 'A valid email is required.');

    // Resolve workspace by slug.
    const cs = await sql`SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}`;
    if (cs.rows.length === 0) return notFound(res, 'No business with that handle');
    const workspaceId = cs.rows[0].workspace_id;

    // Fetch + verify the membership belongs to this workspace AND
    // has a Stripe price provisioned. The public flow can't fall
    // back to "create a price now" — that would let a hostile caller
    // mint Stripe products on someone else's account.
    const m = await sql`
      SELECT id, name, stripe_price_id, active
        FROM memberships
       WHERE id = ${membershipId} AND workspace_id = ${workspaceId}
    `;
    const tier = m.rows[0];
    if (!tier) return notFound(res, 'Membership not found');
    if (!tier.active) return badRequest(res, 'This membership is no longer accepting new members.');
    if (!tier.stripe_price_id) return badRequest(res, "This business hasn't finished connecting payments yet.");

    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (e) {
      return badRequest(res, e.code === 'no_stripe_connection'
        ? "This business hasn't enabled card payments yet."
        : e.message);
    }

    // Find-or-create a clients-row + Stripe customer for the buyer
    // BEFORE we mint Checkout, so the webhook can stitch the
    // resulting subscription back to a known client_id.
    let clientId = null;
    let stripeCustomerId = null;
    const existing = await sql`
      SELECT id, stripe_customer_id FROM clients
       WHERE workspace_id = ${workspaceId} AND email = ${buyerEmail}
       LIMIT 1
    `;
    if (existing.rows.length > 0) {
      clientId = existing.rows[0].id;
      stripeCustomerId = existing.rows[0].stripe_customer_id;
    } else {
      const ins = await sql`
        INSERT INTO clients (workspace_id, name, email, stage, source)
        VALUES (${workspaceId}, ${buyerName}, ${buyerEmail}, 'lead', 'membership')
        RETURNING id
      `;
      clientId = ins.rows[0].id;
    }
    if (!stripeCustomerId) {
      const cust = await findOrCreateCustomer({
        secretKey: creds.secretKey,
        email: buyerEmail, name: buyerName,
        workspaceId, clientId,
      });
      stripeCustomerId = cust.id;
      await sql`UPDATE clients SET stripe_customer_id = ${stripeCustomerId} WHERE id = ${clientId}`;
    }

    const base = appUrl();
    const session = await createMembershipCheckoutSession({
      secretKey: creds.secretKey,
      priceId: tier.stripe_price_id,
      customerId: stripeCustomerId,
      workspaceId,
      membershipId: tier.id,
      clientId,
      successUrl: `${base}/book/${encodeURIComponent(slug)}?membership=joined`,
      cancelUrl:  `${base}/book/${encodeURIComponent(slug)}?membership=cancel`,
    });
    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}

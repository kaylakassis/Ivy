// POST /api/memberships/checkout   body: { membershipId, slug, name, email }
//
// Public, no-auth. Mints a Stripe Checkout subscription session for
// a membership tier on a given workspace's public booking page.
// Workspace is resolved by `slug` (NOT trusted from the membership
// row - same defense-in-depth pattern as /api/calendar/public/contact).
//
// On checkout success, the workspace's webhook (subscription mode)
// creates the client_memberships row for metadata.client_id.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { validEmail } from '../_lib/auth.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { createMembershipCheckoutSession } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { loadWorkspaceAccess, archivedForbidden } from '../_lib/businessAccess.js';
import { answeredLimitRefusal } from '../_lib/newBusinessLimits.js';

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
    if (!(await loadWorkspaceAccess(workspaceId)).active) return archivedForbidden(res);

    // Fetch + verify the membership belongs to this workspace AND
    // has a Stripe price provisioned. The public flow can't fall
    // back to "create a price now" - that would let a hostile caller
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

    // Memberships are recurring subscriptions - Stripe-only by design
    // (Square/PayPal hosted checkout here is one-time). Say so plainly.
    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (e) {
      return badRequest(res, e.code === 'no_stripe_connection'
        ? 'Memberships require Stripe. Connect Stripe in Money to offer recurring plans.'
        : e.message);
    }

    // Find-or-create a clients row for the buyer BEFORE we mint Checkout,
    // so the webhook can stitch the resulting subscription back to a
    // known client_id (carried in metadata).
    let clientId = null;
    // Case-insensitive: a client the owner typed in as Jane@Example.com must
    // not become a second client row here.
    const existing = await sql`
      SELECT id FROM clients
       WHERE workspace_id = ${workspaceId} AND LOWER(email) = ${buyerEmail}
       LIMIT 1
    `;
    if (existing.rows.length > 0) {
      clientId = existing.rows[0].id;
    } else {
      const ins = await sql`
        INSERT INTO clients (workspace_id, name, email, stage, source)
        VALUES (${workspaceId}, ${buyerName}, ${buyerEmail}, 'lead', 'membership')
        RETURNING id
      `;
      clientId = ins.rows[0].id;
    }

    // SECURITY: nobody has signed in here; the email is only what the
    // visitor typed. The session must NEVER carry an existing Stripe
    // customer: Checkout would show that customer's saved card, name and
    // billing address to whoever opened the link, and let them pay with
    // it. So the session gets the typed email only and Stripe makes a
    // fresh customer for the subscription. The client's own customer
    // (clients.stripe_customer_id, the one autopay charges) is neither
    // read nor changed here; the webhook links by metadata.client_id.
    const base = appUrl();
    const session = await createMembershipCheckoutSession({
      secretKey: creds.secretKey,

      stripeAccount: creds.stripeAccount,
      priceId: tier.stripe_price_id,
      amountCents: Number(tier.price_cents) || null,
      customerEmail: buyerEmail,
      workspaceId,
      membershipId: tier.id,
      clientId,
      successUrl: `${base}/book/${encodeURIComponent(slug)}?membership=joined`,
      cancelUrl:  `${base}/book/${encodeURIComponent(slug)}?membership=cancel`,
    });
    return ok(res, { url: session.url });
  } catch (err) {
    if (answeredLimitRefusal(res, err)) return undefined;
    return serverError(res, err);
  }
}

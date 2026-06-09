// POST /api/packages/checkout   body: { packageId, slug, name, email }
//
// Public, no-auth. Mints a Stripe Checkout session for a one-time package
// purchase on a given workspace's public booking page. The workspace is
// resolved by `slug` (NOT trusted from the package row — same defense-in-
// depth pattern as /api/calendar/public/contact + /api/memberships/checkout).
//
// On checkout success, the workspace's webhook handler
// (api/webhooks/stripe-platform.js) reads metadata.purpose='package' and
// provisions a client_packages row with credits_remaining = session_count.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { validEmail } from '../_lib/auth.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { stripeFetch, findOrCreateCustomer } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { fetchFinanceSettings } from '../_lib/finance.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `pkg:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const slug = (body.slug || '').toString().toLowerCase().trim();
    const packageId = body.packageId ? String(body.packageId) : null;
    const buyerName = (body.name || '').toString().trim().slice(0, 200);
    const buyerEmail = (body.email || '').toString().trim().toLowerCase().slice(0, 200);
    if (!slug) return badRequest(res, 'slug is required');
    if (!packageId) return badRequest(res, 'packageId is required');
    if (!buyerName) return badRequest(res, 'Please share your name.');
    if (!validEmail(buyerEmail)) return badRequest(res, 'A valid email is required.');

    // Resolve workspace by slug.
    const cs = await sql`SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}`;
    if (cs.rows.length === 0) return notFound(res, 'No business with that handle');
    const workspaceId = cs.rows[0].workspace_id;

    // Fetch + verify the package belongs to this workspace AND is
    // currently buyable (active + visibility='public'). Anything else
    // is an owner-managed flow.
    const pkg = await sql`
      SELECT id, name, description, service_ids, session_count, price, expiry_days, active, visibility
        FROM packages
       WHERE id = ${packageId} AND workspace_id = ${workspaceId}
    `;
    const p = pkg.rows[0];
    if (!p) return notFound(res, 'Package not found');
    if (!p.active) return badRequest(res, 'This package is no longer being sold.');
    if (p.visibility !== 'public') return badRequest(res, 'This package is not available for self-checkout.');
    if (Number(p.price || 0) <= 0) {
      return badRequest(res, "This package isn't priced yet — contact the business.");
    }

    // Stripe is required (one-time payment via the connected account).
    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (e) {
      return badRequest(res, e.code === 'no_stripe_connection'
        ? 'Packages require Stripe. Ask the business to connect Stripe in Finance.'
        : e.message);
    }

    // Find-or-create a clients row + Stripe customer for the buyer
    // BEFORE we mint Checkout, so the webhook can provision the
    // client_packages row against a known client_id without having to
    // re-query by email (which races with concurrent purchases).
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
        VALUES (${workspaceId}, ${buyerName}, ${buyerEmail}, 'lead', 'package')
        RETURNING id
      `;
      clientId = ins.rows[0].id;
    }
    if (!stripeCustomerId) {
      const cust = await findOrCreateCustomer({
        secretKey: creds.secretKey,
        stripeAccount: creds.stripeAccount,
        email: buyerEmail, name: buyerName,
        workspaceId, clientId,
      });
      stripeCustomerId = cust.id;
      // Defense-in-depth: scope the UPDATE to workspace_id so the public
      // checkout flow can never link a Stripe customer to a clients row
      // outside its own workspace.
      await sql`
        UPDATE clients SET stripe_customer_id = ${stripeCustomerId}
         WHERE id = ${clientId} AND workspace_id = ${workspaceId}
      `;
    }

    // Workspace currency. Defaults to USD when finance_settings is
    // missing (same as the invoice helpers).
    const fin = await fetchFinanceSettings(workspaceId).catch(() => null);
    const currency = (fin?.currency || 'USD').toLowerCase();
    const unitAmount = Math.round(Number(p.price) * 100);

    const base = appUrl();
    const session = await stripeFetch('/checkout/sessions', {
      method: 'POST',
      secretKey: creds.secretKey,
      stripeAccount: creds.stripeAccount,
      body: {
        mode: 'payment',
        success_url: `${base}/book/${encodeURIComponent(slug)}?package=purchased`,
        cancel_url:  `${base}/book/${encodeURIComponent(slug)}?package=cancel`,
        customer: stripeCustomerId,
        'line_items[0][price_data][currency]': currency,
        'line_items[0][price_data][unit_amount]': unitAmount,
        'line_items[0][price_data][product_data][name]': p.name,
        'line_items[0][quantity]': 1,
        'metadata[workspace_id]': workspaceId,
        'metadata[package_id]': p.id,
        'metadata[client_id]': clientId,
        'metadata[purpose]': 'package',
        'payment_intent_data[metadata][workspace_id]': workspaceId,
        'payment_intent_data[metadata][package_id]': p.id,
        'payment_intent_data[metadata][client_id]': clientId,
        'payment_intent_data[metadata][purpose]': 'package',
      },
    });
    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}

// POST /api/programs/checkout
//   body: { programId, name, email, couponCode?, cohortId?, addOn? }
//
// Public. Mints a Stripe Checkout session on the coach's connected account:
// mode 'payment' for one-time programs, 'subscription' (inline recurring
// price) for monthly / yearly ones. Access is granted by the platform
// webhook (metadata.purpose='program'), never by the redirect.
//
// Extras, all decided HERE (never trusted from the page):
//   couponCode  re-checked (findValidCoupon) and passed as discounts[0][coupon]
//   trial       subscription_data[trial_period_days] when the program has
//               trial days and this email has never had a trial (or been a
//               member) of it; otherwise full price and trialUsed: true
//   cohortId    cohort programs: the picked cohort if still open, else the next
//   addOn       one-time programs with an optional add-on package: a second
//               line item; an "included" package rides in metadata only
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { validEmail } from '../_lib/auth.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { stripeFetch, findOrCreateCustomer } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { fetchFinanceSettings } from '../_lib/finance.js';
import { isUuid } from '../_lib/programs.js';
import { findValidCoupon, ensureStripeCoupon, trialEligible, pickCohort, bundleFor, INVALID_CODE } from '../_lib/programCommerce.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { loadWorkspaceAccess, archivedForbidden } from '../_lib/businessAccess.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `program:co:${ip}`, max: 10, windowSeconds: 60 * 60 }])) return;
    const body = await readBody(req);
    const programId = String(body.programId || '');
    const buyerName = String(body.name || '').trim().slice(0, 200);
    const buyerEmail = String(body.email || '').trim().toLowerCase().slice(0, 200);
    if (!programId) return badRequest(res, 'programId is required');
    if (!isUuid(programId)) return notFound(res, 'This program is not available.');
    if (!buyerName) return badRequest(res, 'Please share your name.');
    if (!validEmail(buyerEmail)) return badRequest(res, 'A valid email is required.');

    const p = (await sql`SELECT * FROM programs WHERE id = ${programId} AND status = 'published'`).rows[0];
    if (!p) return notFound(res, 'This program is not available.');
    if (Number(p.price_cents) <= 0) return badRequest(res, 'This program is free - ask the coach to add you.');
    const workspaceId = p.workspace_id;
    if (!(await loadWorkspaceAccess(workspaceId)).active) return archivedForbidden(res);

    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (e) { return badRequest(res, e.code === 'no_stripe_connection' ? 'This coach has not connected payments yet.' : e.message); }

    const fin = await fetchFinanceSettings(workspaceId).catch(() => null);
    const currency = (fin?.currency || 'USD').toLowerCase();

    // Checked before anything is created on the payment account.
    let cohort = null;
    if (p.delivery === 'cohort') {
      const picked = await pickCohort(p, body.cohortId && isUuid(String(body.cohortId)) ? String(body.cohortId) : null);
      if (picked.error) return badRequest(res, picked.error);
      cohort = picked.cohort;
    }
    let coupon = null;
    if (body.couponCode) {
      coupon = await findValidCoupon({ program: p, code: body.couponCode, currency });
      if (!coupon) return badRequest(res, INVALID_CODE);
    }
    const bundle = await bundleFor(p);
    const addOn = bundle?.mode === 'addon' && body.addOn === true ? bundle : null;

    let clientId = null; let stripeCustomerId = null;
    const existing = (await sql`SELECT id, stripe_customer_id FROM clients WHERE workspace_id = ${workspaceId} AND LOWER(email) = ${buyerEmail} LIMIT 1`).rows[0];
    if (existing) { clientId = existing.id; stripeCustomerId = existing.stripe_customer_id; }
    else {
      clientId = (await sql`INSERT INTO clients (workspace_id, name, email, stage, source) VALUES (${workspaceId}, ${buyerName}, ${buyerEmail}, 'lead', 'program') RETURNING id`).rows[0].id;
    }
    if (!stripeCustomerId) {
      const cust = await findOrCreateCustomer({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, email: buyerEmail, name: buyerName, workspaceId, clientId });
      stripeCustomerId = cust.id;
      await sql`UPDATE clients SET stripe_customer_id = ${stripeCustomerId} WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
    }

    const base = appUrl();
    const recurring = p.billing !== 'one_time';
    const wantsTrial = recurring && !!p.trial_days;
    const trial = wantsTrial && await trialEligible({ program: p, email: buyerEmail, clientId: existing?.id || null });
    const bodyParams = {
      mode: recurring ? 'subscription' : 'payment',
      success_url: `${base}/p/${p.id}?purchased=1`,
      cancel_url: `${base}/p/${p.id}?cancelled=1`,
      customer: stripeCustomerId,
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': Number(p.price_cents),
      'line_items[0][price_data][product_data][name]': p.title,
      'line_items[0][quantity]': 1,
      'metadata[workspace_id]': workspaceId,
      'metadata[program_id]': p.id,
      'metadata[client_id]': clientId,
      'metadata[purpose]': 'program',
    };
    if (cohort) bodyParams['metadata[cohort_id]'] = cohort.id;
    if (coupon) {
      bodyParams['discounts[0][coupon]'] = await ensureStripeCoupon({ coupon, creds });
      bodyParams['metadata[coupon_id]'] = coupon.id;
    }
    if (recurring) {
      bodyParams['line_items[0][price_data][recurring][interval]'] = p.billing;
      bodyParams['subscription_data[metadata][workspace_id]'] = workspaceId;
      bodyParams['subscription_data[metadata][program_id]'] = p.id;
      bodyParams['subscription_data[metadata][client_id]'] = clientId;
      bodyParams['subscription_data[metadata][purpose]'] = 'program';
      if (cohort) bodyParams['subscription_data[metadata][cohort_id]'] = cohort.id;
      if (coupon) bodyParams['subscription_data[metadata][coupon_id]'] = coupon.id;
      if (trial) {
        bodyParams['subscription_data[trial_period_days]'] = Number(p.trial_days);
        // No card on file when the trial ends: the subscription is
        // cancelled, which closes access through the subscription webhook.
        bodyParams['subscription_data[trial_settings][end_behavior][missing_payment_method]'] = 'cancel';
        bodyParams['subscription_data[metadata][trial]'] = '1';
      }
    } else {
      if (bundle) {
        bodyParams['metadata[bundle_package_id]'] = bundle.pkg.id;
        bodyParams['metadata[bundle_mode]'] = bundle.mode;
      }
      if (addOn) {
        bodyParams['line_items[1][price_data][currency]'] = currency;
        bodyParams['line_items[1][price_data][unit_amount]'] = Math.round(Number(addOn.pkg.price || 0) * 100);
        bodyParams['line_items[1][price_data][product_data][name]'] = `${addOn.pkg.name} (add-on)`;
        bodyParams['line_items[1][quantity]'] = 1;
        bodyParams['metadata[addon]'] = '1';
      }
      bodyParams['payment_intent_data[metadata][workspace_id]'] = workspaceId;
      bodyParams['payment_intent_data[metadata][program_id]'] = p.id;
      bodyParams['payment_intent_data[metadata][client_id]'] = clientId;
      bodyParams['payment_intent_data[metadata][purpose]'] = 'program';
    }
    const session = await stripeFetch('/checkout/sessions', { method: 'POST', secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, body: bodyParams });
    return ok(res, {
      url: session.url,
      trialApplied: !!trial, trialUsed: wantsTrial && !trial, trialDays: trial ? Number(p.trial_days) : null,
      couponApplied: !!coupon, addOn: !!addOn, cohortId: cohort?.id || null,
    });
  } catch (err) { return serverError(res, err); }
}

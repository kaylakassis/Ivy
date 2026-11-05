// POST /api/billing/iap-identify
//
// The iOS app calls this right after the RevenueCat SDK's logIn so the
// server knows the owner really did identify THIS workspace as their
// RevenueCat customer (appUserID == workspace id). The RevenueCat webhook
// (api/billing/revenuecat-webhook.js) only applies an event whose
// app_user_id matches a workspace stamped here (or whose Apple original
// transaction id we already know), so an event for a guessed workspace id
// cannot flip somebody else's subscription.
//
// Owner-only: helper accounts own no workspace and get the usual 403.
// Idempotent: re-stamping the same id is a no-op.
//
// Web payers are refused (409, code 'billed_on_web'): every in-app
// purchase, promo-code redemption and restore runs this call first and
// stops when it fails, so an owner already paying through Stripe cannot
// be sold a second, Apple, subscription. App Store builds that predate
// this call never make it (they are bound through /api/me), so for them
// the RevenueCat webhook's double-billing check is the guard.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { loadBillingRow, stripePlanRunning } from '../_lib/billingGuard.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export const BILLED_ON_WEB_MESSAGE = 'Your Ivy plan is paid on the web, so there is nothing to buy in the app. To change or cancel it, open Ivy in a web browser and go to Account, then Manage subscription.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (stripePlanRunning(await loadBillingRow(workspaceId))) {
      return res.status(409).json({ error: BILLED_ON_WEB_MESSAGE, code: 'billed_on_web', provider: 'stripe' });
    }
    await sql`
      UPDATE workspaces
         SET revenuecat_user_id = ${workspaceId}
       WHERE id = ${workspaceId} AND owner_id = ${user.id}
    `;
    return ok(res, { appUserId: workspaceId });
  } catch (err) {
    return serverError(res, err, req);
  }
}

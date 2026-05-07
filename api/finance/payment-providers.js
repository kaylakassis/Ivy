// GET  /api/finance/payment-providers
//   Returns the workspace's current provider choice + the connection
//   status of every supported provider (Stripe / Square / PayPal).
//   The PaymentProviderCard renders from this single round-trip.
//
// PATCH /api/finance/payment-providers  body { paymentProvider }
//   Switches the active provider. Owners must have already connected
//   the target provider — the endpoint refuses to switch to one that
//   isn't connected so we never end up routing checkouts at a dead
//   adapter.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchFinanceSettings } from '../_lib/finance.js';
import * as stripe from '../_lib/payments/stripe.js';
import * as square from '../_lib/payments/square.js';
import * as paypal from '../_lib/payments/paypal.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID = new Set(['stripe', 'square', 'paypal']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const settings = await fetchFinanceSettings(workspaceId);
      const [stripeConn, squareConn, paypalConn] = await Promise.all([
        stripe.isConnected({ workspaceId, settings }),
        square.isConnected({ workspaceId, settings }),
        paypal.isConnected({ workspaceId, settings }),
      ]);
      const [stripeInfo, squareInfo, paypalInfo] = await Promise.all([
        stripe.getDisplayInfo({ workspaceId, settings }),
        square.getDisplayInfo({ workspaceId, settings }),
        paypal.getDisplayInfo({ workspaceId, settings }),
      ]);
      return ok(res, {
        active: settings?.paymentProvider || 'stripe',
        providers: {
          stripe: { connected: stripeConn, ...(stripeInfo || {}) },
          square: { connected: squareConn, ...(squareInfo || {}) },
          paypal: { connected: paypalConn, ...(paypalInfo || {}) },
        },
        platform: {
          stripeReady: !!process.env.STRIPE_CONNECT_CLIENT_ID,
          squareReady: !!(process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_APPLICATION_SECRET),
          paypalReady: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_PARTNER_ID),
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const target = (body.paymentProvider || '').toString();
      if (!VALID.has(target)) return badRequest(res, 'Unknown payment provider');

      // Refuse the switch if the target isn't connected — otherwise the
      // next checkout hits a 500 instead of a clear "connect first" cue.
      const settings = await fetchFinanceSettings(workspaceId);
      const adapter = target === 'stripe' ? stripe
                    : target === 'square' ? square
                    : paypal;
      const connected = await adapter.isConnected({ workspaceId, settings });
      if (!connected) return badRequest(res, `Connect ${target} first before making it the active provider.`);

      await sql`
        INSERT INTO finance_settings (workspace_id, payment_provider)
        VALUES (${workspaceId}, ${target})
        ON CONFLICT (workspace_id) DO UPDATE SET payment_provider = EXCLUDED.payment_provider
      `;
      return ok(res, { active: target });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

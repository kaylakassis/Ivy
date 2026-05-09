// POST /api/calendar/bookings/charge-fee
//   body: { id, kind: 'late_cancel' | 'no_show', amount?: number }
//
// Manual fee charge. Used when the cron / cancel flow couldn't
// auto-charge (no card on file at the time, or the policy was
// added after the fact) and the owner is now charging out of band.
// Defaults amount to the service's policy amount; owner can override
// (e.g. partial waiver).
import { sql } from '../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { chargeOffSession } from '../../_lib/stripe.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    const kind = (body.kind || '').toString();
    if (!id) return badRequest(res, 'id is required');
    if (!['late_cancel', 'no_show'].includes(kind)) {
      return badRequest(res, 'kind must be late_cancel or no_show');
    }

    const r = await sql`
      SELECT b.*,
             c.stripe_customer_id, c.payment_method_id,
             s.name AS service_name,
             s.cancellation_fee_amount, s.no_show_fee_amount
        FROM bookings b
        LEFT JOIN clients c  ON c.id = b.client_id
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.id = ${id} AND b.workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const b = r.rows[0];
    if (!b) return badRequest(res, 'Booking not found');
    if (b.fee_charged_amount > 0) return badRequest(res, 'A fee was already charged for this booking');
    if (!b.stripe_customer_id || !b.payment_method_id) {
      return badRequest(res, 'No card on file for this client — ask them to add one in their portal first.');
    }

    const policyFee = kind === 'late_cancel'
      ? Number(b.cancellation_fee_amount || 0)
      : Number(b.no_show_fee_amount || 0);
    const amount = body.amount != null ? Number(body.amount) : policyFee;
    if (!Number.isFinite(amount) || amount <= 0) {
      return badRequest(res, 'amount must be a positive number');
    }
    if (amount > 1_000_000) return badRequest(res, 'amount too large');

    const creds = await loadStripeCreds(workspaceId);
    const pi = await chargeOffSession({
      secretKey: creds.secretKey,

      stripeAccount: creds.stripeAccount,
      customerId: b.stripe_customer_id,
      paymentMethodId: b.payment_method_id,
      amountCents: Math.round(amount * 100),
      currency: creds.currency,
      description: `${kind === 'late_cancel' ? 'Late-cancel' : 'No-show'} fee — ${b.service_name || 'session'}`,
      metadata: { booking_id: b.id, workspace_id: workspaceId, kind },
      statementDescriptor: kind === 'late_cancel' ? 'LATE CANCEL FEE' : 'NO-SHOW FEE',
    });

    const upd = await sql`
      UPDATE bookings SET
        fee_charged_amount = ${amount},
        fee_charged_at     = NOW(),
        fee_charged_kind   = ${kind},
        fee_payment_intent = ${pi.id},
        updated_at         = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    return ok(res, {
      booking: serializeBooking(upd.rows[0]),
      charged: true,
      chargeAmount: amount,
    });
  } catch (err) {
    // Stripe 402 (e.g. card declined / requires authentication) ends up here.
    // eslint-disable-next-line no-console
    console.error('[bookings/charge-fee] failed:', err.message);
    return serverError(res, err);
  }
}

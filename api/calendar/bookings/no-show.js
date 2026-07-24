// POST /api/calendar/bookings/no-show   body: { id, chargeFee?: boolean }
// DELETE /api/calendar/bookings/no-show body: { id }   → undo the mark
//
// Owner-only. Marks a booking as a no-show and (optionally) auto-
// charges the service's no-show fee against the client's saved card.
//
// chargeFee defaults to TRUE when the service has a non-zero fee +
// the client has a card on file. The owner can pass FALSE to mark
// the no-show without charging (e.g. they're letting it slide).
//
// DELETE clears no_show_at but deliberately KEEPS fee_charged_* -
// if a fee was actually charged, undoing the flag must not erase the
// record of real money moving (refunds happen in Stripe, not here).
//
// Lives as a static sibling to /api/calendar/bookings/[id].js so
// Vercel routes /no-show here, /[id] to the dynamic handler.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { chargeOffSession } from '../../_lib/stripe.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return methodNotAllowed(res, ['POST', 'DELETE']);
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    if (req.method === 'DELETE') {
      // Undo a stray no-show click. Fee columns stay untouched (see header).
      const undone = await sql`
        UPDATE bookings SET no_show_at = NULL, updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId}
          AND no_show_at IS NOT NULL
        RETURNING *
      `;
      if (undone.rows.length === 0) {
        return badRequest(res, 'Booking not found or not marked as a no-show');
      }
      return ok(res, { booking: serializeBooking(undone.rows[0]), undone: true });
    }

    // Owner-side ownership check + pull the bits we need to charge.
    const r = await sql`
      SELECT b.*,
             c.stripe_customer_id, c.payment_method_id, c.email AS client_email,
             s.name AS service_name, s.no_show_fee_amount
        FROM bookings b
        LEFT JOIN clients c  ON c.id = b.client_id
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.id = ${id} AND b.workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const b = r.rows[0];
    if (!b) return badRequest(res, 'Booking not found');
    if (b.cancelled_at) return badRequest(res, "Can't mark a cancelled booking as a no-show");
    if (b.no_show_at)   return badRequest(res, 'Already marked as a no-show');

    const wantCharge = body.chargeFee !== false;
    const feeAmount = Number(b.no_show_fee_amount || 0);
    const chargeFee = wantCharge && feeAmount > 0
      && b.stripe_customer_id && b.payment_method_id;

    let paymentIntentId = null;
    let chargeError = null;
    if (chargeFee) {
      try {
        const creds = await loadStripeCreds(workspaceId);
        const pi = await chargeOffSession({
          secretKey: creds.secretKey,

          stripeAccount: creds.stripeAccount,
          customerId: b.stripe_customer_id,
          paymentMethodId: b.payment_method_id,
          amountCents: Math.round(feeAmount * 100),
          currency: creds.currency,
          description: `No-show fee - ${b.service_name || 'session'}`,
          metadata: { booking_id: b.id, workspace_id: workspaceId, kind: 'no_show' },
          statementDescriptor: 'NO-SHOW FEE',
          // Shares the `fee-<booking>` key with charge-fee.js so a booking
          // can be fee-charged at most once across both endpoints, even on
          // retry / crash-after-charge.
          idempotencyKey: `fee-${b.id}`,
        });
        paymentIntentId = pi.id;
      } catch (err) {
        // The no-show mark still goes through even if the charge
        // fails - owner can chase manually. Surface the error in
        // the response so the UI can show a warning.
        chargeError = err.message || 'Charge failed';
      }
    }

    const upd = await sql`
      UPDATE bookings SET
        no_show_at         = NOW(),
        fee_charged_amount = CASE WHEN ${!!paymentIntentId} THEN ${feeAmount} ELSE fee_charged_amount END,
        fee_charged_at     = CASE WHEN ${!!paymentIntentId} THEN NOW() ELSE fee_charged_at END,
        fee_charged_kind   = CASE WHEN ${!!paymentIntentId} THEN 'no_show' ELSE fee_charged_kind END,
        fee_payment_intent = CASE WHEN ${!!paymentIntentId} THEN ${paymentIntentId} ELSE fee_payment_intent END,
        updated_at         = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    return ok(res, {
      booking: serializeBooking(upd.rows[0]),
      charged: !!paymentIntentId,
      chargeAmount: paymentIntentId ? feeAmount : 0,
      chargeError,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

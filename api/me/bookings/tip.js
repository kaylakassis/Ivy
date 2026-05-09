// POST /api/me/bookings/tip   body: { bookingId, amount }
//
// Client-portal companion to the owner-side tip endpoint. Lets a
// client tip a past session against their saved card without owner
// involvement. Same constraints: must be a booking they own, must
// have a card on file, can't double-tip.
//
// Sibling-static so /api/me/bookings/tip routes here while
// /api/me/bookings/[id] handles cancel + reschedule on the dynamic
// handler.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { chargeOffSession } from '../../_lib/stripe.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return badRequest(res, 'No bookings on file');

    const body = await readBody(req);
    const bookingId = body.bookingId ? String(body.bookingId) : null;
    const amount = Number(body.amount);
    if (!bookingId) return badRequest(res, 'bookingId is required');
    if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, 'amount must be positive');
    if (amount > 1_000_000) return badRequest(res, 'amount too large');

    const r = await sql.query(
      `SELECT b.*, c.stripe_customer_id, c.payment_method_id, s.name AS service_name
         FROM bookings b
         LEFT JOIN clients c  ON c.id = b.client_id
         LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
        WHERE b.id = $1 AND b.client_id = ANY($2)
        LIMIT 1`,
      [bookingId, myIds],
    );
    const b = r.rows[0];
    if (!b) return badRequest(res, 'Booking not found');
    if (Number(b.tip_amount) > 0) return badRequest(res, 'A tip has already been recorded');
    if (!b.stripe_customer_id || !b.payment_method_id) {
      return badRequest(res, 'No card on file — add one in /me/billing first.');
    }

    const creds = await loadStripeCreds(b.workspace_id);
    const pi = await chargeOffSession({
      secretKey: creds.secretKey,

      stripeAccount: creds.stripeAccount,
      customerId: b.stripe_customer_id,
      paymentMethodId: b.payment_method_id,
      amountCents: Math.round(amount * 100),
      currency: creds.currency,
      description: `Tip — ${b.service_name || 'session'}`,
      metadata: { booking_id: b.id, workspace_id: b.workspace_id, kind: 'tip', source: 'client_portal' },
      statementDescriptor: 'TIP',
    });
    await sql`
      UPDATE bookings SET
        tip_amount         = ${amount},
        tip_charged_at     = NOW(),
        tip_payment_intent = ${pi.id},
        updated_at         = NOW()
      WHERE id = ${bookingId} AND client_id = ANY(${myIds})
    `;
    return ok(res, { ok: true, charged: amount });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[me/bookings/tip] failed:', err.message);
    return serverError(res, err);
  }
}

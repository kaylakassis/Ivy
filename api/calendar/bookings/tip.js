// POST /api/calendar/bookings/tip   body: { id, amount }
//
// Owner-side endpoint to charge a tip against the client's saved
// card after a session. Companion endpoint /api/me/bookings/[id]/tip
// powers the client-portal "leave a tip" flow.
//
// Either path: idempotent in spirit — if a tip's already been
// charged, returns 400 so the owner doesn't double-bill.
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
    const amount = Number(body.amount);
    if (!id) return badRequest(res, 'id is required');
    if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, 'amount must be a positive number');
    if (amount > 1_000_000) return badRequest(res, 'amount too large');

    const r = await sql`
      SELECT b.*, c.stripe_customer_id, c.payment_method_id, s.name AS service_name
        FROM bookings b
        LEFT JOIN clients c  ON c.id = b.client_id
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.id = ${id} AND b.workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const b = r.rows[0];
    if (!b) return badRequest(res, 'Booking not found');
    if (Number(b.tip_amount) > 0) return badRequest(res, 'A tip has already been recorded for this booking');
    if (!b.stripe_customer_id || !b.payment_method_id) {
      return badRequest(res, 'No card on file for this client');
    }

    const creds = await loadStripeCreds(workspaceId);
    const pi = await chargeOffSession({
      secretKey: creds.secretKey,

      stripeAccount: creds.stripeAccount,
      customerId: b.stripe_customer_id,
      paymentMethodId: b.payment_method_id,
      amountCents: Math.round(amount * 100),
      currency: creds.currency,
      description: `Tip — ${b.service_name || 'session'}`,
      metadata: { booking_id: b.id, workspace_id: workspaceId, kind: 'tip' },
      statementDescriptor: 'TIP',
      // One tip per booking — stable key dedupes retries / crash-after-
      // charge so the client isn't tipped twice.
      idempotencyKey: `tip-${b.id}`,
    });

    const upd = await sql`
      UPDATE bookings SET
        tip_amount         = ${amount},
        tip_charged_at     = NOW(),
        tip_payment_intent = ${pi.id},
        updated_at         = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;
    return ok(res, { booking: serializeBooking(upd.rows[0]), charged: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[bookings/tip] failed:', err.message);
    return serverError(res, err);
  }
}

// POST /api/calendar/bookings/collect   body: { id }
//
// Owner-only. Generates a public-pay link the customer can scan/tap to
// pay the booking balance on their own phone. Implemented as:
//   1. Auto-create (or reuse) a draft invoice for the booking balance.
//   2. Mint a fresh view token on that invoice.
//   3. Return the public-pay URL + invoice payload.
//
// Why not a separate "booking pay-link" rail? Reusing the invoice rail
// means: the existing /invoice/[token] page handles checkout; the
// existing Stripe webhook flips status to paid; reporting in Finance
// already counts the revenue. One source of truth, zero new surface
// area on the public side.
//
// Re-clicks reuse the same invoice via bookings.collect_invoice_id —
// minting a new token invalidates the previous one (last-link-wins).
import { sql } from '../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { nextInvoiceNumber, serializeInvoice } from '../../_lib/finance.js';
import { generateRawToken, appUrl } from '../../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'Missing booking id');

    // Pull the booking + linked service so we can compute the balance
    // and label the invoice line item.
    const { rows } = await sql`
      SELECT
        b.id, b.workspace_id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min,
        b.booking_total, b.deposit_paid, b.collect_invoice_id,
        b.cancelled_at,
        s.id   AS service_id,
        s.name AS service_name,
        s.price AS service_price
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      WHERE b.id = ${id} AND b.workspace_id = ${workspaceId}
    `;
    const bk = rows[0];
    if (!bk) return badRequest(res, 'Booking not found');
    if (bk.cancelled_at) return badRequest(res, 'Booking is cancelled');

    const total       = Number(bk.booking_total || bk.service_price || 0);
    const depositPaid = Number(bk.deposit_paid || 0);
    const balance     = Math.max(0, Math.round((total - depositPaid) * 100) / 100);
    if (balance <= 0) return badRequest(res, 'No balance to collect — already paid in full');

    const serviceName = bk.service_name || 'Booking';
    const dateStr     = bk.date instanceof Date ? bk.date.toISOString().slice(0, 10) : bk.date;
    const description = `${serviceName} on ${dateStr}`;

    // Reuse an existing draft/sent invoice if we already opened one for
    // this booking and it's still collectible. Voided / paid states
    // force a fresh row.
    let invoiceRow = null;
    if (bk.collect_invoice_id) {
      const { rows: ex } = await sql`
        SELECT * FROM invoices
        WHERE id = ${bk.collect_invoice_id} AND workspace_id = ${workspaceId}
      `;
      if (ex[0]) {
        if (ex[0].status === 'paid') {
          return badRequest(res, 'Already paid');
        }
        if (ex[0].status !== 'voided') invoiceRow = ex[0];
      }
    }

    if (!invoiceRow) {
      const num    = await nextInvoiceNumber(workspaceId);
      const number = `INV-${num}`;
      // computeTotals reads `quantity` (not `qty`); using qty here left
      // quantity undefined → $0 total → an unpayable collect link.
      const items  = [{ description, quantity: 1, rate: balance }];
      const inserted = await sql`
        INSERT INTO invoices (
          workspace_id, number, client_id, client_name, client_email,
          items, tax_rate, discount, status
        ) VALUES (
          ${workspaceId}, ${number}, ${bk.client_id}, ${bk.client_name}, ${bk.client_email},
          ${JSON.stringify(items)}::jsonb, 0, 0, 'draft'
        )
        RETURNING *
      `;
      invoiceRow = inserted.rows[0];
      await sql`
        UPDATE bookings SET collect_invoice_id = ${invoiceRow.id}
        WHERE id = ${id} AND workspace_id = ${workspaceId}
      `;
    }

    // Mint a fresh pay-link token + flip to 'sent' so the public page
    // accepts it. Hashed storage matches /api/invoices/send.
    const rawToken  = generateRawToken(32);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const newActivity = [
      ...(invoiceRow.activity || []),
      { ts: new Date().toISOString(), kind: 'pay-link', text: `In-person pay link for booking on ${dateStr}` },
    ];
    const newStatus = invoiceRow.status === 'draft' ? 'sent' : invoiceRow.status;
    const setSentAt = invoiceRow.status === 'draft' && !invoiceRow.sent_at;

    const updated = await sql`
      UPDATE invoices SET
        view_token_hash = ${tokenHash},
        status          = ${newStatus},
        sent_at         = ${setSentAt ? new Date() : invoiceRow.sent_at},
        activity        = ${JSON.stringify(newActivity)}::jsonb,
        updated_at      = NOW()
      WHERE id = ${invoiceRow.id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    const url = `${appUrl()}/invoice/${encodeURIComponent(rawToken)}`;
    return ok(res, {
      url,
      invoice: serializeInvoice(updated.rows[0]),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

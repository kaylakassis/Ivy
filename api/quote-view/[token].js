// /api/quote-view/:token (public, no auth)
//   GET  → fetch the quote for the public viewer page
//   POST → accept or decline. Body:
//          { action: 'accept' } → mints an invoice from this quote
//          { action: 'decline', reason? }
//
// Token mirrors the invoice-view pattern: sha256-hashed before
// lookup, scoped to status='sent'. Once accepted/declined the
// token is invalidated so the link can't be re-used.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { computeTotals, nextInvoiceNumber } from '../_lib/finance.js';
import { serializeQuotePublic } from '../_lib/quotes.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function resolve(token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const tokenHash = hashToken(token);
  const r = await sql`
    SELECT q.*, cs.biz_name, cs.brand_logo_url, cs.brand_accent_color
      FROM quotes q
      LEFT JOIN calendar_settings cs ON cs.workspace_id = q.workspace_id
     WHERE q.view_token_hash = ${tokenHash}
     LIMIT 1
  `;
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  const ip = getClientIp(req);
  const blocked = await enforce(req, res, [
    { key: `quote-view:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
  ]);
  if (blocked) return;
  try {
    const token = (req.query.token || '').toString();
    const row = await resolve(token);
    if (!row) return notFound(res, 'This estimate link is no longer active.');

    if (req.method === 'GET') {
      // Auto-mark expired if past expiry_date.
      if (row.status === 'sent' && row.expiry_date) {
        const expISO = row.expiry_date instanceof Date
          ? row.expiry_date.toISOString().slice(0, 10) : row.expiry_date;
        const today = new Date().toISOString().slice(0, 10);
        if (expISO < today) {
          await sql`UPDATE quotes SET status = 'expired', updated_at = NOW() WHERE id = ${row.id}`;
          row.status = 'expired';
        }
      }
      return ok(res, {
        quote: serializeQuotePublic(row, {
          business: {
            name: row.biz_name || null,
            logoUrl: row.brand_logo_url || null,
            accentColor: row.brand_accent_color || null,
          },
        }),
      });
    }

    if (req.method === 'POST') {
      if (row.status !== 'sent') return badRequest(res, 'This estimate is no longer active.');
      const body = await readBody(req);
      const action = (body.action || '').toString();
      if (action !== 'accept' && action !== 'decline') {
        return badRequest(res, "action must be 'accept' or 'decline'");
      }

      if (action === 'decline') {
        const reason = body.reason ? String(body.reason).slice(0, 500) : null;
        const newActivity = [
          ...(row.activity || []),
          { ts: new Date().toISOString(), kind: 'declined', text: `Client declined${reason ? ` — "${reason}"` : ''}`, ip },
        ];
        await sql`
          UPDATE quotes SET
            status         = 'declined',
            declined_at    = NOW(),
            decline_reason = ${reason},
            view_token_hash = NULL,
            activity       = ${JSON.stringify(newActivity)}::jsonb,
            updated_at     = NOW()
          WHERE id = ${row.id}
        `;
        return ok(res, { ok: true, declined: true });
      }

      // Accept: clone items into a fresh draft invoice and link it.
      // The owner can review + send the invoice from their Finance tab.
      const num = await nextInvoiceNumber(row.workspace_id);
      const invNumber = `INV-${num}`;
      const issueDate = new Date().toISOString().slice(0, 10);
      const due = new Date(); due.setDate(due.getDate() + 14);
      const dueDate = due.toISOString().slice(0, 10);

      const invIns = await sql`
        INSERT INTO invoices (
          workspace_id, number, client_id, client_name, client_email,
          issue_date, due_date, items, tax_rate, discount, notes,
          status, activity
        ) VALUES (
          ${row.workspace_id}, ${invNumber},
          ${row.client_id}, ${row.client_name}, ${row.client_email},
          ${issueDate}, ${dueDate},
          ${JSON.stringify(row.items || [])}::jsonb,
          ${row.tax_rate}, ${row.discount}, ${row.notes},
          'draft',
          ${JSON.stringify([{ ts: new Date().toISOString(), kind: 'auto-created', text: `Created from accepted estimate ${row.number}` }])}::jsonb
        )
        RETURNING *
      `;
      const newInvoice = invIns.rows[0];

      const newActivity = [
        ...(row.activity || []),
        { ts: new Date().toISOString(), kind: 'accepted', text: `Client accepted — invoice ${newInvoice.number} drafted`, ip },
      ];
      await sql`
        UPDATE quotes SET
          status               = 'accepted',
          accepted_at          = NOW(),
          view_token_hash      = NULL,
          resulting_invoice_id = ${newInvoice.id},
          activity             = ${JSON.stringify(newActivity)}::jsonb,
          updated_at           = NOW()
        WHERE id = ${row.id}
      `;
      return ok(res, { ok: true, accepted: true, invoiceNumber: newInvoice.number });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}

// POST /api/pos/sale — in-person quick-sale.
// Body: {
//   items: [{ productId?, description?, quantity, rate? }],  // product or ad-hoc
//   payment: 'cash' | 'link',
//   clientId?, clientName?, clientEmail?, taxRate?, discount?
// }
// Builds an invoice from the line items (product price/name resolved
// server-side), decrements inventory atomically (with compensation if a
// later line is out of stock), then either marks it PAID (cash) or mints a
// pay-link the owner can show as a QR / send to the buyer's phone.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { serializeInvoice, nextInvoiceNumber } from '../_lib/finance.js';
import { decrementStock, restoreStock } from '../_lib/products.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const lid = () => `li_${Math.random().toString(36).slice(2, 9)}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (!(await requireActiveSubscription(workspaceId, req, res))) return;

    const body = await readBody(req);

    // Idempotency: a double-click or a timeout-then-retry must not create
    // two paid invoices + double-decrement stock. The client sends a
    // stable Idempotency-Key per sale; a replay returns the first
    // response without re-running the side effects. No key → runs normally.
    const out = await withIdempotency(req, user.id, async () => {
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (!rawItems.length) return { status: 400, body: { error: 'Add at least one item to the sale' } };

      // Resolve referenced products (price + name come from the server, never
      // the client).
      const productIds = [...new Set(rawItems.map((i) => i.productId).filter(Boolean))];
      const prodMap = {};
      if (productIds.length) {
        const { rows } = await sql`SELECT * FROM products WHERE workspace_id = ${workspaceId} AND id = ANY(${productIds})`;
        for (const p of rows) prodMap[p.id] = p;
      }

      const lineItems = [];
      const decrements = [];
      for (const it of rawItems) {
        const qty = Math.max(0, Math.ceil(Number(it.quantity) || 0));
        if (qty <= 0) continue;
        if (it.productId) {
          const p = prodMap[it.productId];
          if (!p) return { status: 400, body: { error: 'Unknown product in sale' } };
          lineItems.push({ id: lid(), description: p.name, quantity: qty, rate: Number(p.price) });
          if (p.track_stock) decrements.push({ productId: p.id, name: p.name, qty });
        } else {
          const desc = (it.description || '').toString().slice(0, 500);
          const rate = Math.max(0, Number(it.rate) || 0);
          lineItems.push({ id: lid(), description: desc || 'Item', quantity: qty, rate });
        }
      }
      if (!lineItems.length) return { status: 400, body: { error: 'Add at least one item to the sale' } };

      // Decrement stock atomically; compensate the ones already done if a
      // later line can't be fulfilled.
      const done = [];
      for (const d of decrements) {
        // eslint-disable-next-line no-await-in-loop
        const okk = await decrementStock({ workspaceId, productId: d.productId, qty: d.qty });
        if (!okk) {
          // eslint-disable-next-line no-await-in-loop
          for (const r of done) await restoreStock({ workspaceId, productId: r.productId, qty: r.qty });
          return { status: 400, body: { error: `${d.name} is out of stock` } };
        }
        done.push(d);
      }

      const cash = body.payment === 'cash';
      // Tax rate: if the request doesn't override, fall back to the
      // workspace's saved default_tax_rate so a cashier doesn't have
      // to re-key it on every sale. body.taxRate=0 explicitly skips
      // tax for this sale (non-taxed items, e.g. groceries).
      let taxRate = body.taxRate != null ? Math.max(0, Number(body.taxRate) || 0) : null;
      if (taxRate === null) {
        const fs = await sql`SELECT default_tax_rate FROM finance_settings WHERE workspace_id = ${workspaceId}`;
        taxRate = Number(fs.rows[0]?.default_tax_rate || 0);
      }
      const discount = Math.max(0, Number(body.discount) || 0);
      const rawToken = cash ? null : generateRawToken(32);
      const tokenHash = rawToken ? crypto.createHash('sha256').update(rawToken).digest('hex') : null;
      const number = `INV-${await nextInvoiceNumber(workspaceId)}`;
      const today = new Date().toISOString().slice(0, 10);
      const activity = [{ ts: new Date().toISOString(), kind: cash ? 'paid' : 'pay-link',
        text: cash ? 'Paid in person (cash)' : 'In-person sale — pay link issued' }];

      let invoice;
      try {
        const ins = await sql`
          INSERT INTO invoices (
            workspace_id, number, client_id, client_name, client_email,
            issue_date, due_date, items, tax_rate, discount,
            status, paid_at, view_token_hash, activity, currency
          ) VALUES (
            ${workspaceId}, ${number},
            ${body.clientId || null},
            ${(body.clientName || 'Walk-in').toString().slice(0, 200)},
            ${body.clientEmail ? String(body.clientEmail).slice(0, 200) : null},
            ${today}, ${today},
            ${JSON.stringify(lineItems)}::jsonb, ${taxRate}, ${discount},
            ${cash ? 'paid' : 'sent'}, ${cash ? new Date() : null}, ${tokenHash},
            ${JSON.stringify(activity)}::jsonb,
            COALESCE((SELECT currency FROM finance_settings WHERE workspace_id = ${workspaceId}), 'USD')
          )
          RETURNING *
        `;
        invoice = ins.rows[0];
      } catch (err) {
        // Roll the inventory back if the invoice couldn't be created.
        for (const r of done) await restoreStock({ workspaceId, productId: r.productId, qty: r.qty });
        throw err;
      }

      // Cash sales settle immediately — stamp paid_amount + paid_method so
      // they show up in revenue rollups AND client 30-day metrics (which
      // sum paid_amount). total is set by the BEFORE-insert trigger, so we
      // copy it across exactly rather than re-deriving. Best-effort: the
      // sale already succeeded, so a backfill miss must not fail it.
      if (cash) {
        try {
          const upd = await sql`
            UPDATE invoices SET paid_amount = total, paid_method = 'cash'
             WHERE id = ${invoice.id} AND workspace_id = ${workspaceId}
             RETURNING *
          `;
          if (upd.rows[0]) invoice = upd.rows[0];
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[pos/sale] paid_amount backfill failed:', e.message);
        }
      }

      // Email receipt for cash sales when the customer left an email.
      // Best-effort — never fails the sale. Pay-link mode skips this
      // because the buyer will see the invoice + receipt via the
      // /invoice/<token> flow anyway.
      const clientEmail = body.clientEmail ? String(body.clientEmail).trim().toLowerCase().slice(0, 200) : null;
      if (cash && clientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
        try {
          const branding = await fetchBranding(workspaceId);
          const business = branding.businessName || 'your provider';
          const lineHtml = (invoice.items || []).map((it) =>
            `<tr><td style="padding:6px 0;color:#3F3D38;font-size:13px">${it.quantity}× ${escapeHtml(it.description)}</td>
              <td align="right" style="padding:6px 0;color:#3F3D38;font-size:13px;white-space:nowrap">${fmtMoney(Number(it.rate) * Number(it.quantity))}</td></tr>`
          ).join('');
          await sendEmailToClient({
            clientId: body.clientId || null, type: 'payments',
            to: clientEmail,
            subject: `Receipt from ${business} · ${fmtMoney(invoice.total)}`,
            replyTo: branding.replyTo,
            html: emailShell({
              heading: 'Thanks for your purchase',
              body: `<p>Here's your receipt from <strong>${escapeHtml(business)}</strong>.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;border-top:1px solid #E6E2D6;border-bottom:1px solid #E6E2D6;padding:8px 0">
                  ${lineHtml}
                </table>
                <div style="display:flex;justify-content:space-between;font-weight:600;font-size:15px;color:#0E0E0E">
                  <span>Total paid</span><span>${fmtMoney(invoice.total)}</span>
                </div>
                <p style="color:#7B7867;font-size:12px;margin-top:14px">Paid in person · ${new Date().toLocaleDateString()}</p>`,
              branding,
            }),
          });
        } catch (mailErr) {
          // eslint-disable-next-line no-console
          console.warn('[pos/sale] receipt email failed:', mailErr.message);
        }
      }

      return {
        status: 200,
        body: {
          invoice: serializeInvoice(invoice),
          paid: cash,
          receiptEmailed: cash && !!clientEmail,
          payUrl: rawToken ? `${appUrl()}/invoice/${encodeURIComponent(rawToken)}` : null,
        },
      };
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return serverError(res, err);
  }
}

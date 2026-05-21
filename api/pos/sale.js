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
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

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
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return badRequest(res, 'Add at least one item to the sale');

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
        if (!p) return badRequest(res, 'Unknown product in sale');
        lineItems.push({ id: lid(), description: p.name, quantity: qty, rate: Number(p.price) });
        if (p.track_stock) decrements.push({ productId: p.id, name: p.name, qty });
      } else {
        const desc = (it.description || '').toString().slice(0, 500);
        const rate = Math.max(0, Number(it.rate) || 0);
        lineItems.push({ id: lid(), description: desc || 'Item', quantity: qty, rate });
      }
    }
    if (!lineItems.length) return badRequest(res, 'Add at least one item to the sale');

    // Decrement stock atomically; compensate the ones already done if a
    // later line can't be fulfilled.
    const done = [];
    for (const d of decrements) {
      // eslint-disable-next-line no-await-in-loop
      const okk = await decrementStock({ workspaceId, productId: d.productId, qty: d.qty });
      if (!okk) {
        // eslint-disable-next-line no-await-in-loop
        for (const r of done) await restoreStock({ workspaceId, productId: r.productId, qty: r.qty });
        return badRequest(res, `${d.name} is out of stock`);
      }
      done.push(d);
    }

    const cash = body.payment === 'cash';
    const taxRate = Math.max(0, Number(body.taxRate) || 0);
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

    return ok(res, {
      invoice: serializeInvoice(invoice),
      paid: cash,
      payUrl: rawToken ? `${appUrl()}/invoice/${encodeURIComponent(rawToken)}` : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

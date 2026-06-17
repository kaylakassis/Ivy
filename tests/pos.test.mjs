// Tests for Inventory / retail / POS quick-sale.
//   • decrementStock is atomic (won't oversell) + restoreStock compensates.
//   • POS sale: cash marks the invoice paid; pay-link returns a URL;
//     stock decrements; out-of-stock is rejected with no partial deduction.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/pos.test.mjs

import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { decrementStock, restoreStock } from '../api/_lib/products.js';
import saleHandler from '../api/pos/sale.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader() {}, end() { return this; } };
}
const stockOf = async (id) => (await sql`SELECT stock_qty FROM products WHERE id = ${id}`).rows[0].stock_qty;

const createdUsers = [];
async function run() {
  try {
    // The test DB is already migrated (probe passes), so the new products
    // table isn't auto-created — ensure it idempotently.
    await sql`CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL, sku TEXT, price NUMERIC(12,2) NOT NULL DEFAULT 0, cost NUMERIC(12,2),
      track_stock BOOLEAN NOT NULL DEFAULT TRUE, stock_qty INT NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE, category TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`pos-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${wid}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
    const mk = async (name, price, track, qty) => (await sql`
      INSERT INTO products (workspace_id, name, price, track_stock, stock_qty)
      VALUES (${wid}, ${name}, ${price}, ${track}, ${qty}) RETURNING id`).rows[0].id;

    console.log('\n[unit] decrementStock / restoreStock');
    const p1 = await mk('Serum', 10, true, 2);
    const pUn = await mk('Service', 100, false, 0);
    assert((await decrementStock({ workspaceId: wid, productId: p1, qty: 1 })) === true && (await stockOf(p1)) === 1, 'decrement 1 of 2 → stock 1');
    assert((await decrementStock({ workspaceId: wid, productId: p1, qty: 2 })) === false && (await stockOf(p1)) === 1, 'cannot decrement 2 when only 1 left (no oversell)');
    assert((await decrementStock({ workspaceId: wid, productId: pUn, qty: 9 })) === true, 'untracked product always decrements ok');
    await restoreStock({ workspaceId: wid, productId: p1, qty: 1 });
    assert((await stockOf(p1)) === 2, 'restoreStock puts it back to 2');

    const cookie = `ivy_session=${signSession(uid)}`;
    const sale = async (b) => { const r = mockRes(); await saleHandler({ method: 'POST', headers: { cookie }, query: {}, body: b }, r); return r; };

    console.log('\n[e2e] cash sale marks paid + decrements stock');
    let r = await sale({ items: [{ productId: p1, quantity: 1 }, { productId: pUn, quantity: 1 }], payment: 'cash', clientName: 'Walk-in' });
    assert(r.statusCode === 200 && r.body?.paid === true, 'cash sale returns paid=true');
    assert(r.body?.invoice?.status === 'paid', 'invoice status = paid');
    assert((await stockOf(p1)) === 1, 'tracked product stock 2 → 1');

    console.log('\n[e2e] pay-link sale returns a URL');
    r = await sale({ items: [{ productId: p1, quantity: 1 }], payment: 'link' });
    assert(r.statusCode === 200 && typeof r.body?.payUrl === 'string' && r.body.payUrl.includes('/invoice/'), 'link sale returns a pay URL');
    assert(r.body?.paid === false && (await stockOf(p1)) === 0, 'stock now 0 after second unit sold');

    console.log('\n[e2e] out-of-stock is rejected with no partial deduction');
    const okP = await mk('InStock', 5, true, 5);
    const outP = await mk('SoldOut', 7, true, 1);
    r = await sale({ items: [{ productId: okP, quantity: 1 }, { productId: outP, quantity: 3 }], payment: 'cash' });
    assert(r.statusCode === 400, 'sale rejected (400) when a line is out of stock');
    assert((await stockOf(okP)) === 5, 'the in-stock line was NOT deducted (compensated)');
    assert((await stockOf(outP)) === 1, 'the out-of-stock line untouched');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

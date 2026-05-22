// Tests the Idempotency-Key guard on the POS quick-sale. A double-click
// or timeout-then-retry with the SAME key must create exactly one invoice
// and decrement stock once; a new key is a distinct sale.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/pos-idempotency.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import saleHandler from '../api/pos/sale.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    setHeader() {}, end() { return this; },
  };
}

async function run() {
  await ensureSchemaApplied();

  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`posidem-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${wid}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
  const pid = (await sql`INSERT INTO products (workspace_id, name, price, track_stock, stock_qty)
    VALUES (${wid}, 'Serum', 10, TRUE, 5) RETURNING id`).rows[0].id;

  const cookie = `thryve_session=${signSession(uid)}`;
  const stockOf = async () => (await sql`SELECT stock_qty FROM products WHERE id = ${pid}`).rows[0].stock_qty;
  const invCount = async () => (await sql`SELECT COUNT(*)::int n FROM invoices WHERE workspace_id = ${wid}`).rows[0].n;
  const sale = async (key) => {
    const r = mockRes();
    await saleHandler({
      method: 'POST',
      headers: { cookie, 'idempotency-key': key },
      query: {},
      body: { items: [{ productId: pid, quantity: 1 }], payment: 'cash', clientName: 'Walk-in' },
    }, r);
    return r;
  };

  console.log('\n[1] first sale with a unique key');
  const r1 = await sale('K1-' + Date.now());
  assert(r1.statusCode === 200 && r1.body?.paid === true, 'sale succeeds (paid)');
  assert((await stockOf()) === 4, 'stock decremented 5 → 4');
  assert((await invCount()) === 1, 'one invoice created');

  console.log('\n[2] replay with the SAME key → deduped (no second invoice, no extra decrement)');
  const sameKey = 'K1-fixed-' + Date.now();
  const a = await sale(sameKey);
  const b = await sale(sameKey);
  assert(a.body?.invoice?.id === b.body?.invoice?.id, 'replay returns the same invoice id');
  assert((await stockOf()) === 3, 'stock decremented only once for the duplicated key (4 → 3, not 2)');
  assert((await invCount()) === 2, 'still only two invoices total (K1 + sameKey), replay added none');

  console.log('\n[3] a different key is a distinct sale');
  await sale('K2-distinct-' + Date.now());
  assert((await stockOf()) === 2, 'new key decrements stock again (3 → 2)');
  assert((await invCount()) === 3, 'third invoice created for the new key');

  // Cleanup.
  await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM idempotency_records WHERE scope = ${uid}`;
  await sql`DELETE FROM products WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

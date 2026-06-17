// Tests the "revenue truth" fixes:
//   • partial refunds reduce paid-revenue rollups (finance summary)
//   • POS cash sales stamp paid_amount + paid_method so they count in
//     revenue + client metrics (previously NULL → invisible)
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/revenue-truth.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import financeHandler from '../api/finance/index.js';
import saleHandler from '../api/pos/sale.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    setHeader() {}, getHeader() {}, end() { return this; },
  };
}

async function run() {
  await ensureSchemaApplied();

  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`rev-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${wid}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
  const cookie = `ivy_session=${signSession(uid)}`;
  const today = new Date().toISOString().slice(0, 10);

  const mkInvoice = async ({ status, total, refunded, paidNow }) => sql.query(
    `INSERT INTO invoices (workspace_id, number, client_name, issue_date, due_date,
                           items, status, paid_at, refunded_amount)
     VALUES ($1,$2,'Walk-in',$3,$3,$4::jsonb,$5,${paidNow ? 'NOW()' : 'NULL'},$6) RETURNING id, total`,
    [wid, `INV-${Math.random().toString(36).slice(2, 8)}`, today,
     JSON.stringify([{ id: 'li1', description: 'X', quantity: 1, rate: total }]), status, refunded],
  );

  console.log('\n[1] partial refund reduces paid revenue; full refund drops out entirely');
  const partial = (await mkInvoice({ status: 'paid', total: 100, refunded: 30, paidNow: true })).rows[0];
  assert(Number(partial.total) === 100, 'trigger materialized total=100 from items');
  await mkInvoice({ status: 'refunded', total: 50, refunded: 50, paidNow: true }); // fully refunded → excluded

  const res = mockRes();
  await financeHandler({ method: 'GET', headers: { cookie, origin: 'http://localhost:3000', host: 'localhost:3000' }, query: {} }, res);
  const sum = res.body?.summary;
  assert(!!sum, 'finance summary returned');
  assert(Number(sum.totalPaid) === 70, `totalPaid nets the partial refund: 100-30 = 70 (got ${sum?.totalPaid})`);
  assert(Number(sum.monthPaid) === 70, `monthPaid also nets the refund (got ${sum?.monthPaid})`);

  console.log('\n[2] POS cash sale stamps paid_amount + paid_method');
  const pid = (await sql`INSERT INTO products (workspace_id, name, price, track_stock, stock_qty)
    VALUES (${wid}, 'Serum', 25, FALSE, 0) RETURNING id`).rows[0].id;
  const saleRes = mockRes();
  await saleHandler({
    method: 'POST',
    headers: { cookie, 'idempotency-key': 'rev-pos-' + Date.now() },
    query: {},
    body: { items: [{ productId: pid, quantity: 2 }], payment: 'cash', clientName: 'Walk-in' },
  }, saleRes);
  assert(saleRes.statusCode === 200 && saleRes.body?.paid === true, 'cash sale succeeded');
  const invId = saleRes.body?.invoice?.id;
  const row = (await sql`SELECT total, paid_amount, paid_method FROM invoices WHERE id = ${invId}`).rows[0];
  assert(Number(row.paid_amount) === Number(row.total), `paid_amount equals total (${row.paid_amount} == ${row.total})`);
  assert(Number(row.total) === 50, 'total = 2 × $25 = $50');
  assert(row.paid_method === 'cash', "paid_method = 'cash'");

  console.log('\n[3] the cash sale now counts toward paid revenue');
  const res2 = mockRes();
  await financeHandler({ method: 'GET', headers: { cookie, origin: 'http://localhost:3000', host: 'localhost:3000' }, query: {} }, res2);
  assert(Number(res2.body?.summary?.totalPaid) === 120, `totalPaid = 70 (invoice) + 50 (cash sale) = 120 (got ${res2.body?.summary?.totalPaid})`);

  // Cleanup.
  await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM products WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM idempotency_records WHERE scope = ${uid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

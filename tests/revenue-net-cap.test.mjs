// invoice_net_revenue caps at the invoice total when one is recorded (tax a
// processor added on top, or a second payment, is not the business's income)
// and leaves legacy invoices without a stored total uncapped.
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const TAG = `revcap-${Date.now()}`;

await ensureSchemaApplied();
const u = (await sql`INSERT INTO users (email, password_hash) VALUES (${TAG + '@example.com'}, 'x') RETURNING id`).rows[0].id;
const w = (await sql`INSERT INTO workspaces (owner_id) VALUES (${u}) RETURNING id`).rows[0].id;
const inv = async (n, total, paid) => (await sql`
  INSERT INTO invoices (workspace_id, client_name, number, status, items, tax_rate, discount, total, paid_amount, paid_at)
  VALUES (${w}, 'C', ${TAG + n}, 'paid', ${JSON.stringify(total ? [{ description: 'x', quantity: 1, rate: total }] : [])}::jsonb, 0, 0, ${total}, ${paid}, NOW()) RETURNING id`).rows[0].id;
const net = async (id) => Number((await sql`SELECT invoice_net_revenue(i) AS v FROM invoices i WHERE i.id = ${id}`).rows[0].v);

try {
  const taxed = await inv('a', 100, 100);
  await sql`INSERT INTO invoice_payments (workspace_id, invoice_id, provider, provider_payment_id, amount) VALUES (${w}, ${taxed}, 'stripe', ${TAG + 'pi'}, 108.25)`;
  assert(await net(taxed) === 100, 'tax collected on top of a $100 invoice counts $100, not $108.25');
  const legacy = await inv('b', 0, 50);
  assert(await net(legacy) === 50, 'legacy invoice with no stored total keeps the $50 collected');
  const normal = await inv('c', 80, 80);
  assert(await net(normal) === 80, 'ordinary $80 invoice counts $80');
} finally {
  await sql`DELETE FROM workspaces WHERE id = ${w}`;
  await sql`DELETE FROM users WHERE id = ${u}`;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

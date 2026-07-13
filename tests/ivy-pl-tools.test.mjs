// Ivy P&L read tools: list_expenses + get_pl_summary. Confirms Ivy can now
// SEE profit (revenue - expenses), not just top-line revenue, and that both
// tools are workspace-scoped.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-pl-tools.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL = `ivy-pl-${Date.now()}@example.com`;
let ownerId, workspaceId;
// A second workspace to prove isolation.
const EMAIL2 = `ivy-pl-other-${Date.now()}@example.com`;
let otherWs;

async function run() {
  try {
    await ensureSchemaApplied();

    ownerId = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL}, 'x', 'PL') RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    const other = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL2}, 'x', 'Other') RETURNING id`).rows[0].id;
    otherWs = (await sql`INSERT INTO workspaces (owner_id) VALUES (${other}) RETURNING id`).rows[0].id;

    // A paid invoice THIS month (revenue) — let the DB compute `total` from items
    // so we assert against whatever the trigger stored, not a guessed number.
    await sql`
      INSERT INTO invoices (workspace_id, number, client_name, status, items, tax_rate, discount, currency, paid_at)
      VALUES (${workspaceId}, ${'PL-' + Date.now()}, 'Acme', 'paid',
              ${JSON.stringify([{ quantity: 1, rate: 500 }])}::jsonb, 0, 0, 'USD', NOW())`;
    const revenue = Number((await sql`SELECT COALESCE(SUM(total),0)::numeric AS t FROM invoices WHERE workspace_id = ${workspaceId} AND status='paid'`).rows[0].t);

    // Two expenses this month + one for the OTHER workspace (must never leak in).
    await sql`INSERT INTO expenses (workspace_id, amount, date, category) VALUES (${workspaceId}, 120.00, CURRENT_DATE, 'supplies')`;
    await sql`INSERT INTO expenses (workspace_id, amount, date, category) VALUES (${workspaceId}, 30.00, CURRENT_DATE, 'software')`;
    await sql`INSERT INTO expenses (workspace_id, amount, date, category) VALUES (${otherWs}, 9999.00, CURRENT_DATE, 'supplies')`;

    console.log('\n[1] list_expenses returns this workspace only, with totals + by-category');
    const le = await executeIvyTool('list_expenses', {}, { workspaceId });
    assert(Array.isArray(le.expenses) && le.expenses.length === 2, 'exactly this workspace\'s 2 expenses');
    assert(le.this_month_total === 150, 'this_month_total = 120 + 30 = 150');
    assert(!le.expenses.some((e) => Number(e.amount) === 9999), 'never includes the other workspace\'s expense');
    const cats = Object.fromEntries((le.this_month_by_category || []).map((c) => [c.category, c.total]));
    assert(cats.supplies === 120 && cats.software === 30, 'by-category breakdown correct');

    console.log('\n[2] get_pl_summary computes profit = revenue - expenses');
    const pl = await executeIvyTool('get_pl_summary', {}, { workspaceId });
    assert(pl.this_month.revenue === revenue, `revenue this month = ${revenue}`);
    assert(pl.this_month.expenses === 150, 'expenses this month = 150');
    assert(pl.this_month.profit === revenue - 150, 'profit = revenue - expenses');
    assert(typeof pl.last_month === 'object', 'includes a last_month block for comparison');

    console.log('\n[3] a workspace with no data reads as zeros, not an error');
    const empty = await executeIvyTool('get_pl_summary', {}, { workspaceId: otherWs });
    // otherWs has one expense (9999) but no paid invoices → negative profit, still numeric.
    assert(typeof empty.this_month.profit === 'number', 'profit is numeric even with no revenue');
    assert(empty.this_month.expenses === 9999, 'other workspace sees only its OWN expense');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const e of [EMAIL, EMAIL2]) {
      await sql`DELETE FROM workspaces WHERE owner_id = (SELECT id FROM users WHERE email = ${e})`.catch(() => {});
      await sql`DELETE FROM users WHERE email = ${e}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

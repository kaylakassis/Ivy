// Test for Batch-4 (#4): the dashboard endpoint returns real workspace
// numbers (was hardcoded "—"). Seeds a paid invoice, active client,
// booking today, and an expense, then asserts the rollup.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-batch4.test.mjs

import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import dashboard from '../api/dashboard.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  const res = { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
  return res;
}

const createdUsers = [];
async function run() {
  try {
    const u = await sql`
      INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`b4-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`;
    const wid = w.rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${wid}, 'USD') ON CONFLICT (workspace_id) DO UPDATE SET currency = 'USD'`;

    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Active C', ${`ac-${Date.now()}@example.com`}, 'active')`;
    await sql`
      INSERT INTO invoices (workspace_id, number, client_name, issue_date, due_date, items, status, paid_at)
      VALUES (${wid}, 'INV-D1', 'Payer', CURRENT_DATE, CURRENT_DATE,
              ${JSON.stringify([{ description: 'Svc', quantity: 1, rate: 100 }])}::jsonb, 'paid', NOW())`;
    await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min) VALUES (${wid}, 'Today Client', 'tc@example.com', CURRENT_DATE, 600, 660)`;
    await sql`INSERT INTO expenses (workspace_id, amount, date, category) VALUES (${wid}, 40, CURRENT_DATE, 'Supplies')`;

    const req = { method: 'GET', headers: { cookie: `ivy_session=${signSession(uid)}` }, url: '/api/dashboard', query: {} };
    const res = mockRes();
    await dashboard(req, res);

    assert(res.statusCode === 200, 'dashboard returns 200');
    const b = res.body || {};
    assert(Number(b.metrics?.mrr) === 100, `revenue this month = 100 (got ${b.metrics?.mrr})`);
    assert(Number(b.metrics?.clients) >= 1, 'active clients >= 1');
    assert(Number(b.metrics?.booked) >= 1, 'booked this month >= 1');
    assert(Number(b.metrics?.hours) === 1, `hours this month = 1 (got ${b.metrics?.hours})`);
    assert(Number(b.revenueVsExpenses?.revenue) === 100 && Number(b.revenueVsExpenses?.expenses) === 40,
      'revenueVsExpenses revenue=100 / expenses=40');
    assert(Array.isArray(b.today) && b.today.some((t) => t.clientName === 'Today Client'), "today's schedule includes the booking");
    assert(b.currency === 'USD', 'currency surfaced');
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

// Test for Batch-8 (#15): the data export now includes a client_portal
// section, so a client-only user (who owns no workspace) gets their real
// data (bookings/invoices/documents/messages they hold as a customer).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-batch8.test.mjs

import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import exportHandler from '../api/account/export.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  let buf = '';
  return {
    statusCode: 200, headers: {},
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { buf += chunk; return true; },
    end(chunk) { if (chunk) buf += chunk; this.body = buf; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
  };
}

const createdUsers = [];
async function run() {
  try {
    // Owner business with a client whose user account is the "customer".
    const owner = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`b8-owner-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(owner.rows[0].id);
    const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${owner.rows[0].id}) RETURNING id`;
    const wid = w.rows[0].id;

    const custEmail = `b8-cust-${Date.now()}@example.com`;
    const cust = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, email_verified_at)
      VALUES (${custEmail}, 'x', '2026-05-05', NOW(), NOW()) RETURNING id`;
    createdUsers.push(cust.rows[0].id);
    const custUid = cust.rows[0].id;

    const client = await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
      VALUES (${wid}, 'Customer', ${custEmail}, 'active', ${custUid}) RETURNING id`;
    const cid = client.rows[0].id;

    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${wid}, ${cid}, 'Customer', ${custEmail}, '2030-06-01', 600, 660)`;
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
      VALUES (${wid}, 'INV-B8', ${cid}, 'Customer', ${JSON.stringify([{ description: 'x', quantity: 1, rate: 50 }])}::jsonb, 'sent')`;

    const req = { method: 'GET', headers: { cookie: `ivy_session=${signSession(custUid)}` }, url: '/api/account/export', query: {} };
    const res = mockRes();
    await exportHandler(req, res);

    assert(res.statusCode === 200, 'export returns 200');
    const data = JSON.parse(res.body);
    assert(data.client_portal != null, 'client_portal section present for a client-only user');
    assert(Array.isArray(data.client_portal?.bookings) && data.client_portal.bookings.length >= 1,
      'client_portal includes the customer\'s booking');
    assert(Array.isArray(data.client_portal?.invoices) && data.client_portal.invoices.some((i) => i.number === 'INV-B8'),
      'client_portal includes the customer\'s invoice');
    assert(Array.isArray(data.client_portal?.businesses) && data.client_portal.businesses.length >= 1,
      'client_portal lists the businesses they\'re a client of');
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

// Tests for the Batch-1 audit fixes.
//   #1  collect-in-person invoice item must use `quantity` (not `qty`),
//       else computeTotals reads 0 → $0 unpayable invoice.
//   #12 users.user_type CHECK must allow 'super_admin' (admin promotion).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-batch1.test.mjs

import { computeTotals } from '../api/_lib/finance.js';
import { SCHEMA_SQL } from '../api/_lib/schema.js';
import { sql } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const createdUsers = [];

async function run() {
  try {
    console.log('\n[#1] invoice line items must carry `quantity`');
    assert(computeTotals([{ description: 'Balance', quantity: 1, rate: 50 }], 0, 0).total === 50,
      'quantity:1 → total reflects the rate ($50)');
    assert(computeTotals([{ description: 'Balance', qty: 1, rate: 50 }], 0, 0).total === 0,
      'the old `qty` key (no quantity) → $0 (the bug we fixed)');

    console.log('\n[#12] users.user_type CHECK allows super_admin');
    // Apply the canonical constraint DDL from schema.js (DROP + ADD), so
    // the test asserts the SHIPPED constraint, not whatever the test DB
    // happened to have from an earlier migration.
    const ddl = SCHEMA_SQL.split('\n').join('\n');
    const dropIdx = ddl.indexOf('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check');
    const addEnd  = ddl.indexOf(';', ddl.indexOf('ALTER TABLE users ADD CONSTRAINT users_user_type_check'));
    const block   = ddl.slice(dropIdx, addEnd + 1);
    for (const stmt of block.split(';').map((s) => s.trim()).filter(Boolean)) {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(stmt);
    }

    const email = `sa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const u = await sql`
      INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, user_type)
      VALUES (${email}, 'x', '2026-05-05', NOW(), 'super_admin')
      RETURNING id, user_type`;
    createdUsers.push(u.rows[0].id);
    assert(u.rows[0].user_type === 'super_admin', 'a user can be created/promoted to super_admin');

    let rejected = false;
    try {
      const b = await sql`
        INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, user_type)
        VALUES (${'bogus-' + email}, 'x', '2026-05-05', NOW(), 'bogus_role')
        RETURNING id`;
      createdUsers.push(b.rows[0].id);
    } catch { rejected = true; }
    assert(rejected, 'an unknown user_type is still rejected by the CHECK');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

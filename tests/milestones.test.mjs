// Tests api/_lib/milestones.js: first-booking and first-payment milestones
// fire exactly once, into the owner's notification feed, and ignore sample
// (source='demo') bookings.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/milestones.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { celebrateFirstBooking, celebrateFirstPayment } from '../api/_lib/milestones.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const countNotif = async (uid, tag) =>
  Number((await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${uid} AND tag = ${tag}`).rows[0].n);

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `ms-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;

    console.log('\n[1] first booking fires once');
    // Sample/demo booking should NOT count toward the milestone.
    const demoCli = (await sql`INSERT INTO clients (workspace_id, name, source, stage)
      VALUES (${ws}, 'Demo', 'demo', 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${demoCli}, 'Demo', 'demo@example.com', CURRENT_DATE, 600, 660)`;
    await celebrateFirstBooking(ws);
    assert(await countNotif(uid, 'milestone-first-booking') === 0, 'demo booking does not trigger milestone');

    // First real booking → fires.
    const realCli = (await sql`INSERT INTO clients (workspace_id, name, stage)
      VALUES (${ws}, 'Real Rita', 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${realCli}, 'Real Rita', 'rita@example.com', CURRENT_DATE, 660, 720)`;
    await celebrateFirstBooking(ws);
    assert(await countNotif(uid, 'milestone-first-booking') === 1, 'first real booking fires the milestone');

    // Second real booking → does NOT fire again.
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${realCli}, 'Real Rita', 'rita@example.com', CURRENT_DATE, 720, 780)`;
    await celebrateFirstBooking(ws);
    assert(await countNotif(uid, 'milestone-first-booking') === 1, 'second booking does not re-fire');

    console.log('\n[2] first payment fires once');
    await celebrateFirstPayment(ws); // no paid invoices yet
    assert(await countNotif(uid, 'milestone-first-payment') === 0, 'no payment, no milestone');

    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at)
      VALUES (${ws}, 'PAID-1', ${realCli}, 'Real Rita',
              ${JSON.stringify([{ description: 'x', quantity: 1, rate: 100 }])}::jsonb, 'paid', NOW())`;
    await celebrateFirstPayment(ws);
    assert(await countNotif(uid, 'milestone-first-payment') === 1, 'first paid invoice fires the milestone');

    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at)
      VALUES (${ws}, 'PAID-2', ${realCli}, 'Real Rita',
              ${JSON.stringify([{ description: 'y', quantity: 1, rate: 50 }])}::jsonb, 'paid', NOW())`;
    await celebrateFirstPayment(ws);
    assert(await countNotif(uid, 'milestone-first-payment') === 1, 'second payment does not re-fire');

    // Cleanup
    await sql`DELETE FROM notifications WHERE user_id = ${uid}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM bookings WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    await sql`DELETE FROM users WHERE id = ${uid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

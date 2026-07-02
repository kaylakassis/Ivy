// Tests api/_lib/ivy.js buildBriefing(): the proactive "here's your day"
// data Ivy greets the owner with. Covers the calm empty state (brand-new
// workspace → no items) and a populated day (today's booking + a sent
// invoice + a quiet client → three prioritized items with correct counts).
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/ivy-briefing.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { buildBriefing } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `brief-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;

    console.log('\n[1] empty workspace → calm, no items');
    const b0 = await buildBriefing(ws);
    assert(b0.todaySessions === 0, `todaySessions 0 (got ${b0.todaySessions})`);
    assert(b0.overdueInvoices === 0, `overdueInvoices 0 (got ${b0.overdueInvoices})`);
    assert(b0.quietClients === 0, `quietClients 0 (got ${b0.quietClients})`);
    assert(Array.isArray(b0.items) && b0.items.length === 0, `items empty (got ${b0.items.length})`);

    console.log('\n[2] populated day → three prioritized items');
    // Give the business a name so the greeting can address it.
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug)
      VALUES (${ws}, 'Bright & Co.', ${`${tag}-slug`})`;
    const cA = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws}, 'Booking Bob', ${`${tag}-a@example.com`}, 'active') RETURNING id`).rows[0].id;
    // Second active client, no messages → counts toward "gone quiet".
    await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws}, 'Quiet Quinn', ${`${tag}-b@example.com`}, 'active')`;
    // A booking today for Bob (09:00–10:00).
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${cA}, 'Booking Bob', ${`${tag}-a@example.com`}, CURRENT_DATE, 540, 600)`;
    // A sent invoice for 150 (trigger computes total from items).
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
      VALUES (${ws}, 'INV-BRIEF', ${cA}, 'Booking Bob',
              ${JSON.stringify([{ description: 'Session', quantity: 1, rate: 150 }])}::jsonb, 'sent')`;

    const b1 = await buildBriefing(ws);
    assert(b1.bizName === 'Bright & Co.', `bizName carried (got ${b1.bizName})`);
    assert(b1.todaySessions === 1, `todaySessions 1 (got ${b1.todaySessions})`);
    assert(b1.overdueInvoices === 1, `overdueInvoices 1 (got ${b1.overdueInvoices})`);
    assert(Number(b1.overdueTotal) === 150, `overdueTotal 150 (got ${b1.overdueTotal})`);
    assert(b1.quietClients === 2, `quietClients 2 (both active, no messages) (got ${b1.quietClients})`);
    assert(b1.items.length === 3, `three items (got ${b1.items.length})`);
    const icons = b1.items.map((i) => i.icon);
    assert(icons[0] === 'Calendar', `calendar item first (got ${icons[0]})`);
    assert(icons.includes('Dollar'), 'has a money item');
    assert(icons.includes('Chat'), 'has a re-engage item');
    assert(b1.items.every((i) => typeof i.prompt === 'string' && i.prompt.length > 0), 'every item carries a tappable prompt');
    // The calendar line names the earliest session's time + client.
    assert(/9:00am/.test(b1.items[0].text) && /Booking Bob/.test(b1.items[0].text),
      `calendar line shows time + client (got "${b1.items[0].text}")`);

    // Cleanup
    await sql`DELETE FROM invoices WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM bookings WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM calendar_settings WHERE workspace_id = ${ws}`;
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

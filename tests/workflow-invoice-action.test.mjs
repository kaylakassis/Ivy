// The create_invoice workflow action: validates, and — when a client_created
// workflow fires — DRAFTS an invoice for that client (never sends), with tokens
// rendered in line descriptions and a canonical INV-<n> number. Also covers the
// shared createDraftInvoice helper.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/workflow-invoice-action.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { validateWorkflowShape, triggerWorkflow } from '../api/_lib/workflows.js';
import { createDraftInvoice } from '../api/_lib/finance.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `wfinv-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws}, 'Rita', 'rita@example.com', 'active') RETURNING id`).rows[0].id;

    console.log('\n[1] validateWorkflowShape — create_invoice');
    const good = { name: 'x', triggerType: 'client_created', actions: [
      { type: 'create_invoice', config: { items: [{ description: 'Onboarding for {{clientName}}', quantity: 1, rate: 200 }], dueInDays: 7 } },
    ] };
    let threw = false; try { validateWorkflowShape(good); } catch { threw = true; }
    assert(!threw, 'valid create_invoice action passes validation');
    const emptyItems = { name: 'x', triggerType: 'client_created', actions: [{ type: 'create_invoice', config: { items: [] } }] };
    threw = false; try { validateWorkflowShape(emptyItems); } catch { threw = true; }
    assert(threw, 'empty items rejected');
    const badRate = { name: 'x', triggerType: 'client_created', actions: [{ type: 'create_invoice', config: { items: [{ description: 'a', rate: -5 }] } }] };
    threw = false; try { validateWorkflowShape(badRate); } catch { threw = true; }
    assert(threw, 'negative rate rejected');

    console.log('\n[2] createDraftInvoice helper');
    const inv = await createDraftInvoice({ workspaceId: ws, clientId: cid, clientName: 'Rita', items: [{ description: 'Fee', quantity: 2, rate: 50 }] });
    assert(/^INV-\d+$/.test(inv.number), `canonical number INV-<n> (got ${inv.number})`);
    const row = (await sql`SELECT status, total, items FROM invoices WHERE id = ${inv.id}`).rows[0];
    assert(row.status === 'draft', 'created as a draft');
    assert(Number(row.total) === 100, `total computed from items = 2*50 (got ${row.total})`);

    console.log('\n[3] client_created workflow fires create_invoice → drafts for the client');
    await sql`INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
      VALUES (${ws}, 'onboard', 'client_created',
              ${JSON.stringify([{ type: 'create_invoice', config: { items: [{ description: 'Onboarding for {{clientName}}', quantity: 1, rate: 200 }] } }])}::jsonb, TRUE)`;
    const before = Number((await sql`SELECT COUNT(*)::int AS n FROM invoices WHERE workspace_id = ${ws} AND client_id = ${cid}`).rows[0].n);
    await triggerWorkflow({ workspaceId: ws, triggerType: 'client_created', client: { id: cid, name: 'Rita', email: 'rita@example.com' } });
    const after = (await sql`SELECT status, items, total FROM invoices WHERE workspace_id = ${ws} AND client_id = ${cid} ORDER BY created_at DESC LIMIT 1`).rows[0];
    const nowN = Number((await sql`SELECT COUNT(*)::int AS n FROM invoices WHERE workspace_id = ${ws} AND client_id = ${cid}`).rows[0].n);
    assert(nowN === before + 1, 'workflow created exactly one new invoice');
    assert(after.status === 'draft', 'the workflow invoice is a DRAFT (never auto-sent)');
    assert(after.items[0].description === 'Onboarding for Rita', 'token {{clientName}} rendered in the line description');
    assert(Number(after.total) === 200, 'total reflects the fixed rate');

    // Cleanup
    await sql`DELETE FROM workflow_runs WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM workflows WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${ws}`;
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

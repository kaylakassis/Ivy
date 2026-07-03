// Tests api/_lib/workflowSuggest.js detectWorkflowSuggestion: finds a repeated
// new-client follow-up (invoice / document within 48h) over the last N clients,
// proposes a valid client_created workflow, and suppresses when already
// automated / dismissed / sample too small.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/workflow-suggest.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { detectWorkflowSuggestion } from '../api/_lib/workflowSuggest.js';
import { validateWorkflowShape } from '../api/_lib/workflows.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function newWorkspace(tag) {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  return { uid, ws };
}
// Add N clients, each with an invoice created right now (within the 48h window).
async function addClientsWithInvoices(ws, n, tag) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const cid = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${ws}, ${`C${i}`}, 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
      VALUES (${ws}, ${`${tag}-INV-${i}`}, ${cid}, ${`C${i}`}, '[]'::jsonb, 'draft')`;
    ids.push(cid);
  }
  return ids;
}

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `wfs-${Date.now()}`;

    console.log('\n[1] invoice habit → suggestion with a task reminder');
    const a = await newWorkspace(`${tag}-a`);
    const clientIds = await addClientsWithInvoices(a.ws, 6, tag);
    let s = await detectWorkflowSuggestion(a.ws);
    assert(!!s, 'suggestion returned when 6/6 new clients were invoiced');
    assert(s.signature === 'client_created:invoice', `signature is invoice (got ${s?.signature})`);
    assert(s.workflow.triggerType === 'client_created', 'trigger is client_created');
    assert(s.workflow.actions.some((x) => x.type === 'create_task' && /Send invoice/i.test(x.config.title)),
      'proposes a "Send invoice" task (no auto-billing)');
    // The proposal must be a valid workflow the create endpoint accepts.
    let threw = false; try { validateWorkflowShape(s.workflow); } catch { threw = true; }
    assert(!threw, 'proposed workflow passes validateWorkflowShape');

    console.log('\n[2] add a reused document template → send_document action');
    const tmplId = (await sql`INSERT INTO documents (workspace_id, name, is_template) VALUES (${a.ws}, 'Contract', TRUE) RETURNING id`).rows[0].id;
    for (const cid of clientIds.slice(0, 5)) {
      await sql`INSERT INTO documents (workspace_id, name, recipient_client_id, status, sent_at, template_id)
        VALUES (${a.ws}, 'Contract - C', ${cid}, 'sent', NOW(), ${tmplId})`;
    }
    s = await detectWorkflowSuggestion(a.ws);
    assert(s.signature === 'client_created:invoice+document', `signature includes document (got ${s?.signature})`);
    assert(s.workflow.actions.some((x) => x.type === 'send_document' && x.config.templateId === tmplId),
      'proposes send_document with the reused template id');

    console.log('\n[3] dismissed signature → null');
    s = await detectWorkflowSuggestion(a.ws, { dismissed: ['client_created:invoice+document'] });
    assert(s === null, 'a dismissed signature suppresses the suggestion');

    console.log('\n[4] suppressed once a client_created workflow exists');
    await sql`INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
      VALUES (${a.ws}, 'wf', 'client_created', ${JSON.stringify([{ type: 'create_task', config: { title: 't' } }])}::jsonb, TRUE)`;
    s = await detectWorkflowSuggestion(a.ws);
    assert(s === null, 'no suggestion when the owner already automates client_created');

    console.log('\n[5] too small a sample → null');
    const b = await newWorkspace(`${tag}-b`);
    await addClientsWithInvoices(b.ws, 3, `${tag}b`); // < SAMPLE_MIN (5)
    s = await detectWorkflowSuggestion(b.ws);
    assert(s === null, '3 clients is below the sample minimum');

    // Cleanup
    for (const w of [a, b]) {
      await sql`DELETE FROM workflows WHERE workspace_id = ${w.ws}`;
      await sql`DELETE FROM documents WHERE workspace_id = ${w.ws}`;
      await sql`DELETE FROM invoices WHERE workspace_id = ${w.ws}`;
      await sql`DELETE FROM clients WHERE workspace_id = ${w.ws}`;
      await sql`DELETE FROM workspaces WHERE id = ${w.ws}`;
      await sql`DELETE FROM users WHERE id = ${w.uid}`;
    }
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

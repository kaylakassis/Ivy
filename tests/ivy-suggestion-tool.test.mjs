// Surfacing a detected workflow suggestion inside Ivy chat:
//   • workspaceContext() carries a `workflowSuggestion` (signature + ID-free
//     action lines) that fmtCtx turns into a gentle nudge.
//   • create_suggested_workflow creates EXACTLY the detected automation, guards
//     a stale signature, and is suppressed once the workflow exists / is
//     dismissed.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-suggestion-tool.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { workspaceContext } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function newWorkspace(tag) {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  return { uid, ws };
}
async function addInvoicedClients(ws, n, tag) {
  for (let i = 0; i < n; i++) {
    const cid = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${ws}, ${`C${i}`}, 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
      VALUES (${ws}, ${`${tag}-INV-${i}`}, ${cid}, ${`C${i}`}, '[]'::jsonb, 'draft')`;
  }
}

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `ivysug-${Date.now()}`;

    console.log('\n[1] workspaceContext carries the suggestion (ID-free) for the nudge');
    const a = await newWorkspace(`${tag}-a`);
    await addInvoicedClients(a.ws, 6, tag);
    let ctx = await workspaceContext(a.ws);
    const sug = ctx.workflowSuggestion;
    assert(!!sug, 'ctx.workflowSuggestion is present when a habit is detected');
    assert(sug.signature === 'client_created:invoice', `carries the signature (got ${sug?.signature})`);
    assert(Array.isArray(sug.actions) && sug.actions.length >= 1, 'carries plain-English action lines');
    assert(sug.actions.every((x) => !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(x)), 'action lines leak no raw UUIDs');

    console.log('\n[2] stale signature → the tool declines');
    let r = await executeIvyTool('create_suggested_workflow', { signature: 'client_created:bogus' }, { workspaceId: a.ws });
    assert(r.created === false, 'a mismatched signature is not created');
    const wfCount0 = Number((await sql`SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = ${a.ws}`).rows[0].n);
    assert(wfCount0 === 0, 'nothing was written on the stale-signature call');

    console.log('\n[3] create_suggested_workflow creates exactly the detected automation');
    r = await executeIvyTool('create_suggested_workflow', { signature: sug.signature }, { workspaceId: a.ws });
    assert(r.created === true, 'created:true on agreement');
    assert(r.workflow?.trigger_type === 'client_created', 'creates the client_created workflow');
    const wf = (await sql`SELECT trigger_type, actions, enabled FROM workflows WHERE workspace_id = ${a.ws}`).rows[0];
    assert(!!wf && wf.enabled === true, 'a single enabled workflow row now exists');
    assert(wf.actions.some((x) => x.type === 'create_task' && /Send invoice/i.test(x.config.title)),
      'the created actions match the detector (Send invoice task, no auto-billing)');

    console.log('\n[4] suppressed once the workflow exists');
    ctx = await workspaceContext(a.ws);
    assert(ctx.workflowSuggestion === null, 'no more nudge after the automation is created');
    r = await executeIvyTool('create_suggested_workflow', {}, { workspaceId: a.ws });
    assert(r.created === false, 'the tool no longer creates a duplicate');

    console.log('\n[5] a dismissed signature is not surfaced or created');
    const b = await newWorkspace(`${tag}-b`);
    await addInvoicedClients(b.ws, 6, `${tag}b`);
    await sql`UPDATE users SET ui_prefs = ${JSON.stringify({ dismissedWorkflowSuggestions: ['client_created:invoice'] })}::jsonb WHERE id = ${b.uid}`;
    ctx = await workspaceContext(b.ws);
    assert(ctx.workflowSuggestion === null, 'dismissed → no nudge in context');
    r = await executeIvyTool('create_suggested_workflow', {}, { workspaceId: b.ws });
    assert(r.created === false, 'dismissed → the tool creates nothing');

    // Cleanup
    for (const w of [a, b]) {
      await sql`DELETE FROM workflows WHERE workspace_id = ${w.ws}`;
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

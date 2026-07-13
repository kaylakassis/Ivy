// Ivy durable memory (P4): remember / forget / list_memories tools, dedupe,
// injection into workspaceContext, and strict workspace isolation.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-memory.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { workspaceContext } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL = `ivy-mem-${Date.now()}@example.com`;
const EMAIL2 = `ivy-mem-other-${Date.now()}@example.com`;
let wsA, wsB;

async function run() {
  try {
    await ensureSchemaApplied();
    const oA = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL}, 'x', 'A') RETURNING id`).rows[0].id;
    wsA = (await sql`INSERT INTO workspaces (owner_id) VALUES (${oA}) RETURNING id`).rows[0].id;
    const oB = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL2}, 'x', 'B') RETURNING id`).rows[0].id;
    wsB = (await sql`INSERT INTO workspaces (owner_id) VALUES (${oB}) RETURNING id`).rows[0].id;

    console.log('\n[1] remember stores durable facts; exact dupes are skipped');
    const r1 = await executeIvyTool('remember', { fact: 'Raising rates to $150 in March' }, { workspaceId: wsA });
    assert(r1.remembered && /150/.test(r1.remembered), 'first fact remembered');
    await executeIvyTool('remember', { fact: 'Busy season is December' }, { workspaceId: wsA });
    await executeIvyTool('remember', { fact: 'Raising rates to $150 in March' }, { workspaceId: wsA }); // dupe
    const lm = await executeIvyTool('list_memories', {}, { workspaceId: wsA });
    assert(lm.memories.length === 2, `exactly 2 memories, dupe skipped (got ${lm.memories.length})`);

    console.log('\n[2] memories are injected into Ivy\'s live context');
    const ctx = await workspaceContext(wsA);
    assert(Array.isArray(ctx.memories) && ctx.memories.length === 2, 'context carries the 2 memories');
    assert(ctx.memories.some((m) => /150/.test(m.content)), 'the rates note is present in context');

    console.log('\n[3] isolation — another workspace sees nothing');
    const lmB = await executeIvyTool('list_memories', {}, { workspaceId: wsB });
    assert(lmB.memories.length === 0, 'other workspace has no memories');
    const ctxB = await workspaceContext(wsB);
    assert((ctxB.memories || []).length === 0, "other workspace's context has no memories");

    console.log('\n[4] forget removes matching notes, scoped to the workspace');
    // wsB tries to forget wsA's fact — must affect nothing in wsA.
    const fCross = await executeIvyTool('forget', { about: 'rates' }, { workspaceId: wsB });
    assert(fCross.forgot === 0, 'cross-workspace forget removes nothing');
    assert((await executeIvyTool('list_memories', {}, { workspaceId: wsA })).memories.length === 2, 'wsA still has 2');
    // wsA forgets its own.
    const f = await executeIvyTool('forget', { about: 'rates' }, { workspaceId: wsA });
    assert(f.forgot === 1, 'forgot the 1 matching note');
    const lm2 = await executeIvyTool('list_memories', {}, { workspaceId: wsA });
    assert(lm2.memories.length === 1 && /December/.test(lm2.memories[0]), 'only the non-matching note remains');
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

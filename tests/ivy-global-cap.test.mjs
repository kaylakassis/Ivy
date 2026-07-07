// Platform-wide Ivy spend ceiling: globalIvyCapStatus() sums today's ivy_usage
// across ALL workspaces and trips when it crosses the env-configured cap — a
// cost/abuse backstop on top of the per-workspace caps. Caps are read per-call
// (retunable without redeploy) and 0 disables the check.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-global-cap.test.mjs

// Start with generous caps so the fresh-cache first read isn't already tripped.
process.env.IVY_GLOBAL_DAILY_TOKEN_CAP = '999999999999';
process.env.IVY_GLOBAL_DAILY_REQUEST_CAP = '999999999999';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
const { globalIvyCapStatus } = await import('../api/_lib/ivy.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  let uid, ws;
  try {
    await ensureSchemaApplied();
    const tag = `ivycap-${Date.now()}`;
    uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    // Seed today's usage: 5,000 output tokens across 10 requests.
    await sql`INSERT INTO ivy_usage (workspace_id, day, model, output_tokens, request_count)
      VALUES (${ws}, CURRENT_DATE, 'test-model', 5000, 10)`;

    console.log('\n[1] under a high cap → not capped, but sums today usage');
    let s = await globalIvyCapStatus(); // first call → fresh read (includes the seed)
    assert(s.capped === false, 'not capped under a huge ceiling');
    assert(Number(s.outputTokens) >= 5000, `sums today output tokens (got ${s.outputTokens})`);
    assert(Number(s.requests) >= 10, `sums today request count (got ${s.requests})`);

    console.log('\n[2] a token cap below current usage → capped');
    process.env.IVY_GLOBAL_DAILY_TOKEN_CAP = '1';
    s = await globalIvyCapStatus();
    assert(s.capped === true && s.tokenCapped === true, 'trips the token ceiling');

    console.log('\n[3] a request cap below current usage → capped');
    process.env.IVY_GLOBAL_DAILY_TOKEN_CAP = '999999999999';
    process.env.IVY_GLOBAL_DAILY_REQUEST_CAP = '1';
    s = await globalIvyCapStatus();
    assert(s.capped === true && s.requestCapped === true, 'trips the request ceiling');

    console.log('\n[4] caps of 0 disable the check entirely');
    process.env.IVY_GLOBAL_DAILY_TOKEN_CAP = '0';
    process.env.IVY_GLOBAL_DAILY_REQUEST_CAP = '0';
    s = await globalIvyCapStatus();
    assert(s.capped === false, '0 caps → never capped regardless of usage');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (ws) await sql`DELETE FROM ivy_usage WHERE workspace_id = ${ws}`;
    if (ws) await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    if (uid) await sql`DELETE FROM users WHERE id = ${uid}`;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

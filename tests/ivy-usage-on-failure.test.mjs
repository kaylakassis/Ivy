// A turn that fails after the AI service has already answered still counts
// against the workspace's caps. Before, usage was recorded only when a turn
// produced a reply: a turn whose model calls succeeded and then ended with no
// answer (or failed on a later call) spent real tokens that never reached
// ivy_usage, so the daily token cap, the 600-a-month allowance and the
// platform-wide ceiling never saw them and could be ridden around.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-usage-on-failure.test.mjs
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.IVY_MODEL = 'claude-opus-5-5';
process.env.IVY_FALLBACK_MODEL = '';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { generateReply, getDailyUsage } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Each /v1/messages call takes the next scripted step: { tool } → a tool_use
// turn, 'empty' → an end_turn with no text, a number → that HTTP error.
let script = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/v1/messages')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : {};
  const step = script.shift();
  const msg = (content, stop) => new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 50 } }),
    { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  if (typeof step === 'number') {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Bad request' } }),
      { status: step, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  }
  if (step === 'empty') return msg([], 'end_turn');
  if (step && step.tool) return msg([{ type: 'tool_use', id: `tu_${Math.random()}`, name: step.tool, input: step.input || {} }], 'tool_use');
  return msg([{ type: 'text', text: 'All set.' }], 'end_turn');
};

const S = Date.now();
async function mkWorkspace(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ivy-usefail-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

async function run() {
  const made = [];
  try {
    await ensureSchemaApplied();

    console.log('\n[1] model calls succeed, then the turn ends with no answer');
    const A = await mkWorkspace('a'); made.push(A);
    script = [{ tool: 'list_clients' }, 'empty'];
    let r = await generateReply('Say nothing', { workspaceId: A.workspaceId }, [], A.workspaceId, null, A.userId);
    assert(r.failed === true, `the turn failed (${r.error})`);
    let u = await getDailyUsage(A.workspaceId);
    assert(u.inputTokens === 2000 && u.outputTokens === 100, `both calls' tokens are counted (${u.inputTokens} in / ${u.outputTokens} out)`);
    assert(u.requests === 1 && u.monthMessages === 1, `the message counts once toward the daily and monthly caps (${u.requests}, ${u.monthMessages})`);

    console.log('\n[2] a later call fails after an earlier one was answered');
    const B = await mkWorkspace('b'); made.push(B);
    script = [{ tool: 'list_clients' }, 400];
    r = await generateReply('List my clients', { workspaceId: B.workspaceId }, [], B.workspaceId, null, B.userId);
    assert(r.failed === true, `the turn failed (${r.error})`);
    u = await getDailyUsage(B.workspaceId);
    assert(u.inputTokens === 1000 && u.outputTokens === 50 && u.requests === 1, `the answered call is counted (${u.inputTokens} in, ${u.requests} request)`);

    console.log('\n[3] a turn the service refused outright costs nothing and counts nothing');
    const C = await mkWorkspace('c'); made.push(C);
    script = [400];
    r = await generateReply('Hello', { workspaceId: C.workspaceId }, [], C.workspaceId, null, C.userId);
    u = await getDailyUsage(C.workspaceId);
    assert(r.failed === true && u.requests === 0 && u.tokens === 0, `nothing recorded (${u.requests}, ${u.tokens})`);

    console.log('\n[4] a normal turn is still counted once');
    const D = await mkWorkspace('d'); made.push(D);
    script = [{ tool: 'list_clients' }, { text: 'ok' }];
    r = await generateReply('List my clients', { workspaceId: D.workspaceId }, [], D.workspaceId, null, D.userId);
    u = await getDailyUsage(D.workspaceId);
    assert(r.mode === 'live' && u.requests === 1 && u.inputTokens === 2000, `counted once (${u.requests}, ${u.inputTokens})`);
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const o of made) {
      await sql`DELETE FROM workspaces WHERE id = ${o.workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${o.userId}`.catch(() => {});
    }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

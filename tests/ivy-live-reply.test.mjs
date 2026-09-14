// The real reply path, end to end, with Anthropic stubbed at the network:
// generateReply must reach messages.create and come back mode 'live'.
// This is the test that would have caught "model is not defined" - a
// ReferenceError inside the reply loop that turned every chat into a
// canned answer while the key, the model and the readiness probe were
// all fine.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-live-reply.test.mjs
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.IVY_MODEL = 'claude-opus-5'; // pin: skips the models.list lookup

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { generateReply, workspaceContext } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Network stub: the SDK uses globalThis.fetch and expects a real Response.
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
  if (url.includes('/v1/messages')) {
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'Stubbed Claude says: your revenue this month is on the dashboard.' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 9 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

async function run() {
  await ensureSchemaApplied();
  const S = Date.now();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivy-live-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end) VALUES (${u.rows[0].id}, 'Live WS', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  const wsId = w.rows[0].id;
  const ctx = await workspaceContext(wsId);

  console.log('\n[1] a chat message reaches Claude and comes back live');
  const r = await generateReply('Where is my money coming from this month?', ctx, [], wsId);
  assert(r.mode === 'live', `mode is live (got ${r.mode}${r.error ? ': ' + r.error : ''})`);
  assert(/Stubbed Claude says/.test(r.text || ''), 'reply text is what Claude returned');
  const msgCall = calls.find((c) => c.url.includes('/v1/messages'));
  assert(!!msgCall, 'messages.create was called');
  assert(msgCall?.body?.model === 'claude-opus-5', `request names the model (got ${msgCall?.body?.model})`);
  assert(!/couldn't generate a full answer/.test(r.text || ''), 'no fallback wording');

  console.log('\n[2] usage was recorded for the day');
  const usage = await sql`SELECT request_count, output_tokens FROM ivy_usage WHERE workspace_id = ${wsId}`;
  assert(Number(usage.rows[0]?.request_count) === 1 && Number(usage.rows[0]?.output_tokens) === 9, `one request, 9 output tokens (got ${JSON.stringify(usage.rows[0])})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('ivy-live-reply test crashed:', e); process.exit(1); });

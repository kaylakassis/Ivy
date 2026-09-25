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
let nextStatus = 200;   // set to 500 to simulate a provider outage
let nextContent = null; // override the stubbed reply content
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
  if (url.includes('/v1/messages')) {
    if (nextStatus !== 200) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }),
        { status: nextStatus, headers: { 'content-type': 'application/json', 'request-id': 'req_fail' } });
    }
    if (nextContent) {
      const c = nextContent; nextContent = null;
      return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5', content: c.content, stop_reason: c.stop_reason || 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } }),
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
    }
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

  console.log('\n[3] messy history is cleaned before it reaches the model');
  calls.length = 0;
  const messy = [
    { role: 'me', text: 'first question' },
    { role: 'ivy', text: '' },                 // an empty reply must never be sent
    { role: 'me', text: 'second question' },   // two user turns in a row get merged
    { role: 'ivy', text: 'earlier answer' },
  ];
  const r3 = await generateReply('third question', ctx, messy, wsId);
  assert(r3.mode === 'live', `still live with messy history (got ${r3.mode}${r3.error ? ': ' + r3.error : ''})`);
  const sent = calls.find((c) => c.url.includes('/v1/messages'))?.body?.messages || [];
  assert(sent.every((m) => (typeof m.content === 'string' ? m.content.trim().length > 0 : m.content.length > 0)), 'no empty content blocks sent');
  assert(sent.every((m, i) => i === 0 || m.role !== sent[i - 1].role), 'roles alternate');
  assert(sent[0]?.role === 'user' && /first question[\s\S]*second question/.test(sent[0].content), 'the two user turns were merged into one');

  console.log('\n[4] a provider outage is reported honestly and recorded');
  nextStatus = 500;
  const r4 = await generateReply('anything', ctx, [], wsId);
  nextStatus = 200;
  assert(r4.mode === 'mock' && /hiccup/.test(r4.error || ''), `falls back with the hiccup reason (got ${r4.mode}: ${r4.error})`);
  assert(/couldn't put together an answer/.test(r4.text) && !/quick take from your numbers/.test(r4.text), 'says it could not answer, no canned advice dressed up as an answer');
  assert(/send that again|try again/i.test(r4.text), 'tells the owner what to do');
  const failRows = await sql`SELECT status, error_name, message FROM ivy_failures WHERE workspace_id = ${wsId} ORDER BY created_at DESC`;
  assert(failRows.rows.length === 1 && Number(failRows.rows[0].status) === 500, `one failure row with status 500 (got ${JSON.stringify(failRows.rows[0])})`);
  assert(/Internal server error/.test(failRows.rows[0]?.message || ''), "the provider's own message is kept for the operator");

  console.log('\n[5] a tool the model asks for that does not exist does not sink the reply');
  nextContent = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'no_such_tool', input: {} }] };
  const r5 = await generateReply('do the thing', ctx, [], wsId);
  assert(r5.mode === 'live', `live after an unknown tool call (got ${r5.mode}${r5.error ? ': ' + r5.error : ''})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('ivy-live-reply test crashed:', e); process.exit(1); });

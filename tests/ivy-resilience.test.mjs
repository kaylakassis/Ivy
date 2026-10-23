// Ivy keeps answering through provider wobbles: transient errors are
// retried, a dead primary model falls back to the fallback model, and only
// a request the provider rejects outright (400) gives up immediately.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-resilience.test.mjs
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.IVY_MODEL = 'claude-opus-5-5';
process.env.IVY_FALLBACK_MODEL = 'claude-sonnet-5-5';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { generateReply, workspaceContext } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Script the provider per call: each entry is a status (or 'drop' for a
// connection failure). Calls beyond the script succeed.
let script = [];
const calls = [];
const okBody = (model) => JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: `Answered by ${model}.` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/v1/messages')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : {};
  const step = script.shift();
  calls.push({ model: body.model, step });
  if (step === 'drop') throw new TypeError('fetch failed');
  if (typeof step === 'number' && step !== 200) {
    return new Response(JSON.stringify({ type: 'error', error: { type: step === 529 ? 'overloaded_error' : 'api_error', message: step === 529 ? 'Overloaded' : 'Internal server error' } }),
      { status: step, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  }
  return new Response(okBody(body.model), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
};

async function run() {
  await ensureSchemaApplied();
  const S = Date.now();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivy-res-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  const wsId = w.rows[0].id;
  const ctx = await workspaceContext(wsId);

  console.log('\n[1] one overloaded response is retried on the same model');
  script = [529]; calls.length = 0;
  let r = await generateReply('hi', ctx, [], wsId);
  assert(r.mode === 'live' && /Answered by claude-opus-5-5/.test(r.text), `live after a retry (${r.mode} ${r.error || ''})`);
  assert(calls.length === 2 && calls.every((c) => c.model === 'claude-opus-5-5'), 'two calls, both to the primary model');

  console.log('\n[2] a dropped connection is retried too');
  script = ['drop', 500]; calls.length = 0;
  r = await generateReply('hi again', ctx, [], wsId);
  assert(r.mode === 'live', `live after a drop and a 500 (${r.mode} ${r.error || ''})`);
  assert(calls.length === 3, 'three calls');

  console.log('\n[3] a primary model that keeps failing falls back');
  script = [500, 500, 500]; calls.length = 0;
  r = await generateReply('still there?', ctx, [], wsId);
  assert(r.mode === 'live' && /Answered by claude-sonnet-5-5/.test(r.text), `answered by the fallback model (${r.mode} ${r.error || ''})`);
  assert(calls.slice(0, 3).every((c) => c.model === 'claude-opus-5-5') && calls[3]?.model === 'claude-sonnet-5-5', 'three primary attempts, then the fallback');
  const used = (await sql`SELECT model, request_count FROM ivy_usage WHERE workspace_id = ${wsId} ORDER BY model`).rows;
  assert(used.some((x) => x.model === 'claude-sonnet-5-5'), 'usage recorded against the model that answered');

  console.log('\n[4] a 400 is not retried and is reported honestly');
  script = [400]; calls.length = 0;
  r = await generateReply('bad', ctx, [], wsId);
  assert(r.mode === 'mock' && /rejected/.test(r.error || ''), `400 → rejected (${r.error})`);
  assert(calls.length === 1, 'no retry on a 400');

  console.log('\n[5] everything down → one honest fallback message, no crash');
  script = [500, 500, 500, 500, 500, 500]; calls.length = 0;
  r = await generateReply('anyone?', ctx, [], wsId);
  assert(r.mode === 'mock' && /hiccup/.test(r.error || ''), `all attempts failed → hiccup (${r.error})`);
  assert(calls.length === 6, 'three attempts per model');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

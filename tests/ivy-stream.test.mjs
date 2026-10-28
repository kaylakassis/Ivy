// Ivy's streamed reply (POST /api/ivy/stream): the model's text reaches the
// client chunk by chunk as Server-Sent Events, and everything around it still
// happens exactly once and exactly as on the plain endpoint - allowance and
// cap checks before any provider call, retries for transient failures before
// the first chunk, no retry on a 400, usage recorded, the turn saved once.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-stream.test.mjs
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.IVY_MODEL = 'claude-sonnet-5-5'; // pin: skips the models.list lookup
process.env.IVY_FALLBACK_MODEL = '';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import handler from '../api/ivy/stream.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Provider stub ─────────────────────────────────────────────────────────
// The SDK's streaming call POSTs { stream: true } and reads text/event-stream
// from response.body. Each scripted step answers one provider call:
//   a number    → that HTTP status (529 overloaded, 500, 400 ...)
//   'drop'      → the connection fails before any response
//   'midfail'   → a stream that sends some text, then dies
//   { chunks, toolUse } → a normal stream of those text chunks; with toolUse
//                 the turn ends asking for a tool (so the text is a preamble)
// Steps beyond the script are a normal stream of DEFAULT_CHUNKS.
const DEFAULT_CHUNKS = ['Your ', 'revenue is ', '**$4,200**', ' this month.'];
let script = [];
const calls = [];

const enc = new TextEncoder();
const frame = (ev) => enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
function turnFrames(model, chunks, { toolUse = false } = {}) {
  const out = [
    { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...chunks.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
  ];
  if (toolUse) {
    out.push(
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'no_such_tool', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
    );
  }
  out.push(
    { type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  );
  return out;
}
function sseBody(frames, { dieAfter = Infinity } = {}) {
  return new ReadableStream({
    async start(controller) {
      let sent = 0;
      for (const ev of frames) {
        if (sent >= dieAfter) { controller.error(new Error('socket hang up')); return; }
        controller.enqueue(frame(ev));
        sent++;
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
}
const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req' };
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.includes('/v1/messages')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : {};
  const step = script.shift();
  calls.push({ model: body.model, stream: body.stream === true, step });
  if (step === 'drop') throw new TypeError('fetch failed');
  if (typeof step === 'number' && step !== 200) {
    return new Response(JSON.stringify({ type: 'error', error: { type: step === 529 ? 'overloaded_error' : step === 400 ? 'invalid_request_error' : 'api_error', message: step === 529 ? 'Overloaded' : step === 400 ? 'messages: bad shape' : 'Internal server error' } }),
      { status: step, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  }
  if (body.stream !== true) {
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: DEFAULT_CHUNKS.join('') }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  }
  if (step === 'midfail') {
    // message_start, block start, two deltas, then the socket dies.
    return new Response(sseBody(turnFrames(body.model, ['Half an ', 'answer and then ', 'nothing.']), { dieAfter: 4 }), { status: 200, headers: SSE_HEADERS });
  }
  const spec = step && typeof step === 'object' ? step : { chunks: DEFAULT_CHUNKS };
  return new Response(sseBody(turnFrames(body.model, spec.chunks || DEFAULT_CHUNKS, spec)), { status: 200, headers: SSE_HEADERS });
};

// ── Request / response doubles for the handler ────────────────────────────
function makeRes() {
  const chunks = [];
  return {
    statusCode: 200, headers: {}, body: undefined, chunks, ended: false, flushed: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    flushHeaders() { this.flushed = true; },
    write(s) { chunks.push(String(s)); return true; },
    json(o) { this.body = o; return this; },
    end(s) { if (s) chunks.push(String(s)); this.ended = true; return this; },
  };
}
let ipN = 0;
function makeReq(userId, body) {
  ipN++;
  return {
    method: 'POST', url: '/api/ivy/stream', query: {}, body, on() {},
    headers: {
      cookie: `ivy_session=${signSession(userId)}`,
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${(ipN % 200) + 10}`,
    },
  };
}
// Parse what the handler wrote back into [{ event, data }], ignoring the
// ": connected" / ": ping" comments.
function events(res) {
  const out = [];
  for (const raw of res.chunks.join('').split(/\n\n/)) {
    let event = 'message'; const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line[0] === ':') continue;
      const i = line.indexOf(':');
      const field = line.slice(0, i); const value = line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value; else if (field === 'data') data.push(value);
    }
    if (data.length) out.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return out;
}
const deltasText = (evs) => evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
const terminal = (evs) => evs.find((e) => e.event === 'done' || e.event === 'error');
async function send(userId, body) {
  const res = makeRes();
  await handler(makeReq(userId, body), res);
  return { res, evs: events(res) };
}

async function run() {
  await ensureSchemaApplied();
  const S = Date.now();
  async function owner(tag) {
    const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivy-stream-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
    const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
    return { userId: u.rows[0].id, wsId: w.rows[0].id };
  }
  const a = await owner('a');

  console.log('\n[1] the reply streams: deltas in order, then done with the saved turn');
  script = []; calls.length = 0;
  let { res, evs } = await send(a.userId, { text: 'How is revenue?' });
  assert(res.statusCode === 200 && /text\/event-stream/.test(res.headers['content-type'] || ''), `SSE response (${res.statusCode} ${res.headers['content-type']})`);
  assert(res.flushed && res.ended, 'headers flushed up front, response ended');
  assert(calls.length === 1 && calls[0].stream === true && calls[0].model === 'claude-sonnet-5-5', `one streaming provider call on the pinned model (${JSON.stringify(calls)})`);
  const deltas = evs.filter((e) => e.event === 'delta').map((e) => e.data.text);
  assert(deltas.length >= 2, `several deltas arrived (${deltas.length})`);
  let done = terminal(evs);
  assert(done?.event === 'done', `terminal event is done (${done?.event})`);
  assert(evs.indexOf(done) === evs.length - 1 && evs.slice(0, -1).every((e) => e.event === 'delta'), 'every delta comes before done, nothing after');
  const ivyText = done?.data?.messages?.[1]?.text;
  assert(deltas.join('') === ivyText, `deltas concatenate to the final text ("${deltas.join('')}" vs "${ivyText}")`);
  assert(ivyText === DEFAULT_CHUNKS.join(''), 'final text is what the model wrote');
  assert(done.data.mode === 'live' && done.data.modeError === null, 'done says live');
  assert(done.data.session?.id && done.data.messages?.length === 2 && done.data.messages[0].role === 'me' && done.data.messages[1].role === 'ivy', 'done carries the session and both turns, like POST /api/ivy');
  assert(done.data.usage && done.data.usage.monthMessages === 1 && done.data.usage.requests === 1, `done carries usage with this message counted (${JSON.stringify(done.data.usage)})`);
  const sessionId = done.data.session.id;
  const rows = await sql`SELECT role FROM ivy_messages WHERE session_id = ${sessionId} ORDER BY created_at`;
  assert(rows.rows.length === 2 && rows.rows.filter((r) => r.role === 'ivy').length === 1, `the turn is saved once (${rows.rows.map((r) => r.role).join(',')})`);
  const usage = await sql`SELECT request_count, output_tokens FROM ivy_usage WHERE workspace_id = ${a.wsId}`;
  assert(usage.rows.length === 1 && Number(usage.rows[0].request_count) === 1 && Number(usage.rows[0].output_tokens) === 5, `usage recorded once, with the stream's token counts (${JSON.stringify(usage.rows[0])})`);
  assert(!/^\s*model:/m.test(JSON.stringify(done.data)) && !/claude|anthropic/i.test(res.chunks.join('')), 'nothing on the wire names the model or the provider');

  console.log('\n[2] a dash split across chunks is normalised the same way the final text is');
  script = [{ chunks: ['Revenue is up ', '—', ' nice work', '—', 'keep going.'] }]; calls.length = 0;
  ({ res, evs } = await send(a.userId, { text: 'dashes', sessionId }));
  done = terminal(evs);
  assert(done?.event === 'done' && done.data.messages[1].text === 'Revenue is up, nice work-keep going.', `final text sanitised (${done?.data?.messages?.[1]?.text})`);
  assert(deltasText(evs) === done.data.messages[1].text, `streamed text matches it ("${deltasText(evs)}")`);

  console.log('\n[3] a transient failure before the first delta is retried');
  script = [529]; calls.length = 0;
  ({ res, evs } = await send(a.userId, { text: 'again please', sessionId }));
  done = terminal(evs);
  assert(calls.length === 2 && calls.every((c) => c.stream), `two streaming attempts (${calls.length})`);
  assert(done?.event === 'done' && done.data.mode === 'live' && deltasText(evs) === done.data.messages[1].text, `live after the retry (${done?.event} ${done?.data?.modeError || ''})`);
  script = ['drop']; calls.length = 0;
  ({ res, evs } = await send(a.userId, { text: 'and a drop', sessionId }));
  done = terminal(evs);
  assert(calls.length === 2 && done?.event === 'done' && done.data.mode === 'live', `a dropped connection is retried too (${calls.length} calls, ${done?.event})`);

  console.log('\n[4] a 400 is not retried and is reported honestly as an error event');
  script = [400]; calls.length = 0;
  ({ res, evs } = await send(a.userId, { text: 'bad', sessionId }));
  const err = terminal(evs);
  assert(calls.length === 1, `exactly one provider call (${calls.length})`);
  assert(err?.event === 'error', `terminal event is error (${err?.event})`);
  assert(/rejected/.test(err?.data?.message || '') && /couldn't put together an answer/.test(err?.data?.message || ''), `the honest line (${err?.data?.message})`);
  assert(err?.data?.mode === 'mock' && /rejected/.test(err?.data?.modeError || ''), 'mode and reason match the plain endpoint');
  assert(Array.isArray(err?.data?.messages) && err.data.messages[1]?.text === err.data.message, 'the saved Ivy message is the same honest line, so the chat ends up identical');
  assert(!evs.some((e) => e.event === 'delta'), 'no text was streamed before the error');
  assert(!/claude|anthropic/i.test(res.chunks.join('')), 'the error never names the provider');

  console.log('\n[5] a failure after text has streamed is reported, not retried');
  script = ['midfail']; calls.length = 0;
  ({ res, evs } = await send(a.userId, { text: 'tell me more', sessionId }));
  const mid = terminal(evs);
  assert(evs.some((e) => e.event === 'delta') && deltasText(evs).startsWith('Half an answer'), `some text went out first ("${deltasText(evs)}")`);
  assert(calls.length === 1, `no second attempt after text was shown (${calls.length})`);
  assert(mid?.event === 'error' && /hiccup/.test(mid?.data?.message || ''), `error event with the hiccup line (${mid?.data?.message})`);
  assert(mid?.data?.messages?.[1]?.text === mid?.data?.message, 'the honest line was saved as the reply');
  const failures = await sql`SELECT COUNT(*)::int AS n FROM ivy_failures WHERE workspace_id = ${a.wsId}`;
  assert(failures.rows[0].n === 2, `both failures recorded for the readiness page (${failures.rows[0].n})`);

  console.log('\n[6] a tool turn: its preamble is withdrawn with reset; the final turn is the reply');
  script = [{ chunks: ['Let me check.'], toolUse: true }, { chunks: ['Done: ', 'all good.'] }]; calls.length = 0;
  ({ res, evs } = await send(a.userId, { text: 'check my dashboard', sessionId }));
  done = terminal(evs);
  const kinds = evs.map((e) => e.event);
  const lastReset = kinds.lastIndexOf('reset');
  assert(calls.length === 2, `two turns (${calls.length})`);
  assert(lastReset > 0 && kinds.slice(0, lastReset).includes('delta'), `the preamble streamed, then reset (${kinds.join(' ')})`);
  const afterReset = evs.slice(lastReset + 1).filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert(done?.event === 'done' && done.data.messages[1].text === 'Done: all good.' && afterReset === done.data.messages[1].text, `text after the reset is the final reply ("${afterReset}")`);
  const u6 = await sql`SELECT request_count, output_tokens FROM ivy_usage WHERE workspace_id = ${a.wsId}`;
  // Five live replies so far ([1], [2], two in [3], [6]); the two failures
  // recorded nothing. Two provider calls here still count as one message.
  assert(Number(u6.rows[0].request_count) === 5, `usage counts owner messages answered live, not provider calls (${u6.rows[0].request_count})`);

  console.log('\n[7] the monthly allowance notice comes back without any provider call');
  const b = await owner('b');
  await sql`INSERT INTO ivy_usage (workspace_id, day, model, request_count, output_tokens) VALUES (${b.wsId}, CURRENT_DATE, 'test-model', 600, 10)`;
  script = []; calls.length = 0;
  ({ res, evs } = await send(b.userId, { text: 'one more?' }));
  done = terminal(evs);
  assert(calls.length === 0, 'no provider call');
  assert(done?.event === 'done' && done.data.mode === 'mock' && done.data.modeError === 'monthly-allowance', `done with the allowance reason (${done?.event} ${done?.data?.modeError})`);
  assert(/all 600 Ivy messages/.test(done?.data?.messages?.[1]?.text || ''), 'the notice is the reply');
  assert(!evs.some((e) => e.event === 'delta'), 'nothing was streamed');
  assert(done.data.usage?.monthMessages === 600, 'usage returned for the meter');

  console.log('\n[8] a bad request is a plain 400 before the stream starts');
  ({ res, evs } = await send(a.userId, { text: '' }));
  assert(res.statusCode === 400 && res.body?.error === 'Message is required' && res.chunks.length === 0, `400 JSON, no SSE (${res.statusCode} ${JSON.stringify(res.body)})`);
  ({ res } = await send(a.userId, { text: 'x', sessionId: '00000000-0000-0000-0000-000000000000' }));
  assert(res.statusCode === 400 && res.body?.error === 'Unknown session', `unknown session is a 400 (${res.statusCode} ${JSON.stringify(res.body)})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

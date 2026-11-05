// Ivy never misreports what she did, and never resets the weekly schedule as
// a side effect of a smaller change.
//
//   Ledger (what the tools actually did, recorded by the server):
//   • a write succeeds and then the AI service fails: the reply lists the
//     completed action and never says it failed or that nothing happened;
//   • a write succeeds and the model writes no final answer: the reply is
//     built from the ledger;
//   • the ledger is stored on the Ivy message, returned to the client and
//     appears in the next turn's history as the server log note;
//   • a gated tool is reported as waiting for approval, never as done;
//   • a failing tool is reported as failed with its reason;
//   • the history is the NEWEST messages of a long chat, not the oldest.
//   adjust_availability: Tuesday 1-2 pm closed leaves every other day
//   identical and splits Tuesday; opening merges; closing a whole day;
//   invalid input is refused before any card; nothing is written before
//   approval; another workspace cannot approve it or be touched; it applies
//   to the schedule as it is at approval time.
//   set_availability: refused without replace_all once onboarded (allowed in
//   first-time setup), works with it; a pending row stored before
//   replace_all existed still runs on approval.
//   Secondary failures: an invoice that is marked sent while its email fails
//   comes back ok with a warning, and the approval message says both.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-truth.test.mjs
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.IVY_MODEL = 'claude-opus-5-5';
process.env.IVY_FALLBACK_MODEL = '';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { generateReply, workspaceContext, buildMessages } from '../api/_lib/ivy.js';
import { beginTurn, finishTurn } from '../api/_lib/ivyTurn.js';
import { executeIvyTool, runApprovedTool, ledgerEntry, SENSITIVE_TOOLS, IVY_TOOLS } from '../api/_lib/ivyTools.js';
import { ledgerReply, ledgerFailureReply, ledgerHistoryNote } from '../api/_lib/ivyLedger.js';
import { applyAvailabilityChanges, parseAvailabilityChanges } from '../api/_lib/availabilityEdit.js';
import { findSavedReply, pickNewSession, recoverTurn } from '../src/features/ivy/recover.js';
import approve from '../api/ivy/approve.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Provider + email stubs ────────────────────────────────────────────────
// Each /v1/messages call takes the next scripted step:
//   { tool, input }  → a tool_use turn
//   { text }         → a final answer
//   'empty'          → an end_turn with no text at all
//   500              → a provider error (retried, so script it 3 times)
let script = [];
const modelCalls = [];
let resendStatus = 200;
const emails = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.resend.com')) {
    emails.push(init.body ? JSON.parse(init.body) : null);
    if (resendStatus !== 200) {
      return new Response(JSON.stringify({ name: 'application_error', message: 'Resend is down' }), { status: resendStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'email_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (!url.includes('/v1/messages')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  const body = init.body ? JSON.parse(init.body) : {};
  modelCalls.push(body);
  const step = script.shift();
  const msg = (content, stop) => new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }),
    { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  if (typeof step === 'number') {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }),
      { status: step, headers: { 'content-type': 'application/json', 'request-id': 'req' } });
  }
  if (step === 'empty') return msg([], 'end_turn');
  if (step && step.tool) return msg([{ type: 'tool_use', id: `tu_${modelCalls.length}`, name: step.tool, input: step.input || {} }], 'tool_use');
  return msg([{ type: 'text', text: step?.text || 'All set.' }], 'end_turn');
};

// ── Request doubles for the approve endpoint ─────────────────────────────
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
const approveCall = async ({ id, userId, method = 'POST' }) => {
  const r = mockRes();
  await approve({ method, url: '/api/ivy/approve', query: {}, body: { id },
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': '203.0.113.91', cookie: `ivy_session=${signSession(userId)}` } }, r);
  return r;
};

const S = Date.now();
async function mkOwner(tag, { onboarded = true } = {}) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ivy-truth-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = onboarded
    ? await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
        VALUES (${u.rows[0].id}, 'Truth WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`
    : await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
        VALUES (${u.rows[0].id}, 'Truth WS', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${w.rows[0].id}, 'Biz', ${`truth-${tag}-${S}`})`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}
const avail = async (wsId) => (await sql`SELECT availability FROM calendar_settings WHERE workspace_id = ${wsId}`).rows[0].availability;
const pendingCount = async (wsId) => Number((await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${wsId}`).rows[0].n);
const NINE_FIVE = [{ start: 540, end: 1020 }];
// jsonb reorders object keys, so compare windows as [start, end] pairs.
const W = (wins) => JSON.stringify((wins || []).map((w) => [w.start, w.end]));
const sameWeek = (a, b) => [0, 1, 2, 3, 4, 5, 6].every((d) => W(a?.[String(d)] ?? a?.[d]) === W(b?.[String(d)] ?? b?.[d]));
const WEEK = { 0: [], 1: NINE_FIVE, 2: NINE_FIVE, 3: NINE_FIVE, 4: NINE_FIVE, 5: [{ start: 540, end: 840 }], 6: [] };

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('a');
  const B = await mkOwner('b');
  const ctxA = await workspaceContext(A.workspaceId);

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[1] a write succeeds, then the AI service fails: the reply lists what was done');
  const task1 = `Call the landlord ${S}`;
  script = [{ tool: 'create_task', input: { title: task1 } }, 500, 500, 500];
  let turn = await beginTurn({ text: 'Add a task to call the landlord' }, A.workspaceId);
  let r = await generateReply(turn.text, { ...turn.ctx, sessionId: turn.session.id }, turn.history, A.workspaceId, null, A.userId);
  const taskRows = (await sql`SELECT id FROM tasks WHERE workspace_id = ${A.workspaceId} AND title = ${task1}`).rows;
  assert(taskRows.length === 1, 'the task really was created');
  assert(r.failed === true, 'the provider failure is still flagged');
  assert(r.text.includes(`Added the task "${task1}"`), `reply lists the completed action (${r.text.slice(0, 120)}...)`);
  assert(/Before that I already did/.test(r.text), 'reply says it was already done');
  assert(!/couldn't put together an answer|nothing was changed\.|didn't work|failed/i.test(r.text.replace('Nothing else was changed.', '')), 'reply never says it failed or that nothing happened');
  assert(/rather than sending the whole request again/.test(r.text), 'reply warns against resending it (would do it twice)');
  assert(Array.isArray(r.actions) && r.actions[0]?.status === 'done' && r.actions[0]?.tool === 'create_task', 'reply carries the ledger');

  console.log('\n[2] the ledger is stored on the message, returned, and fed to the next turn');
  let payload = await finishTurn({ ...turn, reply: r, workspaceId: A.workspaceId });
  const ivyMsg = payload.messages[1];
  assert(ivyMsg.role === 'ivy' && ivyMsg.actions?.[0]?.status === 'done', 'the Ivy message in the response has actions');
  assert(typeof ivyMsg.text === 'string' && ivyMsg.id && ivyMsg.createdAt, 'existing message fields are all still there');
  const stored = (await sql`SELECT actions FROM ivy_messages WHERE id = ${ivyMsg.id}`).rows[0].actions;
  assert(Array.isArray(stored) && stored[0].summary.includes(task1), 'ivy_messages.actions persisted');
  script = [{ text: 'Yes, I added it earlier.' }];
  modelCalls.length = 0;
  const turn2 = await beginTurn({ text: 'Did you add that task?', sessionId: turn.session.id }, A.workspaceId);
  assert(turn2.history.some((h) => h.role === 'ivy' && h.actions?.[0]?.status === 'done'), 'beginTurn history carries the actions');
  r = await generateReply(turn2.text, { ...turn2.ctx, sessionId: turn2.session.id }, turn2.history, A.workspaceId, null, A.userId);
  const sentHistory = JSON.stringify(modelCalls[0]?.messages || []);
  assert(sentHistory.includes('[What Ivy actually did this turn (from the server log): DONE: Added the task'), 'the next model call sees the server log note');
  await finishTurn({ ...turn2, reply: r, workspaceId: A.workspaceId });
  const noActions = (await sql`SELECT actions FROM ivy_messages WHERE session_id = ${turn.session.id} AND role = 'ivy' ORDER BY created_at DESC LIMIT 1`).rows[0].actions;
  assert(noActions === null, 'a turn with no tool actions stores NULL (old rows keep working)');

  console.log('\n[3] a write succeeds and the model writes no final answer: the reply comes from the ledger');
  const task3 = `Order supplies ${S}`;
  script = [{ tool: 'create_task', input: { title: task3 } }, 'empty'];
  r = await generateReply('Add a task to order supplies', ctxA, [], A.workspaceId, null, A.userId);
  assert(r.mode === 'live' && !r.failed, `no error (mode ${r.mode})`);
  assert(/^Done:/.test(r.text) && r.text.includes(task3), `reply is built from the ledger (${r.text})`);

  console.log('\n[4] a gated tool is reported as waiting for approval, never as done');
  script = [{ tool: 'block_calendar_time', input: { date: '2099-03-10', start_min: 780, end_min: 840 } }, 500, 500, 500];
  r = await generateReply('Block 1 to 2 on March 10 2099', { ...ctxA, sessionId: turn.session.id }, [], A.workspaceId, null, A.userId);
  assert(r.actions?.[0]?.status === 'waiting', 'ledger says waiting');
  assert(/Waiting for you to tap Approve/.test(r.text) && /Nothing has been changed yet/.test(r.text), `reply says it is waiting (${r.text.slice(0, 100)})`);
  assert(!/^Done|already did/.test(r.text), 'reply does not claim it was done');
  assert(Array.isArray(r.pendingActions) && r.pendingActions.length === 1 && r.pendingActions[0].id, 'the approval card still reaches the client after the failure');
  const blocks = (await sql`SELECT COUNT(*)::int AS n FROM calendar_blocks WHERE workspace_id = ${A.workspaceId} AND date = '2099-03-10'`).rows[0].n;
  assert(blocks === 0, 'nothing was blocked');

  console.log('\n[5] a failing tool is reported as failed with its reason');
  script = [{ tool: 'create_booking', input: { client_id: '00000000-0000-0000-0000-000000000000', date: '2099-01-01', start_min: 600, end_min: 660 } }, 'empty'];
  r = await generateReply('Book that client', ctxA, [], A.workspaceId, null, A.userId);
  assert(r.actions?.[0]?.status === 'failed' && /Unknown client/.test(r.actions[0].error), 'ledger says failed with the reason');
  assert(/Didn't work:/.test(r.text) && /Unknown client/.test(r.text) && /Nothing was changed/.test(r.text), `reply quotes the reason (${r.text})`);

  console.log('\n[6] reads are not listed; ledger words');
  assert(ledgerEntry('list_clients', {}, { clients: [] }) === null, 'a read makes no ledger entry');
  assert(ledgerEntry('get_availability', {}, {}) === null, 'get_availability is a read');
  assert(ledgerFailureReply([], 'hiccup') === null && ledgerReply([]) === null, 'empty ledger → no special reply');
  const note = ledgerHistoryNote(Array.from({ length: 30 }, (_, i) => ({ tool: 'create_task', status: 'done', summary: `Added the task "number ${i} with a fairly long title to fill the note"` })), 500);
  assert(note.length <= 500 && /and more\]$/.test(note), `history note stays inside its budget (${note.length})`);

  console.log('\n[7] a long chat feeds the model its NEWEST messages');
  const long = (await sql`INSERT INTO ivy_sessions (workspace_id, title) VALUES (${A.workspaceId}, 'Long chat') RETURNING id`).rows[0].id;
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO ivy_messages (session_id, role, text, created_at) VALUES (${long}, ${i % 2 ? 'ivy' : 'me'}, ${`msg ${i}`}, NOW() - ${`${100 - i} seconds`}::interval)`;
  }
  const t7 = await beginTurn({ text: 'and now?', sessionId: long }, A.workspaceId);
  assert(t7.history.length === 40 && t7.history[t7.history.length - 1].text === 'msg 49' && t7.history[0].text === 'msg 10', `history is the last 40, oldest first (${t7.history[0]?.text} .. ${t7.history.at(-1)?.text})`);
  const built = buildMessages('and now?', ctxA, t7.history, null);
  assert(JSON.stringify(built).includes('msg 49'), 'the newest message reaches the model');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[8] adjust_availability (pure): close Tuesday 1-2 pm, open merges, close a whole day');
  let p = parseAvailabilityChanges({ changes: [{ day: 'tuesday', action: 'close', start_min: 780, end_min: 840 }] });
  let out = applyAvailabilityChanges(WEEK, p.changes);
  assert(JSON.stringify(out.value['2']) === JSON.stringify([{ start: 540, end: 780 }, { start: 840, end: 1020 }]), 'Tuesday split into 9-1 and 2-5');
  assert([0, 1, 3, 4, 5, 6].every((d) => JSON.stringify(out.value[String(d)]) === JSON.stringify(WEEK[d])), 'every other day identical');
  p = parseAvailabilityChanges({ changes: [{ day: 2, action: 'open', start_min: 700, end_min: 900 }, { day: 'sat', action: 'open', start_min: 600, end_min: 840 }] });
  out = applyAvailabilityChanges(out.value, p.changes);
  assert(JSON.stringify(out.value['2']) === JSON.stringify([{ start: 540, end: 1020 }]), 'opening 11:40-3 merges back to 9-5');
  assert(JSON.stringify(out.value['6']) === JSON.stringify([{ start: 600, end: 840 }]), 'Saturday opened 10-2');
  p = parseAvailabilityChanges({ changes: [{ day: 'friday', action: 'close' }] });
  out = applyAvailabilityChanges(WEEK, p.changes);
  assert(Array.isArray(out.value['5']) && out.value['5'].length === 0 && JSON.stringify(out.value['4']) === JSON.stringify(NINE_FIVE), 'Friday closed, Thursday untouched');
  for (const bad of [
    { changes: [] },
    { changes: [{ day: 'funday', action: 'close' }] },
    { changes: [{ day: 'monday', action: 'wipe' }] },
    { changes: [{ day: 'monday', action: 'open' }] },
    { changes: [{ day: 'monday', action: 'close', start_min: 900, end_min: 800 }] },
    { changes: [{ day: 'monday', action: 'close', start_min: 800 }] },
    { changes: [{ day: 'monday', action: 'close', start_min: 0, end_min: 2000 }] },
    { changes: Array.from({ length: 15 }, () => ({ day: 'monday', action: 'close' })) },
  ]) assert(parseAvailabilityChanges(bad).error, `rejects ${JSON.stringify(bad).slice(0, 70)}`);

  console.log('\n[9] adjust_availability through Ivy: refused input, nothing before approval, isolation, latest schedule');
  assert(SENSITIVE_TOOLS.has('adjust_availability') && IVY_TOOLS.some((t) => t.name === 'adjust_availability') && IVY_TOOLS.some((t) => t.name === 'get_availability'), 'tools registered, adjust is approval-gated');
  await sql`UPDATE calendar_settings SET availability = ${JSON.stringify(WEEK)}::jsonb WHERE workspace_id IN (${A.workspaceId}, ${B.workspaceId})`;
  const beforeA = await avail(A.workspaceId);
  const beforeB = await avail(B.workspaceId);
  const pendBefore = await pendingCount(A.workspaceId);
  r = await executeIvyTool('adjust_availability', { changes: [{ day: 'someday', action: 'close' }] }, { workspaceId: A.workspaceId });
  assert(r.error && !r.needs_confirmation && await pendingCount(A.workspaceId) === pendBefore, 'invalid input → error, no approval card');
  const session9 = (await sql`INSERT INTO ivy_sessions (workspace_id, title) VALUES (${A.workspaceId}, 'Hours') RETURNING id`).rows[0].id;
  r = await executeIvyTool('adjust_availability', { changes: [{ day: 'tuesday', action: 'close', start_min: 780, end_min: 840 }] }, { workspaceId: A.workspaceId, sessionId: session9 });
  assert(r.needs_confirmation === true && r.pending_id, 'gated: needs approval');
  assert(/Tuesday: 9:00 AM to 5:00 PM → 9:00 AM to 1:00 PM and 2:00 PM to 5:00 PM/.test(r.summary), `card shows the exact Tuesday change (${r.summary})`);
  assert(/All other days stay the same\./.test(r.summary), 'card says all other days stay the same');
  assert(sameWeek(await avail(A.workspaceId), beforeA), 'nothing written before approval');
  let res = await approveCall({ id: r.pending_id, userId: B.userId });
  assert(res.statusCode === 404, `another workspace cannot approve it (${res.statusCode})`);
  // The owner edits Monday on the Availability screen before tapping Approve.
  const mondayEdited = { ...beforeA, 1: [{ start: 600, end: 960 }] };
  await sql`UPDATE calendar_settings SET availability = ${JSON.stringify(mondayEdited)}::jsonb WHERE workspace_id = ${A.workspaceId}`;
  res = await approveCall({ id: r.pending_id, userId: A.userId });
  assert(res.statusCode === 200 && res.body.ok === true, `owner approves (${res.statusCode})`);
  const afterA = await avail(A.workspaceId);
  assert(W(afterA['2']) === W([{ start: 540, end: 780 }, { start: 840, end: 1020 }]), 'Tuesday split after approval');
  assert(W(afterA['1']) === W([{ start: 600, end: 960 }]), "the owner's newer Monday edit was kept (applied to the latest schedule)");
  assert([0, 3, 4, 5, 6].every((d) => W(afterA[String(d)]) === W(beforeA[String(d)])), 'all other days unchanged');
  assert(sameWeek(await avail(B.workspaceId), beforeB), "the other workspace's schedule was not touched");
  assert(res.body.message?.actions?.[0]?.status === 'done', 'the approval message carries the ledger entry');
  const approvalRow = (await sql`SELECT actions FROM ivy_messages WHERE id = ${res.body.message.id}`).rows[0];
  assert(approvalRow.actions?.[0]?.tool === 'adjust_availability', 'approval outcome stored with actions');
  r = await runApprovedTool('adjust_availability', { changes: [{ day: 'monday', action: 'close' }] }, { workspaceId: B.workspaceId });
  assert(r.ok && (await avail(B.workspaceId))['1'].length === 0 && W((await avail(A.workspaceId))['1']) === W([{ start: 600, end: 960 }]), "B's change only affects B");

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[10] set_availability is an explicit full replace');
  const pend10 = await pendingCount(A.workspaceId);
  r = await executeIvyTool('set_availability', { preset: 'weekdays' }, { workspaceId: A.workspaceId });
  assert(r.error && /adjust_availability/.test(r.error) && /replace_all/.test(r.error) && await pendingCount(A.workspaceId) === pend10, 'onboarded owner: refused without replace_all, no card');
  r = await executeIvyTool('set_availability', { preset: 'weekdays', replace_all: true }, { workspaceId: A.workspaceId, sessionId: session9 });
  assert(r.needs_confirmation === true, 'with replace_all: approval card');
  assert(/This replaces your whole weekly schedule\./.test(r.summary) && /Tuesday: 9:00 AM to 1:00 PM and 2:00 PM to 5:00 PM → 9:00 AM to 5:00 PM/.test(r.summary), `card lists each day that changes (${r.summary})`);
  res = await approveCall({ id: r.pending_id, userId: A.userId });
  const replaced = await avail(A.workspaceId);
  assert(res.body.ok === true && W(replaced['2']) === W(NINE_FIVE) && !replaced['0'], 'approved replace applied');
  const C = await mkOwner('c', { onboarded: false });
  r = await executeIvyTool('set_availability', { preset: 'everyday' }, { workspaceId: C.workspaceId });
  assert(r.needs_confirmation === true, 'first-time setup (not onboarded): allowed without replace_all');
  // A card recorded before replace_all existed (no flag in its stored args).
  const old = (await sql`INSERT INTO ivy_pending_actions (workspace_id, session_id, tool, args, summary, expires_at)
    VALUES (${A.workspaceId}, ${session9}, 'set_availability', ${JSON.stringify({ preset: 'weekends' })}::jsonb, 'Replace the weekly booking hours with Sat, Sun', NOW() + INTERVAL '15 minutes')
    RETURNING id`).rows[0].id;
  res = await approveCall({ id: old, userId: A.userId });
  const weekends = await avail(A.workspaceId);
  assert(res.statusCode === 200 && res.body.ok === true && weekends['0'] && weekends['6'] && !weekends['1'], 'an old pending set_availability still runs');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[11] a write that succeeds while its email fails: ok with a warning');
  const cl = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.workspaceId}, ${`Robin ${S}`}, ${`robin-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
  const inv = await executeIvyTool('create_invoice', { client_id: cl, items: [{ description: 'Session', quantity: 1, rate: 120 }] }, { workspaceId: A.workspaceId });
  assert(inv.invoice?.id, 'draft invoice created');
  r = await executeIvyTool('send_invoice', { invoice_id: inv.invoice.id }, { workspaceId: A.workspaceId, sessionId: session9 });
  resendStatus = 500;
  res = await approveCall({ id: r.pending_id, userId: A.userId });
  resendStatus = 200;
  const invRow = (await sql`SELECT status FROM invoices WHERE id = ${inv.invoice.id}`).rows[0];
  assert(invRow.status === 'sent', 'the invoice is marked sent');
  assert(res.body.ok === true && res.body.result?.ok === true && res.body.result.email_delivered === false, 'tool result is ok, email_delivered false');
  assert(Array.isArray(res.body.result.warnings) && /did not go out/.test(res.body.result.warnings[0]), 'warning explains the email did not go out');
  assert(/^Done\./.test(res.body.message.text) && /One thing to check: .*did not go out/.test(res.body.message.text), `chat message says both (${res.body.message.text})`);
  const e = ledgerEntry('send_invoice', {}, res.body.result);
  assert(e.status === 'done' && e.warnings?.length === 1, 'ledger: done with a warning');
  const quote = await executeIvyTool('create_quote', { client_id: cl, items: [{ description: 'Package', quantity: 1, rate: 300 }] }, { workspaceId: A.workspaceId });
  resendStatus = 500;
  r = await runApprovedTool('send_quote', { quote_id: quote.quote.id }, { workspaceId: A.workspaceId });
  resendStatus = 200;
  assert(r.ok === true && r.email_delivered === false && r.warnings?.length === 1, 'send_quote no longer reports a failed email as delivered');

  // ────────────────────────────────────────────────────────────────────────
  console.log('\n[12] client recovery helpers: a cut-off reply is found on the server');
  const t0 = Date.now();
  const msgs = [
    { id: '1', role: 'me', text: 'block tuesdays', createdAt: new Date(t0 - 3600_000).toISOString() },
    { id: '2', role: 'ivy', text: 'old answer', createdAt: new Date(t0 - 3590_000).toISOString() },
    { id: '3', role: 'me', text: 'block tuesdays', createdAt: new Date(t0 + 1000).toISOString() },
  ];
  assert(findSavedReply(msgs, 'block tuesdays', t0).found && !findSavedReply(msgs, 'block tuesdays', t0).reply, 'finds the new message and sees no reply yet (not the old identical one)');
  msgs.push({ id: '4', role: 'ivy', text: 'Done', createdAt: new Date(t0 + 9000).toISOString() });
  assert(findSavedReply(msgs, 'block tuesdays', t0).reply?.id === '4', 'finds the saved reply');
  assert(pickNewSession([{ id: 'x', title: 'block tuesdays', createdAt: new Date(t0).toISOString() }, { id: 'y', title: 'other', createdAt: new Date(t0).toISOString() }], 'block tuesdays', t0)?.id === 'x', 'finds a new chat by its title');
  let polls = 0;
  const fakeApi = { get: async (p) => { polls++; return p === '/ivy/s1' ? { messages: polls < 3 ? msgs.slice(0, 3) : msgs } : { sessions: [] }; } };
  const rec = await recoverTurn({ api: fakeApi, sessionId: 's1', text: 'block tuesdays', startedAt: t0, waitMs: 1, tries: 5 });
  assert(rec?.replied === true && rec.messages.length === 4 && polls === 3, 'polls until the saved reply appears');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((err) => { console.error('crashed:', err); process.exit(1); });

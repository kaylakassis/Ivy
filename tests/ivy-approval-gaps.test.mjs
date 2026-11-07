// Gaps in Ivy's server-side approval gate, found in review:
//
//   [1] create_suggested_workflow could switch on an automation that sends a
//       document to every new client (send_document) with no Approve tap.
//       It is now held when the detected automation sends anything, and an
//       approval that finds the suggestion gone is reported as not done.
//   [2] create_booking emailed the client a confirmation (including the
//       model-written note) with no Approve tap. It is now held; an unknown
//       client is refused before any card.
//   [3] Approval cards showed only the start of text that reaches clients or
//       the public (a portal message cut at 160 characters, the automatic
//       lead reply hidden, the email signature cut at 60, a public review
//       reply at 300, a client-visible completion note at 120, a workflow's
//       email words not at all). Text past the cut was sent unseen. Every
//       card now shows the whole text that will go out.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-approval-gaps.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import approve from '../api/ivy/approve.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.resend.com')) {
    emails.push(init.body ? JSON.parse(init.body) : null);
    return new Response(JSON.stringify({ id: 'email_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

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
async function tapApprove(userId, id) {
  const res = mockRes();
  await approve({ method: 'POST', url: '/api/ivy/approve', query: {}, body: { id },
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': '203.0.113.91', cookie: `ivy_session=${signSession(userId)}` } }, res);
  return res;
}

const S = Date.now();
const made = [];
async function mkOwner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ivy-gaps-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  const o = { userId: u.rows[0].id, workspaceId: w.rows[0].id };
  made.push(o);
  return o;
}
const count = async (q) => Number((await q).rows[0].n);
// Text with a distinctive tail well past any old cut-off.
const longText = (head, n) => `${head} ${'lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n)} TAIL-${S}`;

async function run() {
  try {
    await ensureSchemaApplied();
    const A = await mkOwner('a');
    const ctx = { workspaceId: A.workspaceId, userId: A.userId };
    const session = (await sql`INSERT INTO ivy_sessions (workspace_id, title) VALUES (${A.workspaceId}, 'Gaps') RETURNING id`).rows[0].id;

    console.log('\n[1] a suggested automation that sends documents waits for Approve');
    const tmpl = (await sql`INSERT INTO documents (workspace_id, name, is_template) VALUES (${A.workspaceId}, 'Service agreement', TRUE) RETURNING id`).rows[0].id;
    for (let i = 0; i < 6; i++) {
      const cid = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${A.workspaceId}, ${`Doc client ${i}`}, 'active') RETURNING id`).rows[0].id;
      await sql`INSERT INTO documents (workspace_id, name, recipient_client_id, status, sent_at, template_id)
        VALUES (${A.workspaceId}, 'Service agreement - C', ${cid}, 'sent', NOW(), ${tmpl})`;
    }
    const wfCount = () => count(sql`SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = ${A.workspaceId}`);
    let r = await executeIvyTool('create_suggested_workflow', {}, { ...ctx, sessionId: session });
    assert(r.needs_confirmation === true && !!r.pending_id, 'held for approval (needs_confirmation)');
    assert(await wfCount() === 0, 'no automation was created before Approve');
    assert(/Service agreement/.test(r.summary || '') && /new client/i.test(r.summary || ''), `card names the document and who gets it (${r.summary})`);
    let res = await tapApprove(A.userId, r.pending_id);
    assert(res.statusCode === 200 && res.body?.ok === true, 'Approve creates it');
    const wf = (await sql`SELECT actions, enabled FROM workflows WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(!!wf && wf.actions.some((x) => x.type === 'send_document' && x.config.templateId === tmpl), 'the approved automation is the one on the card');

    // The suggestion is gone by the time the owner taps (it now exists):
    // the approval must say so, never "Done".
    await sql`DELETE FROM workflows WHERE workspace_id = ${A.workspaceId}`;
    r = await executeIvyTool('create_suggested_workflow', {}, { ...ctx, sessionId: session });
    assert(r.needs_confirmation === true, 'held again');
    await sql`INSERT INTO workflows (workspace_id, name, trigger_type, trigger_config, actions, enabled)
      VALUES (${A.workspaceId}, 'Mine', 'client_created', '{}'::jsonb, ${JSON.stringify([{ type: 'create_task', config: { title: 'x' } }])}::jsonb, TRUE)`;
    res = await tapApprove(A.userId, r.pending_id);
    assert(res.body?.ok === false, `approval of a vanished suggestion is not ok (ok=${res.body?.ok})`);
    assert(!/^Done/.test(res.body?.message?.text || '') && res.body?.message?.actions?.[0]?.status === 'failed',
      `chat records it as not done (${res.body?.message?.text})`);
    assert(await wfCount() === 1, 'no second automation was created');

    console.log('\n[2] create_booking (emails the client) waits for Approve');
    const jane = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${A.workspaceId}, 'Jane Gaps', ${`jane-gaps-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
    const bookingCount = () => count(sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${A.workspaceId}`);
    const emailsBefore = emails.length;
    r = await executeIvyTool('create_booking', { client_id: jane, date: '2099-04-07', start_min: 600, end_min: 660, notes: `Bring your list ${S}` }, { ...ctx, sessionId: session });
    assert(r.needs_confirmation === true && !!r.pending_id, 'held for approval');
    assert(await bookingCount() === 0, 'nothing booked before Approve');
    assert(emails.length === emailsBefore, 'no email went out before Approve');
    assert(/Jane Gaps/.test(r.summary) && /10:00 AM/.test(r.summary) && r.summary.includes(`Bring your list ${S}`) && /email/i.test(r.summary),
      `card says who, when, the note and that the client is emailed (${r.summary})`);
    r = await executeIvyTool('create_booking', { client_id: '00000000-0000-0000-0000-000000000000', date: '2099-04-07', start_min: 600, end_min: 660 }, ctx);
    assert(!r.needs_confirmation && /Unknown client/.test(r.error || ''), 'an unknown client is refused before any card');
    const noEmail = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${A.workspaceId}, 'No Email', 'active') RETURNING id`).rows[0].id;
    r = await executeIvyTool('create_booking', { client_id: noEmail, date: '2099-04-07', start_min: 600, end_min: 660 }, ctx);
    assert(!r.needs_confirmation && /no email/i.test(r.error || ''), 'a client without an email is refused before any card');
    const held = (await sql`SELECT id FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId} AND tool = 'create_booking' ORDER BY created_at DESC LIMIT 1`).rows[0].id;
    res = await tapApprove(A.userId, held);
    assert(res.body?.ok === true && await bookingCount() === 1, 'Approve books it');

    console.log('\n[3] cards show the whole text that will reach a client or the public');
    const msg = longText('Hi Jane,', 900);
    r = await executeIvyTool('send_message_to_client', { client_id: jane, text: msg }, ctx);
    assert(r.needs_confirmation && r.summary.includes(msg), 'portal message: the whole message is on the card');

    const lead = longText('Thanks for reaching out!', 900);
    const sig = longText('Warmly, Kayla', 400);
    r = await executeIvyTool('update_settings', { lead_instant_reply_message: lead, email_signature: sig }, ctx);
    assert(r.needs_confirmation && r.summary.includes(lead), 'settings: the automatic lead reply text is on the card');
    assert(r.summary.includes(sig), 'settings: the whole email signature is on the card');

    const rv = (await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text, status)
      VALUES (${A.workspaceId}, 'Pat', 5, 'Great', 'visible') RETURNING id`).rows[0].id;
    const reply = longText('Thank you Pat!', 900);
    r = await executeIvyTool('reply_to_review', { review_id: rv, response: reply }, ctx);
    assert(r.needs_confirmation && r.summary.includes(reply), 'public review reply: the whole reply is on the card');

    const bk = (await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${A.workspaceId}, ${jane}, 'Jane Gaps', ${`jane-gaps-${S}@example.com`}, CURRENT_DATE - 1, 600, 660) RETURNING id`).rows[0].id;
    const note = longText('Great session today.', 600);
    r = await executeIvyTool('update_booking_status', { booking_id: bk, status: 'completed', notes: note }, ctx);
    assert(r.needs_confirmation && r.summary.includes(note), 'completion note the client sees: the whole note is on the card');

    const body = longText('Welcome aboard!', 700);
    r = await executeIvyTool('create_workflow', {
      name: 'Welcome', trigger_type: 'client_created', enabled: true,
      actions: [{ type: 'send_email', config: { subject: `Welcome ${S}`, body } }, { type: 'send_sms', config: { body: `Text ${S}` } }],
    }, ctx);
    assert(r.needs_confirmation && r.summary.includes(`Welcome ${S}`) && r.summary.includes(body) && r.summary.includes(`Text ${S}`),
      'outbound automation: the email subject, email body and text are on the card');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const o of made) {
      await sql`DELETE FROM workspaces WHERE id = ${o.workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${o.userId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

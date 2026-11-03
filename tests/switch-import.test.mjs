// Switching to Ivy, part 1: bringing clients in and telling them about it.
//
//   [1] POST /api/clients/import: phone per row (normalized, deduped), quiet
//       imports send nothing and fire no automation (even with sendInvites),
//       importedIds in row order, the 1.0.2 response shape still there, caps,
//       and another business is never touched.
//   [2] Ivy's import_clients_from_list: approval-gated (nothing written until
//       Approve), the card lists people and flags "check" rows and
//       duplicates, another business cannot approve it, Approve is quiet and
//       its Done message links to missing emails and the move email. Approving
//       does not count as an Ivy message.
//   [3] add_bookings_from_list stays quiet: no email, text or push.
//   [4] .ics and .vcf files reach Ivy as text.
//   [5] /api/clients/announce-move: preview, opt-outs, no email, already
//       sent, daily cap, escaping, List-Unsubscribe, no booking page,
//       another business's clients ignored.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/switch-import.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_switch_import';
process.env.IVY_TWILIO_AUTH_TOKEN = 'switch_import_twilio_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import importHandler from '../api/clients/import.js';
import announceHandler from '../api/clients/announce-move.js';
import approve from '../api/ivy/approve.js';
import { executeIvyTool, runApprovedTool, IVY_TOOLS, SENSITIVE_TOOLS, ivyActionKind } from '../api/_lib/ivyTools.js';
import { parseAttachment } from '../api/_lib/ivyTurn.js';
import { buildMessages } from '../api/_lib/ivy.js';
import { renderAnnouncement, cleanSubject, ANNOUNCE_DAILY_CAP } from '../api/_lib/moveAnnounce.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Every outbound HTTP call (email provider, texting provider, push, Google)
// is captured here instead of leaving the machine.
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
  calls.push({ url: u, method: init.method || 'GET', body });
  if (u.includes('resend.com')) return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mark = () => calls.length;
const since = (m) => calls.slice(m);
const mails = (m) => since(m).filter((c) => c.url.includes('resend.com')).map((c) => c.body);

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
async function call(handler, { method = 'POST', url = '/', body = {}, query = {}, userId }) {
  const res = mockRes();
  await handler({
    method, url, query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', host: 'localhost:3001',
      'x-forwarded-for': '203.0.113.90', cookie: `ivy_session=${signSession(userId)}` },
  }, res);
  return res;
}

async function mkOwner(tag, { slug = true, name = 'Kayla Stone' } = {}) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`switch-${tag}-${S}@example.com`}, 'x', ${name}, NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${w.rows[0].id}, ${`Studio ${tag}`}, ${slug ? `switch-${tag}-${S}` : null}, 'America/Los_Angeles')`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id, slug: slug ? `switch-${tag}-${S}` : null };
}
const n = async (q) => Number((await q).rows[0].n);
const clientCount = (ws) => n(sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${ws}`);
const runCount = (ws) => n(sql`SELECT COUNT(*)::int AS n FROM workflow_runs WHERE workspace_id = ${ws}`);
const emailWorkflow = (ws) => sql.query(
  `INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
   VALUES ($1, 'Welcome', 'client_created', $2::jsonb, TRUE)`,
  [ws, JSON.stringify([{ type: 'send_email', config: { subject: 'Welcome {{firstName}}', body: 'Hi there' } }])],
);

async function run() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'clients-import:%' OR key LIKE 'announce-move:%'`.catch(() => {});

  console.log('\n[1] client import: phone, quiet, importedIds, compatibility');
  const A = await mkOwner('a');
  const B = await mkOwner('b');
  await emailWorkflow(A.workspaceId);
  await sql`INSERT INTO clients (workspace_id, name, email, phone, stage)
    VALUES (${A.workspaceId}, 'Existing Email', ${`dup-${S}@example.com`}, NULL, 'active'),
           (${A.workspaceId}, 'Existing Phone', NULL, '+14155550101', 'active')`;
  const shared = `shared-${S}@example.com`;
  await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${B.workspaceId}, 'B Person', ${shared}, 'active')`;
  const bBefore = await clientCount(B.workspaceId);

  let m = mark();
  let r = await call(importHandler, { userId: A.userId, body: { quiet: true, sendInvites: true, rows: [
    { name: 'Ann Email', email: `ann-${S}@example.com`, phone: '(415) 555-0199' },
    { name: 'Phone Only', phone: '415.555.0177' },
    { name: 'Dup By Email', email: `DUP-${S}@example.com` },
    { name: 'Dup By Phone', phone: '415 555 0101' },
    { name: 'Bad Phone', phone: '12' },
    { name: 'Name Only' },
    { name: 'Same Business Shared', email: shared },
    { name: 'Repeat Phone', phone: '+1 415 555 0177' },
  ] } });
  assert(r.statusCode === 200, `quiet import answers 200 (${r.statusCode})`);
  const s1 = r.body?.summary || {};
  assert(s1.created === 4 && s1.skipped === 3 && s1.invalid === 1 && s1.total === 8, `counts: created 4, skipped 3, invalid 1 (${JSON.stringify(s1)})`);
  assert(Array.isArray(r.body?.importedIds) && r.body.importedIds.length === 4, 'importedIds lists the new clients');
  const idRows = (await sql`SELECT id, name, phone FROM clients WHERE id = ANY(${r.body.importedIds}::uuid[])`).rows;
  const nameOf = new Map(idRows.map((x) => [x.id, x]));
  assert(r.body.importedIds.map((id) => nameOf.get(id)?.name).join('|') === 'Ann Email|Phone Only|Name Only|Same Business Shared', 'importedIds follow row order');
  assert(idRows.find((x) => x.name === 'Ann Email')?.phone === '+14155550199', 'phone stored normalized');
  assert(/Invalid phone/.test(JSON.stringify(r.body.errors)), 'a bad phone is reported on its row');
  assert(since(m).length === 0, `quiet import made no outbound call at all (${since(m).map((c) => c.url).join(', ')})`);
  assert(await runCount(A.workspaceId) === 0, 'quiet import fired no automation');
  const invited = await n(sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${A.workspaceId} AND invite_sent_at IS NOT NULL`);
  assert(invited === 0, 'quiet import sent no invites even with sendInvites');
  assert(await clientCount(B.workspaceId) === bBefore, 'the other business is untouched');
  for (const k of ['created', 'skipped', 'invalid', 'total', 'workflowsFired']) assert(k in s1, `1.0.2 field summary.${k} still there`);
  assert(Array.isArray(r.body.errors) && Array.isArray(r.body.inserted), '1.0.2 fields errors[] and inserted[] still there');

  // The same call without quiet (what the 1.0.2 app sends) still runs the
  // owner's automations, which is what quiet turns off.
  m = mark();
  r = await call(importHandler, { userId: A.userId, body: { rows: [{ name: 'Loud One', email: `loud-${S}@example.com` }], sendInvites: false } });
  assert(r.statusCode === 200 && r.body.summary.created === 1, 'old-style import works');
  assert(r.body.summary.workflowsFired >= 1 && await runCount(A.workspaceId) >= 1, 'without quiet the welcome automation runs (unchanged behavior)');
  assert(mails(m).length >= 1, 'and its email goes out');

  r = await call(importHandler, { userId: A.userId, body: { rows: Array.from({ length: 2001 }, (_, i) => ({ name: `R${i}` })) } });
  assert(r.statusCode === 400, 'more than 2000 rows is refused');
  r = await call(importHandler, { userId: B.userId, body: { quiet: true, rows: [{ name: 'B Copy', email: `ann-${S}@example.com` }] } });
  assert(r.statusCode === 200 && r.body.summary.created === 1, "another business's same email is not a duplicate here");
  assert((await sql`SELECT workspace_id FROM clients WHERE id = ${r.body.importedIds[0]}`).rows[0].workspace_id === B.workspaceId, "rows land in the caller's business only");

  console.log('\n[2] Ivy import_clients_from_list: approval, card, quiet, usage');
  assert(IVY_TOOLS.some((t) => t.name === 'import_clients_from_list') && SENSITIVE_TOOLS.has('import_clients_from_list'), 'tool is offered and approval-gated');
  assert(ivyActionKind('import_clients_from_list') === 'other', 'recorded in the action ledger');
  const C = await mkOwner('c');
  await emailWorkflow(C.workspaceId);
  await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${C.workspaceId}, 'Bea Old', ${`bea-${S}@example.com`}, 'active')`;
  const session = (await sql`INSERT INTO ivy_sessions (workspace_id, title) VALUES (${C.workspaceId}, 'Import') RETURNING id`).rows[0].id;
  const args = { clients: [
    { name: 'Jane Doe', email: `jane-${S}@example.com`, phone: '415-555-0142' },
    { name: 'M?ry Smith', phone: '415 555 01', uncertain: 'name hard to read' },
    { name: 'Bea Old', email: `BEA-${S}@example.com` },
    { name: 'Tom No Email', notes: 'Prefers mornings' },
    { name: 'Bad Mail', email: 'not-an-email' },
  ] };
  const before = await clientCount(C.workspaceId);
  m = mark();
  const gate = await executeIvyTool('import_clients_from_list', { ...args, confirm: true }, { workspaceId: C.workspaceId, userId: C.userId, sessionId: session });
  assert(gate.needs_confirmation === true && typeof gate.pending_id === 'string', 'model call only parks a pending action');
  assert(await clientCount(C.workspaceId) === before, 'nothing written before Approve');
  const sum = gate.summary || '';
  assert(/Add 4 clients/.test(sum) && /No emails or texts go out/.test(sum), `card says what will happen (${sum.split('\n')[0]})`);
  assert(/• Jane Doe · jane-/.test(sum) && /M\?ry Smith .*\(check: name hard to read\)/.test(sum), 'card lists people and flags the hard-to-read one');
  assert(/Already in your clients, will be skipped: Bea Old \(same email\)/.test(sum), 'card flags the duplicate');
  assert(!/[–—]/.test(sum), 'card copy has no long dashes');

  const stranger = await call(approve, { userId: B.userId, body: { id: gate.pending_id } });
  assert(stranger.statusCode === 404, `another business cannot approve it (${stranger.statusCode})`);
  assert(await clientCount(C.workspaceId) === before, 'still nothing written');

  const usageBefore = await n(sql`SELECT COALESCE(SUM(request_count), 0)::int AS n FROM ivy_usage WHERE workspace_id = ${C.workspaceId}`);
  const ok1 = await call(approve, { userId: C.userId, body: { id: gate.pending_id } });
  assert(ok1.statusCode === 200 && ok1.body?.ok === true, `owner approves (${ok1.statusCode} ${JSON.stringify(ok1.body?.result?.error || '')})`);
  const text = ok1.body?.message?.text || '';
  assert(/Added 4 clients/.test(text) && /skipped 1 already there/.test(text) && /No emails or texts went out/.test(text), `Done message has counts (${text.split('\n')[0]})`);
  assert(text.includes('(/clients?filter=missing-email)') && text.includes('[Let them know you moved](/clients?announce=1)'), 'Done message links to missing emails and the move email');
  assert(await clientCount(C.workspaceId) === before + 4, 'four clients added');
  const added = (await sql`SELECT name, email, phone, stage, source, notes FROM clients WHERE workspace_id = ${C.workspaceId} AND source = 'Ivy import' ORDER BY name`).rows;
  assert(added.every((x) => x.stage === 'active'), 'added as active clients');
  assert(added.find((x) => x.name === 'Jane Doe')?.phone === '+14155550142', 'phone normalized');
  assert(/Phone as written: 415 555 01/.test(added.find((x) => x.name === 'M?ry Smith')?.notes || ''), 'an unreadable phone is kept in notes, not lost');
  assert(added.find((x) => x.name === 'Bad Mail')?.email === null && /Email as written: not-an-email/.test(added.find((x) => x.name === 'Bad Mail')?.notes || ''), 'a misread email is kept in notes');
  assert(since(m).length === 0, 'approving sent nothing anywhere');
  assert(await runCount(C.workspaceId) === 0, 'no automation fired');
  const usageAfter = await n(sql`SELECT COALESCE(SUM(request_count), 0)::int AS n FROM ivy_usage WHERE workspace_id = ${C.workspaceId}`);
  assert(usageAfter === usageBefore, 'approving is not counted as an Ivy message');
  const again = await call(approve, { userId: C.userId, body: { id: gate.pending_id } });
  assert(again.statusCode === 409, 'a second tap does not run it again');

  console.log('\n[3] add_bookings_from_list is quiet');
  m = mark();
  const bk = await runApprovedTool('add_bookings_from_list', { bookings: [
    { client_name: 'Jane Doe', date: '2031-04-02', start_time: '10:00' },
    { client_name: 'Brand New', client_email: `brandnew-${S}@example.com`, client_phone: '4155550111', date: '2031-04-02', start_time: '11:00' },
  ] }, { workspaceId: C.workspaceId, userId: C.userId });
  assert(bk.added === 2, 'two appointments added');
  assert(since(m).length === 0, 'no email, text, push or calendar call');
  assert(await runCount(C.workspaceId) === 0, 'no automation fired for the new client');

  console.log('\n[4] calendar and contacts files reach Ivy as text');
  const vcf = Buffer.from('BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL:+14155550142\nEND:VCARD\n').toString('base64');
  const ics = Buffer.from('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Cut - Jane\nDTSTART:20310101T100000Z\nEND:VEVENT\nEND:VCALENDAR\n').toString('base64');
  for (const mt of ['text/vcard', 'text/x-vcard', 'text/calendar']) {
    const att = parseAttachment({ filename: mt.includes('cal') ? 'old.ics' : 'contacts.vcf', mediaType: mt, base64: mt.includes('cal') ? ics : vcf });
    assert(!(att instanceof Error), `${mt} is accepted`);
    const msgs = buildMessages('', {}, [], att);
    const blocks = msgs[msgs.length - 1].content;
    const fileText = Array.isArray(blocks) ? blocks.map((b) => b.text || '').join('\n') : String(blocks);
    assert(/BEGIN FILE CONTENTS/.test(fileText) && (/FN:Jane Doe/.test(fileText) || /SUMMARY:Cut - Jane/.test(fileText)), `${mt} arrives as a text block`);
  }

  console.log('\n[5] "I have moved" email');
  const D = await mkOwner('d');
  const E = await mkOwner('e');
  const mk = async (ws, name, email, extra = {}) => (await sql`
    INSERT INTO clients (workspace_id, name, email, stage, notification_prefs, move_announced_at)
    VALUES (${ws}, ${name}, ${email}, 'active', ${JSON.stringify(extra.prefs || {})}::jsonb, ${extra.announced || null})
    RETURNING id`).rows[0].id;
  const okId = await mk(D.workspaceId, 'Olive Green', `olive-${S}@example.com`);
  const noEmailId = await mk(D.workspaceId, 'Nora None', null);
  const prefOutId = await mk(D.workspaceId, 'Pat Prefs', `pat-${S}@example.com`, { prefs: { marketing: false } });
  const logOutId = await mk(D.workspaceId, 'Lou Log', `lou-${S}@example.com`);
  await sql`INSERT INTO client_email_optouts (workspace_id, client_id, email, type, source)
    VALUES (${D.workspaceId}, ${logOutId}, ${`lou-${S}@example.com`}, 'all', 'link')`;
  const doneId = await mk(D.workspaceId, 'Dee Done', `dee-${S}@example.com`, { announced: new Date().toISOString() });
  const otherBizId = await mk(E.workspaceId, 'Eve Elsewhere', `eve-${S}@example.com`);

  let g = await call(announceHandler, { method: 'GET', userId: D.userId });
  assert(g.statusCode === 200, 'preview loads');
  const bookingUrl = `https://www.joinivy.ai/book/${D.slug}`;
  assert(g.body.subject === 'Studio d has a new booking link', `subject is about the business (${g.body.subject})`);
  assert(g.body.bookingUrl === bookingUrl && g.body.body.includes(bookingUrl), 'body has the real booking link');
  assert(/^Hi \{first name\},/.test(g.body.body) && /Your history with me is safe/.test(g.body.body) && /See you soon,\nKayla$/.test(g.body.body), 'friendly body signed with the owner first name');
  assert(!/Ivy/.test(g.body.subject + g.body.body) && !/[–—]/.test(g.body.body), 'no product name and no long dashes in the client email');
  assert(g.body.eligibleCount === 1 && g.body.alreadyAnnouncedCount === 1, `counts (${g.body.eligibleCount}, ${g.body.alreadyAnnouncedCount})`);

  m = mark();
  const ids = [okId, noEmailId, prefOutId, logOutId, doneId, otherBizId, 'not-a-uuid'];
  let p = await call(announceHandler, { userId: D.userId, body: {
    clientIds: ids,
    subject: 'Big news\r\nBcc: victim@example.com',
    body: 'Hi {first name},\n\n<script>alert(1)</script> & <b>bold</b>\nBook: {link}',
  } });
  assert(p.statusCode === 200, 'send answers 200');
  assert(p.body.sent === 1, `one email sent (${p.body.sent})`);
  assert(JSON.stringify(p.body.skipped) === JSON.stringify({ noEmail: 1, optedOut: 2, alreadySent: 1, overCap: 0, failed: 0 }), `skips counted (${JSON.stringify(p.body.skipped)})`);
  const sentMail = mails(m);
  assert(sentMail.length === 1 && sentMail[0].to.includes(`olive-${S}@example.com`), 'only the eligible client is emailed');
  assert(!sentMail.some((x) => JSON.stringify(x).includes(`eve-${S}`)), "another business's client is never emailed");
  const mail = sentMail[0] || {};
  assert(mail.subject === 'Big news Bcc: victim@example.com', `subject is one line (${mail.subject})`);
  assert(!/<script>/.test(mail.html) && /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;b&gt;bold&lt;\/b&gt;/.test(mail.html), 'owner text is escaped');
  assert(/Hi Olive,/.test(mail.html) && /Hi Olive,/.test(mail.text), 'first name filled in');
  assert(mail.html.includes(`href="${bookingUrl}"`) && mail.text.includes(bookingUrl), 'booking link included');
  assert(/\/api\/unsubscribe\?token=/.test(mail.headers?.['List-Unsubscribe'] || ''), 'carries the one-click unsubscribe header');
  assert((await sql`SELECT move_announced_at FROM clients WHERE id = ${okId}`).rows[0].move_announced_at, 'client marked as told');
  assert(!(await sql`SELECT move_announced_at FROM clients WHERE id = ${otherBizId}`).rows[0].move_announced_at, "other business's client unchanged");

  m = mark();
  p = await call(announceHandler, { userId: D.userId, body: { clientIds: [okId] } });
  assert(p.body.sent === 0 && p.body.skipped.alreadySent === 1 && mails(m).length === 0, 'never sent twice');

  g = await call(announceHandler, { method: 'GET', userId: E.userId });
  assert(g.body.eligibleCount === 1 && g.body.alreadyAnnouncedCount === 0, "each business sees only its own clients");

  // Daily cap: 500 already told today.
  const F = await mkOwner('f');
  await sql`INSERT INTO clients (workspace_id, name, email, stage, move_announced_at)
    SELECT ${F.workspaceId}, 'Told ' || g, 'told-' || g || ${`-${S}@example.com`}, 'active', NOW()
      FROM generate_series(1, ${ANNOUNCE_DAILY_CAP}) g`;
  const fresh = await mk(F.workspaceId, 'Fresh Face', `fresh-${S}@example.com`);
  m = mark();
  p = await call(announceHandler, { userId: F.userId, body: { clientIds: [fresh] } });
  assert(p.body.sent === 0 && p.body.skipped.overCap === 1 && mails(m).length === 0, 'over the daily cap nothing is sent');
  assert(!(await sql`SELECT move_announced_at FROM clients WHERE id = ${fresh}`).rows[0].move_announced_at, 'capped client can be told later');

  const G = await mkOwner('g', { slug: false });
  const gId = await mk(G.workspaceId, 'Gus', `gus-${S}@example.com`);
  p = await call(announceHandler, { userId: G.userId, body: { clientIds: [gId] } });
  assert(p.statusCode === 400, 'no booking page yet: refused with a plain message');
  p = await call(announceHandler, { userId: D.userId, body: { clientIds: Array.from({ length: 1001 }, () => okId) } });
  assert(p.statusCode === 400, 'more than 1000 ids refused');

  const rendered = renderAnnouncement('Hi {first name}, {link}', { clientName: '<img src=x>', bookingUrl: 'https://x.test/book/a' });
  assert(/Hi there,/.test(rendered.text) && !/<img/.test(rendered.html), 'unusable name becomes "there", nothing injected');
  assert(cleanSubject('a'.repeat(400)).length === 150, 'subject capped');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

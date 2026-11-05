// Client portal invites when a client is added.
//   [1] setting on (the default): Add client emails one branded invite,
//       with the client-mode sign-up link, and reports invite.sent
//   [2] the add form's explicit choice wins (sendInvite false / true)
//   [3] setting off: no invite unless the owner ticks the box
//   [4] Ivy add_client follows the same rule (+ send_invite override)
//   [5] a booking that creates the client follows the setting
//   [6] opted-out clients are never emailed and never shown as invited
//   [7] exactly once: a second automatic invite never goes out
//   [8] resend-invite: sends, stamps, refuses another business's client
//   [9] imports stay quiet with the setting on
//   [10] invite-settings is owner-only and per business
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-invite.test.mjs
import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import clientsHandler from '../api/clients/index.js';
import importHandler from '../api/clients/import.js';
import settingsHandler from '../api/clients/invite-settings.js';
import resendHandler from '../api/clients/[id]/resend-invite.js';
import bookingsHandler from '../api/calendar/bookings.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { sendClientInvite } from '../api/_lib/clientNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mailsTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).map((x) => String(x).toLowerCase()).includes(addr.toLowerCase()));
const invitesTo = (addr) => mailsTo(addr).filter((m) => /added you on Ivy|claim your account/i.test(m.subject));

// Fire-and-forget invites (booking path) register here; flush waits.
const pending = [];
globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (p) => pending.push(p) }) };
async function flush() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 15));
    if (!pending.length) return;
    await Promise.allSettled(pending.splice(0));
  }
}

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie, extra = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `203.0.${(ipN % 200) + 1}.${(ipN % 250) + 2}`, ...(cookie ? { cookie } : {}), ...extra } };
}
async function call(handler, opts) { const r = mockRes(); await handler(req(opts), r); return r; }

const TAG = `ci${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const addr = (k) => `${TAG}-${k}@example.com`;
const users = [];
const workspaces = [];

async function mkOwner(label, bizName) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${addr(label)}, 'x', ${label}, NOW(), 'v1', NOW()) RETURNING id`;
  users.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u.rows[0].id}, ${bizName}, 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  workspaces.push(w.rows[0].id);
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${w.rows[0].id}, ${bizName}, ${`${TAG}-${label}`}, 'UTC') ON CONFLICT (workspace_id) DO NOTHING`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
const stamp = async (id) => (await sql`SELECT invite_sent_at FROM clients WHERE id = ${id}`).rows[0]?.invite_sent_at || null;

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('a', 'Glow Studio');
  const B = await mkOwner('b', 'Other Biz');

  console.log('\n[1] default on: Add client sends one branded invite');
  let r = await call(settingsHandler, { cookie: A.cookie });
  assert(r.statusCode === 200 && r.body?.inviteNewClients === true, 'setting defaults to on');
  r = await call(clientsHandler, { method: 'POST', cookie: A.cookie, body: { name: 'Ava Add', email: addr('ava'), stage: 'active' } });
  assert(r.statusCode === 201, `client created (${r.statusCode})`);
  assert(r.body?.invite?.sent === true, `response says the invite went out (${JSON.stringify(r.body?.invite)})`);
  assert(!!r.body?.client?.inviteSentAt, 'client record shows when it was sent');
  let m = invitesTo(addr('ava'));
  assert(m.length === 1, `exactly one invite email (${m.length})`);
  assert(m[0]?.subject === 'Glow Studio added you on Ivy', `subject names the business (${m[0]?.subject})`);
  assert(m[0]?.html.includes(`/signup?mode=client&amp;email=`) || m[0]?.html.includes(`/signup?mode=client&email=`), 'link opens the client sign-up with the email filled in');
  assert(/Create my account/.test(m[0]?.html || ''), 'branded shell with the call to action');
  assert(/List-Unsubscribe/i.test(JSON.stringify(m[0]?.headers || {})), 'carries an unsubscribe header');

  console.log("\n[2] the add form's explicit choice wins");
  r = await call(clientsHandler, { method: 'POST', cookie: A.cookie, body: { name: 'Quinn Quiet', email: addr('quinn'), sendInvite: false } });
  assert(r.statusCode === 201 && r.body?.invite?.sent === false && r.body?.invite?.reason === 'off', `unticked → not sent (${JSON.stringify(r.body?.invite)})`);
  assert(invitesTo(addr('quinn')).length === 0 && !(await stamp(r.body.client.id)), 'no email, no stamp');

  console.log('\n[3] setting off: quiet unless the box is ticked');
  r = await call(settingsHandler, { method: 'PATCH', cookie: A.cookie, body: { inviteNewClients: false } });
  assert(r.statusCode === 200 && r.body?.inviteNewClients === false, 'owner turned it off');
  r = await call(clientsHandler, { method: 'POST', cookie: A.cookie, body: { name: 'Sam Silent', email: addr('sam') } });
  assert(r.body?.invite?.sent === false && invitesTo(addr('sam')).length === 0, 'no invite when the caller says nothing');
  r = await call(clientsHandler, { method: 'POST', cookie: A.cookie, body: { name: 'Tia Ticked', email: addr('tia'), sendInvite: true } });
  assert(r.body?.invite?.sent === true && invitesTo(addr('tia')).length === 1, 'ticking the box still sends it');

  console.log('\n[4] Ivy add_client follows the setting');
  const ctx = { workspaceId: A.workspaceId, userId: A.userId };
  let out = await executeIvyTool('add_client', { name: 'Ivy Off', email: addr('ivyoff') }, ctx);
  assert(out?.ok && out.invite_sent === false && invitesTo(addr('ivyoff')).length === 0, 'setting off → Ivy adds quietly');
  out = await executeIvyTool('add_client', { name: 'Ivy Asked', email: addr('ivyasked'), send_invite: true }, ctx);
  assert(out?.invite_sent === true && invitesTo(addr('ivyasked')).length === 1, 'owner asked Ivy to invite → sent');
  await call(settingsHandler, { method: 'PATCH', cookie: A.cookie, body: { inviteNewClients: true } });
  out = await executeIvyTool('add_client', { name: 'Ivy On', email: addr('ivyon') }, ctx);
  assert(out?.invite_sent === true && invitesTo(addr('ivyon')).length === 1, 'setting on → Ivy invites once');
  out = await executeIvyTool('add_client', { name: 'Ivy No', email: addr('ivyno'), send_invite: false }, ctx);
  assert(out?.invite_sent === false && invitesTo(addr('ivyno')).length === 0, 'send_invite:false → none');

  console.log('\n[5] a booking that creates the client');
  const date = (() => { for (let d = 3; d <= 9; d++) { const dt = new Date(Date.now() + d * 86400000); if (dt.getUTCDay() >= 1 && dt.getUTCDay() <= 5) return dt.toISOString().slice(0, 10); } })();
  r = await call(bookingsHandler, { method: 'POST', cookie: A.cookie, body: {
    clientName: 'Bea Booked', clientEmail: addr('bea'), date, startMin: 600, endMin: 660, skipConflictCheck: true } });
  await flush();
  assert(r.statusCode === 201, `booking created (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  assert(invitesTo(addr('bea')).length === 1, 'new client from a booking gets one invite (setting on)');
  await call(settingsHandler, { method: 'PATCH', cookie: A.cookie, body: { inviteNewClients: false } });
  r = await call(bookingsHandler, { method: 'POST', cookie: A.cookie, body: {
    clientName: 'Ben Booked', clientEmail: addr('ben'), date, startMin: 720, endMin: 780, skipConflictCheck: true } });
  await flush();
  assert(r.statusCode === 201 && invitesTo(addr('ben')).length === 0, 'setting off → booking adds them quietly');
  await call(settingsHandler, { method: 'PATCH', cookie: A.cookie, body: { inviteNewClients: true } });

  console.log('\n[6] opted-out addresses are never invited, never shown as invited');
  await sql`INSERT INTO client_email_optouts (workspace_id, email, type, source) VALUES (${A.workspaceId}, ${addr('olga')}, 'all', 'link')`;
  r = await call(clientsHandler, { method: 'POST', cookie: A.cookie, body: { name: 'Olga Out', email: addr('olga') } });
  assert(r.body?.invite?.sent === false && r.body?.invite?.reason === 'muted', `reported as muted (${JSON.stringify(r.body?.invite)})`);
  assert(invitesTo(addr('olga')).length === 0, 'no email to an opted-out address');
  const olgaId = r.body.client.id;
  assert(!(await stamp(olgaId)) && r.body.client.inviteSentAt === null, 'no "invited" stamp left behind');
  r = await call(resendHandler, { method: 'POST', cookie: A.cookie, query: { id: olgaId } });
  assert(r.statusCode === 200 && r.body?.sent === false && r.body?.reason === 'muted' && !(await stamp(olgaId)), 'manual resend is refused too, still not stamped');

  console.log('\n[7] exactly once');
  const avaId = (await sql`SELECT id FROM clients WHERE workspace_id = ${A.workspaceId} AND email = ${addr('ava')}`).rows[0].id;
  const again = await sendClientInvite({ workspaceId: A.workspaceId, clientId: avaId });
  assert(again.sent === false && again.reason === 'already-invited' && invitesTo(addr('ava')).length === 1, 'second automatic invite skipped');
  const both = await Promise.all([1, 2, 3].map(async () => {
    const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.workspaceId}, 'Race', ${addr(`race${crypto.randomBytes(2).toString('hex')}`)}, 'lead') RETURNING id, email`).rows[0];
    const res = await Promise.all([sendClientInvite({ workspaceId: A.workspaceId, clientId: c.id }), sendClientInvite({ workspaceId: A.workspaceId, clientId: c.id })]);
    return { email: c.email, sentCount: res.filter((x) => x.sent).length };
  }));
  assert(both.every((x) => x.sentCount === 1 && invitesTo(x.email).length === 1), 'two invites racing for one client send one email');

  console.log('\n[8] resend-invite');
  const quinnId = (await sql`SELECT id FROM clients WHERE workspace_id = ${A.workspaceId} AND email = ${addr('quinn')}`).rows[0].id;
  r = await call(resendHandler, { method: 'POST', cookie: A.cookie, query: { id: quinnId } });
  assert(r.statusCode === 200 && r.body?.sent === true && !!r.body?.inviteSentAt, 'owner can invite a quietly added client later');
  assert(invitesTo(addr('quinn')).length === 1 && /an\s+Ivy portal/.test(invitesTo(addr('quinn'))[0].html), 'one reminder email, grammar fixed');
  r = await call(resendHandler, { method: 'POST', cookie: B.cookie, query: { id: quinnId } });
  assert(r.statusCode === 404 && invitesTo(addr('quinn')).length === 1, `another business cannot invite this client (${r.statusCode})`);

  console.log('\n[9] imports stay quiet');
  r = await call(importHandler, { method: 'POST', cookie: A.cookie, body: { rows: [{ name: 'Imp One', email: addr('imp1') }] } });
  assert(r.statusCode === 200 && invitesTo(addr('imp1')).length === 0, 'import without opting in sends nothing, setting on or not');
  r = await call(importHandler, { method: 'POST', cookie: A.cookie, body: { quiet: true, sendInvites: true, rows: [{ name: 'Imp Two', email: addr('imp2') }] } });
  await flush();
  assert(invitesTo(addr('imp2')).length === 0, 'quiet import never invites');

  console.log('\n[10] invite-settings is per business and owner only');
  r = await call(settingsHandler, { method: 'PATCH', cookie: B.cookie, body: { inviteNewClients: false } });
  assert(r.statusCode === 200, 'B changes its own setting');
  r = await call(settingsHandler, { cookie: A.cookie });
  assert(r.body?.inviteNewClients === true, "B's change does not touch A");
  r = await call(settingsHandler, { method: 'PATCH', cookie: A.cookie, body: { inviteNewClients: 'yes' } });
  assert(r.statusCode === 400, 'non-boolean refused');
  r = await call(settingsHandler, { method: 'PATCH', body: { inviteNewClients: false } });
  assert(r.statusCode === 401, `signed out refused (${r.statusCode})`);
  r = await call(settingsHandler, { method: 'PATCH', cookie: A.cookie, body: { inviteNewClients: false }, extra: { origin: 'https://evil.example' } });
  assert(r.statusCode === 403, `cross-origin write refused (${r.statusCode})`);
  // A helper of A (a login with clients permission) cannot change it.
  const h = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${addr('helper')}, 'x', 'Helper', NOW(), 'v1', NOW()) RETURNING id`;
  users.push(h.rows[0].id);
  await sql`INSERT INTO staff_members (workspace_id, user_id, name, permissions) VALUES (${A.workspaceId}, ${h.rows[0].id}, 'Helper', '{"clients":true}'::jsonb)`;
  r = await call(settingsHandler, { method: 'PATCH', cookie: `ivy_session=${signSession(h.rows[0].id)}`, body: { inviteNewClients: false }, extra: { 'x-helper-workspace': A.workspaceId } });
  assert(r.statusCode >= 400, `helper cannot change the business setting (${r.statusCode})`);
  r = await call(settingsHandler, { cookie: A.cookie });
  assert(r.body?.inviteNewClients === true, 'still on for A');
}

try {
  await run();
} catch (err) {
  console.error('Fatal:', err.message, err.stack);
  fail++;
} finally {
  for (const id of workspaces) await sql`DELETE FROM workspaces WHERE id = ${id}`.catch(() => {});
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

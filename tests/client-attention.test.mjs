// The Clients list answers "does this person need me?" for every client,
// and the "Needs attention" filter and its count agree with the rows.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-attention.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import clientsHandler from '../api/clients/index.js';
import { clientAttention, nextBookings, ATTENTION_REASONS } from '../api/_lib/clientAttention.js';
import { QUIET_DAYS } from '../api/_lib/accountability.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const users = [];

function makeRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function list(userId, query, extra = {}) {
  const req = { method: 'GET', url: '/api/clients', query, headers: { cookie: `ivy_session=${signSession(userId)}`, origin: 'http://localhost:3000', host: 'localhost:3000', ...extra } };
  const res = makeRes(); res.req = req;
  await clientsHandler(req, res);
  return res;
}
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
const dayStr = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);

async function main() {
  await ensureSchemaApplied();
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
    VALUES (${`attn-${S}@example.com`}, 'x', 'Attn Owner', NOW(), 'owner') RETURNING id`).rows[0];
  users.push(u.id);
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${ws}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
  const mk = async (name, stage, { createdDays = 60, seenDays = 2, source = null } = {}) => (await sql`
    INSERT INTO clients (workspace_id, name, email, stage, created_at, joined_at, last_seen_at, source)
    VALUES (${ws}, ${name}, ${`${name.toLowerCase().replace(/\W+/g, '.')}-${S}@example.com`}, ${stage}, ${ago(createdDays)}, ${ago(createdDays)}, ${ago(seenDays)}, ${source})
    RETURNING id`).rows[0].id;

  // one client per situation
  const owes = await mk('Olive Owes', 'active');
  const texted = await mk('Tara Texted', 'active');
  const lead = await mk('Lee Lead', 'lead', { createdDays: 3 });
  const oldLead = await mk('Larry Longago', 'lead', { createdDays: 90 });
  const usedUp = await mk('Uma Usedup', 'active');
  const lastOne = await mk('Lana Lastone', 'active');
  const quiet = await mk('Quinn Quiet', 'active', { createdDays: 120, seenDays: 80 });
  const fine = await mk('Fiona Fine', 'active');
  const both = await mk('Bo Both', 'active');
  const demo = await mk('Dana Demo', 'active', { source: 'demo' });
  const paused = await mk('Pat Paused', 'paused', { createdDays: 200, seenDays: 150 });

  const inv = (clientId, n, status, dueOffset, amount) => sql`
    INSERT INTO invoices (workspace_id, number, client_id, items, status, due_date)
    VALUES (${ws}, ${`A-${S}-${n}`}, ${clientId}, ${JSON.stringify([{ description: 'Session', quantity: 1, rate: amount }])}::jsonb, ${status}, ${dayStr(dueOffset)})`;
  await inv(owes, 1, 'overdue', -9, 120);
  await inv(owes, 2, 'overdue', -2, 30);
  await inv(fine, 3, 'sent', 10, 80);          // not due yet: not "attention"
  await inv(both, 4, 'overdue', -1, 50);
  await inv(demo, 5, 'overdue', -5, 99);       // sample data never counts

  const thread = async (clientId, unread, lastDays, bizReplied = false) => {
    const t = (await sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at)
      VALUES (${ws}, ${clientId}, ${unread}, ${ago(lastDays)}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO messages (thread_id, sender, text, created_at) VALUES (${t}, 'client', 'Hi', ${ago(lastDays)})`;
    if (bizReplied) await sql`INSERT INTO messages (thread_id, sender, text, created_at) VALUES (${t}, 'biz', 'Hello', ${ago(lastDays)})`;
  };
  await thread(texted, 2, 3);
  await thread(both, 1, 0);
  await thread(fine, 0, 1, true);
  await thread(usedUp, 0, 2, true);
  await thread(lastOne, 0, 2, true);

  const pkg = (clientId, status, total, left) => sql`
    INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status)
    VALUES (${ws}, ${clientId}, '5 sessions', ${total}, ${left}, ${status})`;
  await pkg(usedUp, 'exhausted', 5, 0);
  await pkg(lastOne, 'active', 5, 1);
  await pkg(fine, 'active', 5, 4);

  const book = (clientId, offset, startMin = 15 * 60) => sql`
    INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${ws}, ${clientId}, 'x', ${`b-${S}@example.com`}, ${dayStr(offset)}, ${startMin}, ${startMin + 60})`;
  await book(fine, 5, 15 * 60);
  await book(fine, 2, 9 * 60 + 30);   // the earlier of the two is "next"
  await book(texted, 1);
  await book(owes, -3);

  console.log('\n[1] one plain reason per client');
  const a = await clientAttention(ws);
  assert(a[owes]?.key === 'overdue' && a[owes].tone === 'danger' && /^Owes \$150\.00 · 9 days overdue$/.test(a[owes].label), `overdue money: "${a[owes]?.label}" (both invoices added up, oldest due date)`);
  assert(a[texted]?.key === 'message' && a[texted].label === 'Sent you a message 3 days ago', `unread message: "${a[texted]?.label}"`);
  assert(a[lead]?.key === 'lead' && a[lead].label === 'New lead · not contacted yet', `new lead nobody replied to: "${a[lead]?.label}"`);
  assert(!a[oldLead], 'a lead from three months ago is not flagged as new');
  assert(a[usedUp]?.key === 'package' && a[usedUp].label === 'Out of sessions', `used-up package: "${a[usedUp]?.label}"`);
  assert(a[lastOne]?.key === 'package' && a[lastOne].label === '1 session left · nothing booked', `last session: "${a[lastOne]?.label}"`);
  assert(a[quiet]?.key === 'quiet' && a[quiet].label === `No contact in ${Math.round(QUIET_DAYS / 7)}+ weeks · nothing booked`, `gone quiet: "${a[quiet]?.label}"`);
  assert(!a[fine], 'a client with an invoice not yet due, sessions left and a booking needs nothing');
  assert(a[both]?.key === 'overdue' && a[both].more === 1, 'two reasons: the most pressing one shows (money before a message), with "1 more"');
  assert(!a[demo], 'sample data never needs attention');
  assert(!a[paused], 'a paused client is not chased for being quiet');
  assert(Object.values(a).every((x) => ATTENTION_REASONS.includes(x.key) && !/[–—]/.test(x.label)), 'every label is one of the known reasons, in plain words with no dashes');

  console.log('\n[2] the next booking');
  const nb = await nextBookings(ws, [fine, texted, owes, quiet]);
  assert(nb[fine]?.date === dayStr(2) && nb[fine].startMin === 570, 'the earliest upcoming booking is "next"');
  assert(nb[texted]?.date === dayStr(1) && !nb[owes] && !nb[quiet], 'past bookings do not count; no booking means none');

  console.log('\n[3] the list, the filter and the count agree');
  let r = await list(u.id, { cursor: '', summary: '1' });
  assert(r.statusCode === 200, `the list loads (${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
  const rows = r.body.clients;
  const byId = Object.fromEntries(rows.map((c) => [c.id, c]));
  assert(byId[owes]?.attention?.key === 'overdue' && byId[fine]?.attention === null && byId[fine]?.nextBooking?.date === dayStr(2), 'each row carries its reason, or its next booking');
  const flagged = rows.filter((c) => c.attention).map((c) => c.id).sort();
  const expected = [owes, texted, lead, usedUp, lastOne, quiet, both].sort();
  assert(JSON.stringify(flagged) === JSON.stringify(expected), `exactly the seven clients who need something are flagged (${flagged.length})`);
  assert(r.body.summary.counts.attention === 7 && r.body.summary.counts.all === 11, `the "Needs attention" count is 7 of 11 (${r.body.summary.counts.attention} of ${r.body.summary.counts.all})`);

  r = await list(u.id, { cursor: '', filter: 'attention' });
  assert(r.body.total === 7 && r.body.clients.length === 7 && r.body.clients.every((c) => c.attention), 'the filter returns those seven and only those');
  r = await list(u.id, { cursor: '', filter: 'attention', q: 'Olive' });
  assert(r.body.total === 1 && r.body.clients[0].id === owes, 'search works inside the filter');
  r = await list(u.id, { cursor: '', filter: 'attention', limit: '3' });
  const page1 = r.body.clients.map((c) => c.id);
  const r2 = await list(u.id, { cursor: r.body.nextCursor, filter: 'attention', limit: '3' });
  const r3 = await list(u.id, { cursor: r2.body.nextCursor, filter: 'attention', limit: '3' });
  const allPages = [...page1, ...r2.body.clients.map((c) => c.id), ...r3.body.clients.map((c) => c.id)];
  assert(r.body.hasMore && new Set(allPages).size === 7 && allPages.length === 7, 'paging through the filter reaches all seven once each');
  r = await list(u.id, { cursor: '', filter: 'active' });
  assert(r.body.clients.every((c) => c.stage === 'active') && r.body.clients.some((c) => c.attention), 'the other filters still work and still show the reason on each row');

  console.log('\n[4] another business sees none of it');
  const u2 = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
    VALUES (${`attn2-${S}@example.com`}, 'x', 'Other Owner', NOW(), 'owner') RETURNING id`).rows[0];
  users.push(u2.id);
  const ws2 = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u2.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  r = await list(u2.id, { cursor: '', summary: '1', filter: 'attention' });
  assert(r.statusCode === 200 && r.body.clients.length === 0 && r.body.summary.counts.attention === 0, 'their list and count are empty');
  assert(Object.keys(await clientAttention(ws2)).length === 0 && Object.keys(await nextBookings(ws2, [fine, owes])).length === 0, 'and asking about another business\'s clients returns nothing');

  console.log('\n[5] a helper never sees the money or the inbox through the list');
  for (const [label, perms] of [['full client list', { clients: true }], ['whole calendar', { schedule: true }], ['clients, calendar and messages', { clients: true, schedule: true, messages: true }]]) {
    const h = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${`attn-h-${S}-${Object.keys(perms).join('')}@example.com`}, 'x', 'Helper', NOW()) RETURNING id`).rows[0];
    users.push(h.id);
    await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed, user_id, permissions)
      VALUES (${ws}, 'Helper', ${`attn-hs-${S}-${Object.keys(perms).join('')}@example.com`}, TRUE, TRUE, ${h.id}, ${JSON.stringify(perms)}::jsonb)`;
    const asHelper = { 'x-helper-workspace': ws };
    r = await list(h.id, { cursor: '', summary: '1' }, asHelper);
    const text = JSON.stringify(r.body);
    assert(r.statusCode === 200 && r.body.clients.length > 0 && r.body.clients.every((c) => !('attention' in c) && !('nextBooking' in c))
      && !/Owes \$|overdue|Sent you a message|session left|Out of sessions|nothing booked/.test(text) && !('attention' in r.body.summary.counts),
      `helper with ${label}: sees clients, but no reasons, no bookings and no count`);
    r = await list(h.id, { cursor: '', filter: 'attention' }, asHelper);
    assert(r.statusCode === 200 && r.body.clients.length === 0 && r.body.total === 0, `helper with ${label}: the "Needs attention" filter gives them nothing`);
  }

  console.log('\n[6] the screen');
  const src = readFileSync(new URL('../src/features/clients/Clients.jsx', import.meta.url), 'utf8');
  const header = src.slice(src.indexOf('{/* The list is the screen'), src.indexOf('{openFolder && ('));
  assert(!/Your book of business/.test(src) && !/Any client can become a folder: all of their files/.test(header), 'the explanation lines above the list are gone');
  assert(/Add client/.test(header) && /aria-label="More client tools"/.test(header) && /Import clients/.test(header) && /Custom fields/.test(header), 'one button (Add client); Import and Custom fields are behind the menu');
  const order = ['{!cardList && statsBlock}', '{filterBlock}', '{dupBlock}', '{/* Table - desktop/tablet', '{cardList && statsBlock}'].map((x) => src.indexOf(x));
  assert(order.every((x) => x > 0) && order.join() === [...order].sort((x, y) => x - y).join(), 'order on a phone: search and filters, then the clients, then the numbers');
  assert(/const filterBlock = cardList \? \(\s*<div[^>]*>\s*\{searchBox\}\s*\{tabRow\}/.test(src), 'on a phone the search box is the first thing, above the filters');
  assert(/\['attention', 'Needs attention'\]/.test(src) && /'attention' in summary\.counts/.test(src) && /if \(tab === 'attention' && !c\.attention\) return false;/.test(src), 'there is a "Needs attention" filter, for the owner only');
  assert((src.match(/<ClientStatusLine client=\{client\}\/>/g) || []).length === 2, 'both the phone card and the desktop row show the status line');
  assert(/Nobody needs you right now/.test(src), 'the empty state for the filter says so plainly');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

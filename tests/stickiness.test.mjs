// A reason to come back, and a way to see who does not:
//   [1] the daily notification leads with a count the owner can finish
//   [2] overdue invoices can be chased from Home in one tap (plus a confirm)
//   [3] the app records which screen was opened, and nothing else
//   [4] Admin > First week turns that into where new accounts stop
//
// Run: node --import ./tests/bootstrap.mjs ./tests/stickiness.test.mjs
import { readFileSync } from 'node:fs';
process.env.SUPER_ADMIN_EMAIL = `stk-admin-${Date.now()}@example.com`;

const { ensureSchemaApplied } = await import('../api/_lib/ensureSchema.js');
const { sql } = await import('../api/_lib/db.js');
const { signSession } = await import('../api/_lib/auth.js');
const { composeMessage, computeSignals, publicItem, PARTNER_TITLE, CHASE_MAX, CHASE_REST_HOURS } = await import('../api/_lib/accountability.js');
const { default: resendHandler } = await import('../api/invoices/resend.js');
const { default: screenHandler } = await import('../api/me/screen.js');
const { default: firstWeekHandler } = await import('../api/admin/first-week.js');
const { recordScreenVisit, firstWeekReport, SCREENS } = await import('../api/_lib/screenVisits.js');
const { screenFor } = await import('../src/lib/screenNames.js');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const dayStr = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(handler, userId, { method = 'POST', body, query = {}, claims = {} } = {}) {
  const req = { method, url: '/api/x', query, body, headers: { ...(userId ? { cookie: `ivy_session=${signSession(userId, claims)}` } : {}), origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}
const mkOwner = async (tag, { type = 'regular', tester = false, createdHoursAgo = 1, email } = {}) => {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role, user_type, is_tester, created_at)
    VALUES (${email || `stk-${tag}-${S}@example.com`}, 'x', 'Stick Owner', NOW(), 'owner', ${type}, ${tester}, ${ago(createdHoursAgo)}) RETURNING id`).rows[0];
  users.push(u.id);
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${ws}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
  return { userId: u.id, ws };
};

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] the daily notification');
  const it = (phrase, href) => ({ phrase, href });
  let m = composeMessage({ kind: 'digest', items: [it('reply to Jane', '/messages?client=1')] });
  assert(m.title === '1 thing needs you today' && m.body === 'Reply to Jane.' && m.url === '/messages?client=1', 'one thing: says so, and tapping opens that exact item');
  m = composeMessage({ kind: 'digest', items: [it('reply to Jane', '/a'), it('chase 2 overdue invoices', '/b')] });
  assert(m.title === '2 things need you today' && m.body === 'Reply to Jane and chase 2 overdue invoices.' && m.url === '/dashboard', 'two things: the count, the list, and Home (where each has its button)');
  m = composeMessage({ kind: 'digest', items: [it('reply to Jane', '/a'), it('chase 2 overdue invoices', '/b'), it('send a document', '/c')] });
  assert(m.title === '3 things need you today' && m.body === 'Reply to Jane, chase 2 overdue invoices and send a document.', 'three things');
  m = composeMessage({ kind: 'digest', items: [it('a', '/a'), it('b', '/b'), it('c', '/c'), it('d', '/d'), it('e', '/e')] });
  assert(m.title === 'Your top 3 for today' && m.body === 'A, b and c. 2 more are waiting in Ivy.', 'more than three: the top three, and an honest count of the rest');
  m = composeMessage({ kind: 'digest', items: [it('a', '/a'), it('b', '/b'), it('c', '/c'), it('d', '/d')] });
  assert(/1 more is waiting in Ivy\.$/.test(m.body), 'grammar holds for one more');
  assert(m.subject === m.title && m.heading === m.title, 'the email version carries the same headline');
  assert(composeMessage({ kind: 'away1', items: [] }).title === PARTNER_TITLE && composeMessage({ kind: 'away2', items: [it('a', '/a')] }).title === PARTNER_TITLE, 'the check-ins after days away keep their own gentle title');
  assert(!/[–—]/.test(JSON.stringify([1, 2, 3, 5].map((n) => composeMessage({ kind: 'digest', items: Array.from({ length: n }, (_, i) => it(`thing ${i}`, '/x')) })))), 'no dashes in any of it');

  console.log('\n[2] chase overdue invoices from Home');
  const a = await mkOwner('a');
  const b = await mkOwner('b');
  let n = 0;
  const inv = async (ws, { status = 'overdue', email = 'c@example.com', name = 'Jordan Reyes', due = -5, remindedAt = null, rate = 60 } = {}) => {
    n += 1;
    return (await sql`
      INSERT INTO invoices (workspace_id, number, client_name, client_email, items, status, due_date, sent_at, last_overdue_reminder_at)
      VALUES (${ws}, ${`ST-${S}-${n}`}, ${name}, ${email}, ${JSON.stringify([{ description: 'Session', quantity: 1, rate }])}::jsonb,
              ${status}, ${dayStr(due)}, ${ago(24 * 10)}, ${remindedAt})
      RETURNING id`).rows[0].id;
  };
  const eligible = await inv(a.ws, { name: 'Jordan Reyes' });
  const noEmail = await inv(a.ws, { email: null, name: 'Nia Noemail' });
  const justReminded = await inv(a.ws, { name: 'Rae Reminded', remindedAt: ago(2) });
  const oldReminder = await inv(a.ws, { name: 'Omar Older', remindedAt: ago(CHASE_REST_HOURS + 5) });
  const notDue = await inv(a.ws, { status: 'sent', due: 6, name: 'Sam Notdue' });
  const others = await inv(b.ws, { name: 'Other Business Client' });
  const overdueItem = async (ws) => (await computeSignals(ws)).find((i) => i.key === 'invoices_overdue');
  let item = await overdueItem(a.ws);
  assert(item && item.count === 4, 'all four overdue invoices are counted');
  assert(JSON.stringify([...item.chase.invoiceIds].sort()) === JSON.stringify([eligible, oldReminder].sort()), 'only the ones a reminder can go to now are offered: an email address on file, and no reminder in the last day');
  assert(!item.chase.invoiceIds.includes(noEmail) && !item.chase.invoiceIds.includes(justReminded) && !item.chase.invoiceIds.includes(notDue) && !item.chase.invoiceIds.includes(others), 'never one with no email, one reminded two hours ago, one that is not due, or another business\'s');
  assert(/Jordan|Omar/.test(item.chase.to) && !/Reyes|Older/.test(item.chase.to), 'the confirm line uses first names only');
  assert(/1 reminded in the last day/.test(item.detail), 'and the row says one was already reminded');
  const pub = publicItem(item);
  assert(pub.chase && pub.chase.invoiceIds.length === 2 && !('ids' in pub), 'Home is told which ones, and nothing else internal');
  assert(!(await overdueItem(b.ws)).chase.invoiceIds.includes(eligible), 'each owner is only ever offered their own');
  assert(CHASE_MAX === 10, 'at most ten at a time');
  // sending
  let r = await call(resendHandler, a.userId, { body: { id: eligible } });
  let row = (await sql`SELECT status, last_overdue_reminder_at FROM invoices WHERE id = ${eligible}`).rows[0];
  assert(r.statusCode === 200 && row.last_overdue_reminder_at && Date.now() - new Date(row.last_overdue_reminder_at).getTime() < 60000, 'sending the reminder marks the invoice as reminded just now (so the automatic one does not follow it the same day)');
  r = await call(resendHandler, a.userId, { body: { id: notDue } });
  row = (await sql`SELECT last_overdue_reminder_at FROM invoices WHERE id = ${notDue}`).rows[0];
  assert(r.statusCode === 200 && row.last_overdue_reminder_at === null, 're-sending an invoice that is not overdue is not counted as a chase');
  r = await call(resendHandler, b.userId, { body: { id: oldReminder } });
  row = (await sql`SELECT last_overdue_reminder_at FROM invoices WHERE id = ${oldReminder}`).rows[0];
  assert(r.statusCode === 400 && Date.now() - new Date(row.last_overdue_reminder_at).getTime() > 3600e3, 'another business cannot chase (or touch) this one');
  await sql`UPDATE invoices SET status = 'overdue' WHERE id = ${eligible}`; // what the hourly job does once it is past due again
  item = await overdueItem(a.ws);
  assert(!item.chase.invoiceIds.includes(eligible) && item.chase.invoiceIds.includes(oldReminder) && /2 reminded in the last day/.test(item.detail), 'once chased, it is not offered again for a day');
  const card = read('src/features/dashboard/AttentionCard.jsx');
  assert(/data-chase-confirm/.test(card) && /Email a reminder with a link to pay to \{it\.chase\.to\}\?/.test(card) && /onClick=\{\(\) => sendChase\(it\.chase\.invoiceIds\)\}/.test(card), 'Home asks once before anything is sent');
  assert(/'Idempotency-Key': `chase-\$\{id\}-\$\{tap\}`/.test(card) && /disabled=\{chaseBusy\}/.test(card), 'a double tap or a network retry cannot send two, and a later try after a failure is a fresh attempt');
  assert(/could not be sent/.test(card) && /reminders'\} sent\./.test(card) && (card.match(/\{chaseNote\}/g) || []).length === 2, 'and it says plainly what went out and what did not, even after the row has gone');
  assert(/last_overdue_reminder_at = \$\{inv\.last_overdue_reminder_at \|\| null\}/.test(read('api/invoices/resend.js')), 'a reminder that failed to send is not recorded as sent');

  console.log('\n[3] which screen was opened');
  assert(screenFor('/dashboard') === 'dashboard' && screenFor('/finance', '?section=services') === 'finance' && screenFor('/clients', '?view=rewards') === 'clients-rewards' && screenFor('/clients', '?view=reminders') === 'clients-reminders' && screenFor('/clients', '?id=abc') === 'clients' && screenFor('/programs/123/lessons') === 'programs', 'the app turns an address into a screen name');
  assert(screenFor('/admin') === null && screenFor('/me') === null && screenFor('/book/some-business') === null && screenFor('') === null && screenFor('/invoice/secret-token') === null, 'anything else is not reported at all (Admin, the client portal, public pages, links with tokens)');
  for (const p of ['/dashboard', '/progress', '/calendar', '/clients', '/finance', '/ivy', '/messages', '/programs', '/automation', '/reviews', '/website', '/shops', '/documents', '/account', '/more']) {
    if (!Object.prototype.hasOwnProperty.call(SCREENS, screenFor(p))) assert(false, `${p} maps to a name the server accepts`);
  }
  assert(Object.keys(SCREENS).length === 17, 'the server accepts seventeen screen names and no others');
  const c = await mkOwner('c');
  assert(await recordScreenVisit({ userId: c.userId, workspaceId: c.ws, screen: 'dashboard' }) === true, 'a known screen is counted');
  await recordScreenVisit({ userId: c.userId, workspaceId: c.ws, screen: 'dashboard' });
  let rows = (await sql`SELECT screen, visits FROM screen_visits WHERE user_id = ${c.userId}`).rows;
  assert(rows.length === 1 && rows[0].visits === 2, 'one row per screen per day, with a count');
  for (const bad of ['', 'Dashboard', '/dashboard', 'clients?view=x', "x'; DROP TABLE users;--", 'jordan@example.com', null, undefined, 'constructor', '__proto__']) {
    if (await recordScreenVisit({ userId: c.userId, workspaceId: c.ws, screen: bad }) !== false) assert(false, `rejects ${JSON.stringify(bad)}`);
  }
  rows = (await sql`SELECT screen FROM screen_visits WHERE user_id = ${c.userId}`).rows;
  assert(rows.length === 1, 'anything that is not on the list is dropped: no free text ever reaches the table');
  r = await call(screenHandler, c.userId, { body: { screen: 'finance' } });
  assert(r.statusCode === 204 && (await sql`SELECT 1 FROM screen_visits WHERE user_id = ${c.userId} AND screen = 'finance'`).rows.length === 1, 'the app reports a screen and gets an empty "ok"');
  r = await call(screenHandler, c.userId, { body: { screen: 'calendar' }, claims: { imp: users[0] } });
  assert(r.statusCode === 204 && (await sql`SELECT 1 FROM screen_visits WHERE user_id = ${c.userId} AND screen = 'calendar'`).rows.length === 0, 'an operator viewing as this owner is never counted as the owner');
  const clientOnly = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role) VALUES (${`stk-cl-${S}@example.com`}, 'x', 'Stick Client', NOW(), 'client') RETURNING id`).rows[0];
  users.push(clientOnly.id);
  r = await call(screenHandler, clientOnly.id, { body: { screen: 'dashboard' } });
  assert(r.statusCode === 204 && (await sql`SELECT 1 FROM screen_visits WHERE user_id = ${clientOnly.id}`).rows.length === 0, 'client accounts are not tracked');
  r = await call(screenHandler, null, { body: { screen: 'dashboard' } });
  assert(r.statusCode === 401, 'signed out: refused');
  r = await call(screenHandler, c.userId, { method: 'GET' });
  assert(r.statusCode === 405, 'it only accepts a report, it never reads anything back');
  const shell = read('src/components/layout/AppShell.jsx');
  assert(/if \(ctx\?\.isOwner && !impersonating && !walled\) trackScreen\(location\.pathname, location\.search\);/.test(shell), 'the app reports for owners only, never while viewing as someone');
  assert(/screen_visits/.test(read('api/cron/db-prune.js')) && /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(read('api/_lib/schema.js').split('CREATE TABLE IF NOT EXISTS screen_visits')[1].slice(0, 300)), 'the record is cleared after six months and goes when the account is deleted');

  console.log('\n[4] Admin > First week');
  // Counting "began" two days ago for this run; build a small cohort on top.
  await sql`UPDATE screen_visits SET first_at = ${ago(49)}, last_at = ${ago(49)} WHERE user_id = ${c.userId}`;
  const before = await firstWeekReport({ days: 30 });
  const d = await mkOwner('d', { createdHoursAgo: 40 });
  const e = await mkOwner('e', { createdHoursAgo: 40 });
  const never = await mkOwner('never', { createdHoursAgo: 40 });
  const tester = await mkOwner('tester', { createdHoursAgo: 40, tester: true });
  const comped = await mkOwner('comped', { createdHoursAgo: 40, type: 'sponsored' });
  const seed = (who, screen, hoursAgo) => sql`
    INSERT INTO screen_visits (user_id, workspace_id, screen, day, visits, first_at, last_at)
    VALUES (${who.userId}, ${who.ws}, ${screen}, (${ago(hoursAgo)}::timestamptz AT TIME ZONE 'UTC')::date, 1, ${ago(hoursAgo)}, ${ago(hoursAgo)})
    ON CONFLICT (user_id, screen, day) DO UPDATE SET visits = screen_visits.visits + 1, last_at = EXCLUDED.last_at`;
  await seed(d, 'dashboard', 39); await seed(d, 'calendar', 38); await seed(d, 'finance', 5);
  await seed(e, 'dashboard', 39);
  await seed(tester, 'dashboard', 39); await seed(tester, 'website', 39);
  await seed(comped, 'dashboard', 39); await seed(comped, 'website', 39);
  const rep = await firstWeekReport({ days: 30 });
  const delta = (key) => (rep.screens.find((s) => s.screen === key)?.accounts || 0) - (before.screens.find((s) => s.screen === key)?.accounts || 0);
  assert(rep.cohort - before.cohort === 3, 'three new businesses are counted (the test account and the complimentary one are left out)');
  assert(delta('dashboard') === 2 && delta('calendar') === 1 && delta('finance') === 1 && delta('website') === 0, 'per screen: how many of them reached it (nothing from the left-out accounts)');
  assert(rep.daysActive.never - before.daysActive.never === 1 && (rep.daysActive.oneDay + rep.daysActive.twoToThree) - (before.daysActive.oneDay + before.daysActive.twoToThree) === 2, 'and how many never opened the app or came back on other days');
  assert(rep.screens.every((s) => s.pct >= 0 && s.pct <= 100 && s.label === SCREENS[s.screen]), 'shares are of the whole group, with plain screen names');
  assert(!/@|[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(rep)) && !/Stick Owner/.test(JSON.stringify(rep)), 'the report is counts only: no emails, names or account ids');
  // gone quiet: an account more than a week old whose last screen was over a week ago
  const quiet = await mkOwner('quiet', { createdHoursAgo: 24 * 12 });
  await sql`UPDATE screen_visits SET first_at = ${ago(24 * 13)}, last_at = ${ago(24 * 13)} WHERE user_id = ${c.userId} AND screen = 'dashboard'`;
  await seed(quiet, 'dashboard', 24 * 11); await seed(quiet, 'website', 24 * 10);
  const rep2 = await firstWeekReport({ days: 30 });
  const lastOf = (x, key) => x.wentQuiet.lastScreens.find((s) => s.screen === key)?.accounts || 0;
  assert(lastOf(rep2, 'website') - lastOf(rep, 'website') === 1 && rep2.wentQuiet.accounts - rep.wentQuiet.accounts === 1, 'a business that stopped coming is counted under the last screen it saw');
  assert(lastOf(rep2, 'finance') === lastOf(rep, 'finance'), 'one that was here today is not called quiet');
  assert((await firstWeekReport({ days: 12345 })).days === 30 && (await firstWeekReport({ days: 90 })).days === 90, 'the window is 30, 60 or 90 days, nothing else');
  // who may read it
  r = await call(firstWeekHandler, d.userId, { method: 'GET' });
  assert(r.statusCode !== 200 && !r.body?.screens, 'a business account cannot read it');
  r = await call(firstWeekHandler, null, { method: 'GET' });
  assert(r.statusCode !== 200, 'nor a signed-out visitor');
  const admin = await mkOwner('admin', { email: process.env.SUPER_ADMIN_EMAIL });
  r = await call(firstWeekHandler, admin.userId, { method: 'GET', query: { days: '30' } });
  assert(r.statusCode === 200 && Array.isArray(r.body.screens) && typeof r.body.cohort === 'number', 'the operator can');
  const tab = read('src/features/admin/FirstWeekTab.jsx');
  assert(/import FirstWeekTab from '\.\/FirstWeekTab\.jsx';/.test(read('src/features/admin/AdminPage.jsx')) && /tab === 'firstweek'\s+&& <FirstWeekTab\/>/.test(read('src/features/admin/AdminPage.jsx')), 'it is a tab in Admin (so its code is only handed to the operator, like the rest of Admin)');
  assert(/Nothing counted yet/.test(tab) && /Test, complimentary and operator accounts are left out/.test(tab), 'it says when there is nothing to show yet, and who is left out');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

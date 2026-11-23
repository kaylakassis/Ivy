// Retired features: email campaigns, expense tracking, time tracking.
//   [1] nothing new can be made or sent, and the answer is a plain sentence
//   [2] what people already logged can still be read, exported and taken away
//   [3] Ivy no longer has the tools, and says so instead of guessing
//   [4] the screens are gone, old links land somewhere sensible
//   [5] the website no longer claims any of it
//
// Run: node --import ./tests/bootstrap.mjs ./tests/retired-features.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { IVY_TOOLS, executeIvyTool } from '../api/_lib/ivyTools.js';
import { buildAccountExport } from '../api/_lib/accountExport.js';
import { RETIRED_MESSAGES, retiredWrite } from '../api/_lib/retired.js';
import { TOOL_STACK, STACK_TOTAL } from '../src/lib/pricing.js';
import campaignsIndex from '../api/campaigns/index.js';
import campaignById from '../api/campaigns/[id].js';
import campaignSend from '../api/campaigns/[id]/send.js';
import expensesIndex from '../api/expenses/index.js';
import expenseById from '../api/expenses/[id].js';
import timeIndex from '../api/time-entries/index.js';
import timeById from '../api/time-entries/[id].js';
import timeStop from '../api/time-entries/stop.js';
import timeBill from '../api/time-entries/bill.js';
import financeIndex from '../api/finance/index.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'localhost:3000';
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const gone = (p) => !existsSync(new URL(`../${p}`, import.meta.url));

const sentMail = [];
globalThis.fetch = async (url, init = {}) => {
  if (/api\.resend\.com/.test(String(url))) sentMail.push(String(init.body || ''));
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(handler, { method = 'GET', userId, query = {}, body } = {}) {
  const req = { method, url: `/api/x?n=${Math.random()}`, query, body, headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}) } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}

async function main() {
  await ensureSchemaApplied();
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role) VALUES (${`retired-${S}@example.com`}, 'x', 'Rita Retired', NOW(), 'owner') RETURNING id, email, name`).rows[0];
  users.push(u.id);
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  // What this owner logged before the features were retired.
  const exp = (await sql`INSERT INTO expenses (workspace_id, date, amount, category, vendor) VALUES (${ws}, CURRENT_DATE - 10, 84.5, 'supplies', 'Linen Co') RETURNING id`).rows[0].id;
  const te = (await sql`INSERT INTO time_entries (workspace_id, description, started_at, ended_at, duration_seconds, status) VALUES (${ws}, 'Prep work', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours', 3600, 'stopped') RETURNING id`).rows[0].id;
  const camp = (await sql`INSERT INTO email_campaigns (workspace_id, subject, body, audience) VALUES (${ws}, 'Old draft', 'Hello', 'all-clients') RETURNING id`).rows[0].id;

  console.log('\n[1] nothing new can be made or sent');
  let r = await call(campaignsIndex, { userId: u.id });
  assert(r.statusCode === 200 && Array.isArray(r.body.campaigns) && r.body.campaigns.length === 0 && r.body.retired === true, 'campaigns: an older app sees an empty list, not an error');
  r = await call(campaignsIndex, { method: 'POST', userId: u.id, body: { subject: 'New', body: 'Hi' } });
  const r2 = await call(campaignSend, { method: 'POST', userId: u.id, query: { id: camp } });
  const r3 = await call(campaignById, { method: 'DELETE', userId: u.id, query: { id: camp } });
  assert([r, r2, r3].every((x) => x.statusCode === 410 && x.body.code === 'feature-retired' && x.body.error === RETIRED_MESSAGES.campaigns), 'campaigns: writing, sending or deleting one gets one plain sentence');
  assert(sentMail.length === 0 && (await sql`SELECT status FROM email_campaigns WHERE id = ${camp}`).rows[0].status === 'draft', 'campaigns: nothing was sent, and the old draft is still in the database untouched');
  r = await call(campaignsIndex, {});
  assert(r.statusCode === 401, 'campaigns: still nothing for someone who is not signed in');

  for (const [label, handler, opts] of [
    ['a new expense', expensesIndex, { method: 'POST', body: { amount: 10, category: 'supplies' } }],
    ['editing an expense', expenseById, { method: 'PATCH', query: { id: exp }, body: { amount: 1 } }],
    ['deleting an expense', expenseById, { method: 'DELETE', query: { id: exp } }],
    ['starting a timer', timeIndex, { method: 'POST', body: { description: 'New' } }],
    ['editing a time entry', timeById, { method: 'PATCH', query: { id: te }, body: { description: 'x' } }],
    ['deleting a time entry', timeById, { method: 'DELETE', query: { id: te } }],
    ['stopping a timer', timeStop, { method: 'POST' }],
    ['billing time to an invoice', timeBill, { method: 'POST', body: { entryIds: [te] } }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    r = await call(handler, { userId: u.id, ...opts });
    assert(r.statusCode === 410 && r.body.code === 'feature-retired' && /no longer part of Ivy/.test(r.body.error) && /is safe/.test(r.body.error), `${label}: refused with a plain sentence that says the data is safe`);
  }
  const after = (await sql`SELECT (SELECT amount FROM expenses WHERE id = ${exp}) AS amount, (SELECT description FROM time_entries WHERE id = ${te}) AS d,
    (SELECT COUNT(*)::int FROM expenses WHERE workspace_id = ${ws}) AS ne, (SELECT COUNT(*)::int FROM time_entries WHERE workspace_id = ${ws}) AS nt`).rows[0];
  assert(Number(after.amount) === 84.5 && after.d === 'Prep work' && after.ne === 1 && after.nt === 1, 'nothing was added, changed or deleted');
  assert(Object.values(RETIRED_MESSAGES).every((m) => !/[–—]/.test(m)) && retiredWrite({ method: 'GET' }, mkRes(), 'expenses') === false, 'the messages are plain words, and reading is never refused');

  console.log('\n[2] what was logged is still theirs');
  r = await call(expensesIndex, { userId: u.id });
  assert(r.statusCode === 200 && JSON.stringify(r.body).includes('Linen Co'), 'expenses can still be read (an older app keeps showing them)');
  r = await call(timeIndex, { userId: u.id });
  assert(r.statusCode === 200 && JSON.stringify(r.body).includes('Prep work'), 'time entries can still be read');
  const exported = await buildAccountExport(u);
  assert(exported.expenses?.length === 1 && exported.expenses[0].vendor === 'Linen Co' && exported.time_entries?.length === 1 && exported.time_entries[0].description === 'Prep work',
    'both are in "download my data"');
  r = await call(financeIndex, { userId: u.id });
  assert(r.statusCode === 200 && r.body.summary.pastEntries.expenses === 1 && r.body.summary.pastEntries.timeEntries === 1, 'Money knows this owner has past entries, so it keeps offering their expense export');
  const u2 = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role) VALUES (${`retired2-${S}@example.com`}, 'x', 'Nia New', NOW(), 'owner') RETURNING id`).rows[0];
  users.push(u2.id);
  await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at) VALUES (${u2.id}, 'active', NOW() + INTERVAL '30 days', NOW())`;
  r = await call(financeIndex, { userId: u2.id });
  assert(r.body.summary.pastEntries.expenses === 0, 'an owner who never logged any is offered nothing about it');
  r = await call(expensesIndex, { userId: u2.id });
  assert(r.statusCode === 200 && !JSON.stringify(r.body).includes('Linen Co'), 'and never sees another business\'s entries');
  const schema = read('api/_lib/schema.js');
  assert(/UPDATE time_entries SET[\s\S]{0,300}status = 'stopped'[\s\S]{0,80}WHERE status = 'running';/.test(schema), 'a timer left running is stopped once, quietly, keeping the time it had run');

  console.log('\n[3] Ivy');
  const names = IVY_TOOLS.map((t) => t.name);
  const removed = ['create_campaign', 'send_campaign', 'list_expenses', 'get_pl_summary', 'create_expense', 'create_time_entry'];
  assert(removed.every((n) => !names.includes(n)), 'Ivy no longer has the six tools');
  const tried = await executeIvyTool('create_expense', { amount: 5, category: 'supplies' }, { workspaceId: ws, userId: u.id, sessionId: null }).catch((e) => ({ error: e.message }));
  assert(tried?.error && (await sql`SELECT COUNT(*)::int AS n FROM expenses WHERE workspace_id = ${ws}`).rows[0].n === 1, 'asking for a removed tool by name does nothing');
  const guide = read('api/_lib/ivy.js');
  assert(removed.every((n) => !guide.includes(n)), 'her instructions no longer mention them');
  assert(/There is no mass email/.test(guide) && /Ivy does not track costs or hours/.test(guide) && /never\s+estimate a profit figure/.test(guide), 'she is told to say plainly what she cannot do, and never to guess a profit figure');
  assert(/two groups across the top/.test(guide) && !/"Track": Expenses, Time/.test(guide) && !/CAMPAIGNS \(sidebar/.test(guide), 'her directions match the screens as they are now');

  console.log('\n[4] the screens');
  assert(['src/features/campaigns/Campaigns.jsx', 'src/features/campaigns/state.js', 'src/features/finance/Expenses.jsx', 'src/features/finance/Time.jsx', 'src/features/finance/timeState.js', 'api/_lib/campaigns.js'].every(gone), 'the three screens and the campaign sender are gone');
  const fin = read('src/features/finance/Finance.jsx'); const app = read('src/App.jsx');
  assert(gone('src/features/grow/Marketing.jsx') && !/campaign/i.test(read('src/lib/nav.js')), 'the Marketing screen itself is gone too (workflows are Automation; rewards are in Clients)');
  assert(/path="\/campaigns"\s+element=\{<MarketingRedirect tab="workflows"\/>\}/.test(app), 'an old /campaigns link lands on Automation');
  assert(!/id: 'track'/.test(fin) && !/id: 'expenses'/.test(fin) && !/id: 'time'/.test(fin), 'Money has no Track group');
  assert(/hasPastExpenses && \(/.test(fin) && /Year-end income summary/.test(fin), 'the export menu offers the income summary to everyone, and past expenses only to owners who have some');
  const tips = read('src/lib/tutorials.js') + read('src/features/onboarding/Walkthrough.jsx');
  assert(!/campaign|expense|time.track/i.test(tips), 'the tours and tips no longer mention any of it');

  console.log('\n[5] the website');
  const site = ['src/features/marketing/site/SiteTour.jsx', 'src/features/marketing/site/SiteFeatures.jsx', 'src/features/marketing/site/SiteHome.jsx', 'src/features/marketing/verticalsData.js', 'public/llms.txt', 'public/llms-full.txt'];
  const claims = site.filter((p) => /email campaign|campaigns? (to|for) |log expenses|expense (log|track)|time track|billable (hours|timers)|Schedule.C/i.test(read(p)));
  assert(claims.length === 0, `no page claims campaigns, expense tracking or time tracking (${claims.join(', ') || 'none'})`);
  const labels = TOOL_STACK.map((t) => t.label).join(' | ');
  assert(!/marketing|bookkeeping/i.test(labels) && TOOL_STACK.length === 5 && STACK_TOTAL === TOOL_STACK.reduce((s, t) => s + t.monthly, 0),
    `the price comparison only lists tools Ivy still replaces (${labels}: $${STACK_TOTAL})`);
  const posts = ['ivy-vs-dubsado', 'ivy-vs-honeybook', 'ivy-vs-jobber', 'email-marketing-solo-business', 'quarterly-taxes-explained', 'self-employed-tax-deductions'].map((f) => read(`public/blog/${f}.html`)).join('\n');
  assert(!/Ivy includes email campaigns|Email campaigns<\/td><td><span class="yes">Included|Log expenses in Ivy|Ivy tracks revenue and deductible expenses/.test(posts), 'the blog posts that said so have been corrected');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

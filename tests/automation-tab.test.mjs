// Marketing was taken apart:
//   [1] the tab is "Automation": what Ivy noticed the owner repeats, and
//       their workflows
//   [2] Rewards and Reminders (birthday, check-in, book again) are sections
//       of the Clients tab
//   [3] every old address still lands in the right place
//   [4] "Ivy noticed" comes from the owner's own records, with the evidence
//
// Run: node --import ./tests/bootstrap.mjs ./tests/automation-tab.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, invalidateUserCache } from '../api/_lib/auth.js';
import workflowsHandler from '../api/workflows/index.js';
import dismissHandler from '../api/me/dismiss-suggestion.js';
import { NAV, TITLES, visibleNavFor, hideableNav } from '../src/lib/nav.js';
import { TUTORIALS } from '../src/lib/tutorials.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(handler, userId, { method = 'GET', query = {}, body } = {}) {
  const req = { method, url: '/api/x', query, body, headers: { cookie: `ivy_session=${signSession(userId)}`, origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] the tab is Automation');
  const item = NAV.find((n) => n.id === 'automation');
  assert(item && item.label === 'Automation' && item.to === '/automation', 'the menu item is called Automation and opens /automation');
  assert(!NAV.some((n) => n.id === 'marketing' || n.label === 'Marketing' || n.to === '/marketing'), 'there is no Marketing item left in the menu');
  assert(TITLES.automation?.title === 'Automation' && !TITLES.marketing, 'the screen is titled Automation');
  assert(hideableNav().some((n) => n.id === 'automation'), 'an owner can still hide it');
  assert(!visibleNavFor({ hiddenNav: ['marketing'] }).some((n) => n.id === 'automation') && visibleNavFor({}).some((n) => n.id === 'automation'), 'an owner who had hidden Marketing still has it hidden under its new name');
  assert(!existsSync(new URL('../src/features/grow/Marketing.jsx', import.meta.url)), 'the old Marketing hub is gone');
  const page = read('src/features/workflows/Workflows.jsx');
  assert(/<h2 className="page-title"[^>]*>Automation<\/h2>/.test(page) && /<Noticed noticed=\{noticed\} onChanged=\{refresh\}\/>/.test(page) && /Your workflows/.test(page), 'the screen has "Ivy noticed" first, then "Your workflows"');
  assert(!/ClientAutomations/.test(page.replace(/\/\/.*$/gm, '')) && /to="\/clients\?view=reminders"/.test(page), 'the birthday-type messages are not on it; one line says where they went');
  assert(/at least five/.test(page) && /within two days/.test(page) && /const SAMPLE_MIN = 5;/.test(read('api/_lib/workflowSuggest.js')) && /const WINDOW_HOURS = 48;/.test(read('api/_lib/workflowSuggest.js')), 'when nothing has been noticed, it says what Ivy watches for, using the detector\'s real thresholds (5 times, 2 days)');
  assert(TUTORIALS.automation?.title === 'Automation' && !TUTORIALS.marketing && /Rewards and reminders are in Clients/.test(JSON.stringify(TUTORIALS.automation)), 'the screen\'s help says the same');

  console.log('\n[2] Rewards and Reminders are in Clients');
  const clients = read('src/features/clients/Clients.jsx');
  const helpers = clients.slice(clients.indexOf('export const CLIENT_VIEWS = ['), clients.indexOf('function ViewTabs('));
  // eslint-disable-next-line no-new-func
  const { CLIENT_VIEWS, clientViewFor } = new Function(`${helpers.replace(/export /g, '')}; return { CLIENT_VIEWS, clientViewFor };`)();
  assert(CLIENT_VIEWS.map((v) => v.label).join('|') === 'Clients|Rewards|Reminders', 'three sections: Clients, Rewards, Reminders');
  assert(clientViewFor('?view=rewards') === 'rewards' && clientViewFor('?view=reminders') === 'reminders', 'each has its own address');
  assert(clientViewFor('') === 'list' && clientViewFor('?view=folders') === 'list' && clientViewFor('?view=<script>') === 'list' && clientViewFor('?add=1') === 'list', 'anything else is the list (never a blank screen)');
  assert(/const Rewards = lazy\(\(\) => import\('\.\.\/rewards\/Rewards\.jsx'\)\);/.test(clients) && /const Reminders = lazy\(\(\) => import\('\.\.\/workflows\/ClientAutomations\.jsx'\)\);/.test(clients), 'they are the same Rewards and reminder screens as before, loaded only when opened');
  assert(/view === 'rewards' \? <Rewards\/> : <div className="page-pad"><Reminders\/><\/div>/.test(clients) && (clients.match(/<ViewTabs view=\{view\} onPick=\{pickView\}\/>/g) || []).length === 2, 'the section switch is on all three');
  assert(/params\.get\('view'\) && clientViewFor\(location\.search\) === 'list'/.test(clients), 'opening Rewards or Reminders by link is not undone by the old link clean-up');
  assert(/<h2 className="page-title"[^>]*>Reminders<\/h2>/.test(read('src/features/workflows/ClientAutomations.jsx')), 'the reminders section is titled Reminders');

  console.log('\n[3] old addresses');
  const app = read('src/App.jsx');
  const redirect = app.slice(app.indexOf('function MarketingRedirect('), app.indexOf('// /goals?task=X'));
  assert(/path="\/automation" element=\{<Automation \/>\}/.test(app) && /'\/automation': Automation/.test(app), '/automation is a real page');
  assert(/path="\/marketing"\s+element=\{<MarketingRedirect \/>\}/.test(app) && /path="\/workflows"\s+element=\{<MarketingRedirect tab="workflows"\/>\}/.test(app) && /path="\/rewards"\s+element=\{<MarketingRedirect tab="rewards"\/>\}/.test(app) && /path="\/campaigns"\s+element=\{<MarketingRedirect tab="workflows"\/>\}/.test(app), '/marketing, /workflows, /rewards and /campaigns all still answer');
  assert(/want === 'rewards' \|\| want === 'reminders'/.test(redirect) && /p\.set\('view', want\);/.test(redirect) && /`\/clients\?\$\{p\.toString\(\)\}`/.test(redirect), 'the rewards ones go to Clients → Rewards');
  assert(/p\.get\('show'\) === 'reminders' \? 'reminders'/.test(redirect), 'a reminders link goes to Clients → Reminders');
  assert(/`\/automation\$\{q \? `\?\$\{q\}` : ''\}`/.test(redirect) && /p\.delete\('tab'\); p\.delete\('show'\);/.test(redirect), 'everything else goes to Automation, keeping any other part of the link');
  assert(/manage: '\[Reminders\]\(\/marketing\?tab=workflows&show=reminders\)'/.test(read('api/_lib/ivyAppTools.js')), 'the link Ivy gives in chat works in the app on phones today (old address) and lands on Reminders in the new one');
  assert(!/\/marketing\?tab=/.test(read('src/features/dashboard/WorkflowSuggestionCard.jsx')) && /to="\/automation"/.test(read('src/features/dashboard/WorkflowSuggestionCard.jsx')), 'Home\'s "Ivy noticed" card points at Automation');
  const guide = read('api/_lib/ivy.js');
  assert(/AUTOMATION \(menu → "Automation"\)/.test(guide) && /REMINDERS IVY SENDS CLIENTS \(menu → "Clients" → "Reminders"\)/.test(guide) && /REWARDS \/ LOYALTY \(menu → "Clients" → "Rewards"\)/.test(guide) && !/"Marketing"/.test(guide), 'Ivy gives directions to all three new places and never mentions a Marketing tab');

  console.log('\n[4] "Ivy noticed"');
  const mk = async (tag) => {
    const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
      VALUES (${`auto-${tag}-${S}@example.com`}, 'x', 'Auto Owner', NOW(), 'owner') RETURNING id`).rows[0];
    users.push(u.id);
    const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
      VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
    return { userId: u.id, ws };
  };
  const a = await mk('a');
  const b = await mk('b');
  let r = await call(workflowsHandler, a.userId);
  assert(r.statusCode === 200 && Array.isArray(r.body.workflows) && !('noticed' in r.body), 'the plain list (what installed apps ask for) is unchanged');
  r = await call(workflowsHandler, a.userId, { query: { noticed: '1' } });
  assert(r.statusCode === 200 && r.body.noticed && r.body.noticed.suggestion === null && r.body.noticed.evidence === null, 'a business with no habit yet: nothing noticed, nothing invented');
  // A habit: six new clients, each invoiced the same day.
  for (let i = 0; i < 6; i++) {
    const cid = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${a.ws}, ${`Habit Client ${i}`}, 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
      VALUES (${a.ws}, ${`AU-${S}-${i}`}, ${cid}, ${`Habit Client ${i}`}, ${JSON.stringify([{ description: 'Intake', quantity: 1, rate: 50 }])}::jsonb, 'draft')`;
  }
  r = await call(workflowsHandler, a.userId, { query: { noticed: '1' } });
  const n = r.body.noticed;
  assert(n?.suggestion?.signature && n.suggestion.workflow?.triggerType === 'client_created' && Array.isArray(n.suggestion.workflow.actions) && n.suggestion.workflow.actions.length > 0, 'six new clients each invoiced right away: Ivy notices, and offers a workflow that does it');
  const habit = n?.evidence?.habits?.[0];
  assert(habit && habit.matched === 6 && habit.of === 6 && habit.examples.length > 0 && habit.examples.every((e) => /Habit Client \d/.test(e)), 'with the evidence: 6 of 6, and which clients');
  assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(JSON.stringify(n.evidence)), 'the evidence carries names and dates, never internal ids');
  r = await call(workflowsHandler, b.userId, { query: { noticed: '1' } });
  assert(r.body.noticed.suggestion === null && !/Habit Client/.test(JSON.stringify(r.body)), 'another business sees none of it');
  // "Not now" on the Automation screen: gone, and stays gone.
  r = await call(dismissHandler, a.userId, { method: 'POST', body: { signature: n.suggestion.signature } });
  invalidateUserCache(a.userId);
  assert(r.statusCode === 200, 'the owner can say "Not now"');
  r = await call(workflowsHandler, a.userId, { query: { noticed: '1' } });
  assert(r.body.noticed.suggestion?.signature !== n.suggestion.signature && (r.body.noticed.suggestion === null) === (r.body.noticed.evidence === null), 'after that it is not offered again');
  r = await call(workflowsHandler, null, { query: { noticed: '1' } }).catch(() => ({ statusCode: 401 }));
  assert(r.statusCode === 401, 'signed out: nothing');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

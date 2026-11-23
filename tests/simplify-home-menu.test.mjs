// The "less to face" pass, part one:
//   [1] the menu starts with five places; the rest waits under "More"
//       until the business uses it
//   [2] "in use" is worked out from the owner's own records only
//   [3] one prompt at a time
//   [4] Home is about today; the rest lives on Progress
//   [5] set-up shows one next step
//
// Run: node --import ./tests/bootstrap.mjs ./tests/simplify-home-menu.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { usedNavFor, USAGE_NAV_IDS } from '../api/_lib/navUsage.js';
import meHandler from '../api/me/index.js';
import { NAV, CORE_NAV, splitNav, visibleNavFor, TITLES } from '../src/lib/nav.js';
import { claimPrompt, releasePrompt, topPrompt, PROMPT_RANK, _resetPromptsForTests } from '../src/lib/promptQueue.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ids = (list) => list.map((n) => n.id).join(',');
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function me(userId) {
  const req = { method: 'GET', url: '/api/me', query: {}, headers: { cookie: `ivy_session=${signSession(userId)}`, origin: 'http://localhost:3000', host: 'localhost:3000' } };
  const res = mkRes(); res.req = req;
  await meHandler(req, res);
  return res;
}

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] five places, then More');
  assert(CORE_NAV.join(',') === 'dashboard,calendar,clients,finance,ivy', 'the five are Home, Calendar, Clients, Money, Ivy, in the same order as the phone bar');
  const bar = read('src/components/layout/MobileBottomNav.jsx');
  const barIds = [...bar.slice(bar.indexOf('const PRIMARY = ['), bar.indexOf('const ADMIN_ITEM')).matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
  assert(barIds.join(',') === CORE_NAV.join(','), 'the phone bar and the menu agree');
  const owner = visibleNavFor({ isSuperAdmin: false });
  let g = splitNav(owner, []);
  assert(ids(g.main) === 'dashboard,calendar,clients,finance,ivy', 'a new business sees exactly five');
  assert(ids(g.more) === 'comms,programs,automation,reviews,website,shops,docs', 'everything else is under More, nothing is lost');
  assert(g.main.length + g.more.length === owner.length, 'every screen is in one list or the other');
  g = splitNav(owner, ['website', 'docs']);
  assert(ids(g.main) === 'dashboard,calendar,clients,finance,ivy,website,docs' && !g.more.some((n) => n.id === 'website' || n.id === 'docs'), 'a tool the business uses moves into the menu by itself');
  for (const unknown of [null, undefined, 'website', { website: true }]) {
    const u = splitNav(owner, unknown);
    assert(u.main.length === 5 && u.more.length === 7, `when usage is not known (${JSON.stringify(unknown)}), the tool waits under More and is still reachable`);
  }
  g = splitNav(visibleNavFor({ isSuperAdmin: true }), []);
  assert(g.main.some((n) => n.id === 'admin') && !g.more.some((n) => n.id === 'admin'), 'the operator always has Admin in the menu');
  assert(!owner.some((n) => n.id === 'admin'), 'and nobody else has it at all');
  g = splitNav(visibleNavFor({ businessType: 'product' }), []);
  assert(ids(g.main) === 'dashboard,clients,finance,ivy', 'a product-only business has no Calendar (four places)');
  g = splitNav(visibleNavFor({ hiddenNav: ['marketing'] }), ['automation']);
  assert(!g.main.concat(g.more).some((n) => n.id === 'automation'), 'an owner who hid Marketing before it was renamed still has Automation hidden');
  g = splitNav(visibleNavFor({ hiddenNav: ['clients', 'website'] }), ['website']);
  assert(!g.main.some((n) => n.id === 'clients') && !g.main.concat(g.more).some((n) => n.id === 'website'), 'a tab the owner hid stays hidden, even when in use');
  assert(USAGE_NAV_IDS.every((id) => NAV.some((n) => n.id === id)) && USAGE_NAV_IDS.length === 7, 'the server tracks usage for exactly the seven tools under More');
  for (const f of ['src/components/layout/Sidebar.jsx', 'src/components/layout/MobileDrawer.jsx', 'src/features/more/MorePage.jsx']) {
    assert(/useNavGroups\(\)/.test(read(f)) && !/visibleNavFor/.test(read(f)), `${f.split('/').pop()} uses the shared split`);
  }
  assert(/more\.some\(\(n\) => pathname === n\.to \|\| pathname\.startsWith\(`\$\{n\.to\}\/`\)\)/.test(read('src/lib/useNavGroups.js')), 'standing on a page under More keeps More open');
  const walk = read('src/features/onboarding/Walkthrough.jsx');
  const steps = [...walk.slice(walk.indexOf('const STEPS = ['), walk.indexOf('const FIND_TIMEOUT_MS')).matchAll(/^\s+(?:\{ )?id: '([\w-]+)'/gm)].map((m) => m[1]);
  assert(steps.join(',') === 'welcome,dashboard,calendar,calendar-share,clients,finance,more,aha-first-booking,ivy-hello', `the first-run tour is nine stops instead of thirteen (${steps.join(', ')})`);

  console.log('\n[2] "in use" comes from the owner\'s own records');
  const mk = async (tag) => {
    const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
      VALUES (${`nav-${tag}-${S}@example.com`}, 'x', 'Nav Owner', NOW(), 'owner') RETURNING id`).rows[0];
    users.push(u.id);
    const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
      VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
    return { userId: u.id, ws };
  };
  const a = await mk('a');
  const b = await mk('b');
  assert(JSON.stringify(await usedNavFor(a.ws)) === '[]', 'a new business uses none of them');
  // B gets one of everything. A must still see none of it.
  const bClient = (await sql`INSERT INTO clients (workspace_id, name, email) VALUES (${b.ws}, 'B Client', ${`bc-${S}@example.com`}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${b.ws}, ${bClient})`;
  await sql`INSERT INTO programs (workspace_id, title) VALUES (${b.ws}, 'B Program')`;
  await sql`INSERT INTO workflows (workspace_id, name, trigger_type) VALUES (${b.ws}, 'B Flow', 'client_created')`;
  await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating) VALUES (${b.ws}, 'B Reviewer', 5)`;
  await sql`INSERT INTO websites (workspace_id, handle, launched) VALUES (${b.ws}, ${`b-site-${S}`}, TRUE)`;
  await sql`INSERT INTO shops (owner_workspace_id, slug, name) VALUES (${b.ws}, ${`b-shop-${S}`}, 'B Shop')`;
  await sql`INSERT INTO documents (workspace_id, name) VALUES (${b.ws}, 'B Waiver')`;
  assert(JSON.stringify(await usedNavFor(b.ws)) === JSON.stringify(USAGE_NAV_IDS), 'a business with something in every tool has all seven in its menu');
  assert(JSON.stringify(await usedNavFor(a.ws)) === '[]', 'and the other business still has none: nothing crosses between accounts');
  // one at a time on A
  await sql`INSERT INTO websites (workspace_id, handle) VALUES (${a.ws}, ${`a-site-${S}`})`;
  assert(JSON.stringify(await usedNavFor(a.ws)) === '[]', 'a website that was opened but never published does not count');
  await sql`UPDATE websites SET launched = TRUE WHERE workspace_id = ${a.ws}`;
  assert(JSON.stringify(await usedNavFor(a.ws)) === '["website"]', 'publishing it does');
  await sql`INSERT INTO reward_rules (workspace_id, type, name) VALUES (${a.ws}, 'visit', 'Every 5th visit')`;
  assert(JSON.stringify(await usedNavFor(a.ws)) === '["website"]', 'a reward does not count towards Automation (rewards live in Clients, which is always in the menu)');
  await sql`INSERT INTO workflows (workspace_id, name, trigger_type) VALUES (${a.ws}, 'A Flow', 'client_created')`;
  assert(JSON.stringify(await usedNavFor(a.ws)) === '["automation","website"]', 'a workflow does');
  const shopB = (await sql`SELECT id FROM shops WHERE owner_workspace_id = ${b.ws}`).rows[0].id;
  await sql`INSERT INTO shop_members (shop_id, workspace_id, status) VALUES (${shopB}, ${a.ws}, 'invited')`;
  assert(!(await usedNavFor(a.ws)).includes('shops'), 'an invitation to a shop that was not accepted does not count');
  await sql`UPDATE shop_members SET status = 'active' WHERE shop_id = ${shopB} AND workspace_id = ${a.ws}`;
  assert((await usedNavFor(a.ws)).includes('shops'), 'joining one does');
  assert(JSON.stringify(await usedNavFor(null)) === '[]' && (await usedNavFor('not-a-uuid')) === null, 'no business: nothing; a lookup that fails: "not known", never a guess');
  let r = await me(a.userId);
  assert(r.statusCode === 200 && JSON.stringify(r.body.usedNav) === '["automation","website","shops"]', 'the app is told which tools are in use when it loads the account');
  r = await me(b.userId);
  assert(r.body.usedNav.length === 7 && r.body.owns?.id === b.ws, 'each owner gets their own list');
  const clientOnly = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
    VALUES (${`nav-c-${S}@example.com`}, 'x', 'Nav Client', NOW(), 'client') RETURNING id`).rows[0];
  users.push(clientOnly.id);
  r = await me(clientOnly.id);
  assert(r.statusCode === 200 && JSON.stringify(r.body.usedNav) === '[]', 'a client account has no business menu to fill');

  console.log('\n[3] one prompt at a time');
  _resetPromptsForTests();
  assert(topPrompt() === null, 'nothing asking: nothing shown');
  claimPrompt('home', PROMPT_RANK.home);
  assert(topPrompt() === 'home', 'one thing asking: it shows');
  claimPrompt('verifyEmail', PROMPT_RANK.verifyEmail);
  assert(topPrompt() === 'verifyEmail', 'the email reminder goes ahead of Home\'s optional prompts');
  claimPrompt('billing', PROMPT_RANK.billing);
  assert(topPrompt() === 'billing', 'a billing problem goes ahead of everything');
  claimPrompt('push', PROMPT_RANK.push);
  assert(topPrompt() === 'billing', 'a later arrival with a lower priority waits');
  releasePrompt('billing');
  assert(topPrompt() === 'verifyEmail', 'when the first is dealt with, the next takes its turn');
  releasePrompt('verifyEmail');
  assert(topPrompt() === 'push', 'then the next');
  claimPrompt('home', PROMPT_RANK.homeRequired);
  assert(topPrompt() === 'home', 'a required set-up step goes ahead of the notifications sheet');
  releasePrompt('home'); releasePrompt('push'); releasePrompt('push');
  assert(topPrompt() === null, 'and the queue empties cleanly');
  const ranks = Object.values(PROMPT_RANK);
  assert(new Set(ranks).size === ranks.length, 'no two kinds of prompt share a priority (so there is never a tie)');
  assert(/usePromptSlot\('billing', .*PROMPT_RANK\.billing\)/.test(read('src/features/billing/SubscriptionBanner.jsx')), 'the billing strip takes a number');
  assert(/usePromptSlot\('verifyEmail', .*PROMPT_RANK\.verifyEmail\)/.test(read('src/components/VerifyEmailBanner.jsx')), 'the email reminder takes a number');
  assert(/usePromptSlot\('push', show, PROMPT_RANK\.push\)/.test(read('src/components/NativePushPrompt.jsx')) && /useExitAnimation\(show && mine\)/.test(read('src/components/NativePushPrompt.jsx')), 'the iPhone notifications sheet takes a number');
  const dash = read('src/features/dashboard/Dashboard.jsx');
  assert(/usePromptSlot\('home', wants, pick === 'ready' \|\| required \? PROMPT_RANK\.homeRequired : PROMPT_RANK\.home\)/.test(dash), 'Home takes one number for whichever prompt it would show');
  const prompt = dash.slice(dash.indexOf('function HomePrompt('), dash.indexOf('export default function Dashboard'));
  const order = [...prompt.matchAll(/pick = '(\w+)'/g)].map((m) => m[1]);
  assert(order.join(',') === 'tail,ready,setup,switch,twoStep,workflow,setup', `Home picks one, in a fixed order (${order.join(' > ')})`);
  assert(/setSetupHidden\(true\); setQuiet\(true\);/.test(prompt) && /if \(!data \|\| quiet\) pick = null;/.test(prompt), 'hiding a prompt does not bring up another one on the same visit');
  assert((dash.match(/<HomePrompt /g) || []).length === 1 && !/<PromoSlot|<SampleDataCard empty=\{false\} onChanged=\{loadDashboard\}/.test(dash), 'there is one prompt slot on Home, not several');

  console.log('\n[4] Home is about today');
  const body = dash.slice(dash.indexOf('export default function Dashboard'));
  assert(/<TodayCard /.test(body) && /<AttentionCard /.test(body) && /<AskIvyCard\/>/.test(body) && /<HeroBand /.test(body), 'Home keeps the greeting, the Ask Ivy box, today and what needs you');
  assert(!/KeyNumbers|GoalsAndTasks|ThisWeekCard|Recent activity/.test(dash), 'the numbers, this week, recent activity and goals are no longer on Home');
  assert(/<Link to="\/progress" className="card" data-home-progress/.test(body), 'one row on Home leads to them');
  assert(/const SHOW = 3;/.test(read('src/features/dashboard/AttentionCard.jsx')), '"Needs your attention" shows three at a time');
  const prog = read('src/features/dashboard/Progress.jsx');
  assert(/<KeyNumbers /.test(prog) && /<ThisWeekCard /.test(prog) && /Recent activity/.test(prog) && /<GoalsAndTasks\/>/.test(prog) && /id="goals"/.test(prog), 'Progress has all four');
  const app = read('src/App.jsx');
  assert(/<Route path="\/progress"\s+element=\{<Progress \/>\} \/>/.test(app) && /'\/progress': Progress/.test(app), 'Progress is a real page');
  assert(/if \(location\.hash === '#goals'\) return <Navigate to=\{`\/progress\$\{location\.search \|\| ''\}#goals`\} replace\/>;/.test(dash), 'old links to Home\'s goals section land on Progress (installed apps and Ivy\'s daily message still use them)');
  assert(/href: '\/dashboard#goals'/.test(read('api/_lib/accountability.js')), 'the server keeps sending the old link, so apps already on phones still work');
  assert(TITLES.progress?.title === 'Progress' && /location\.pathname === '\/progress' \? PROGRESS/.test(read('src/components/layout/AppShell.jsx')), 'the page has its own title at the top');
  assert(/\.ask-ivy-starters \{ display: none !important; \}/.test(read('src/styles/global.css')) && /className="ask-ivy-starters"/.test(read('src/features/dashboard/AskIvyCard.jsx')), 'on a phone the Ask Ivy box is just the box');
  const guide = read('api/_lib/ivy.js');
  assert(/The menu starts with five places: Home, Calendar, Clients, Money and Ivy/.test(guide) && /Home → "See your progress"/.test(guide) && !/sidebar → "Goals"|sidebar → "Workflows"|sidebar → "Rewards"/.test(guide), 'Ivy gives directions for the new menu and the Progress page');

  console.log('\n[5] set-up: one next step');
  const card = dash.slice(dash.indexOf('function SetupCard('), dash.indexOf('// ── hero'));
  assert(/const next = group\.find\(\(i\) => !i\.done\);/.test(card) && !/\.map\(\(item\)/.test(card) && !/Show all steps|ChecklistRow/.test(dash), 'the card shows the next step only, never the list');
  assert(/\{next\.label\}<\/h3>/.test(card) && /\{next\.why\}/.test(card) && /<Link to=\{next\.href\} className="btn btn-primary"/.test(card), 'with what it is, why it matters, and one button that goes there');
  assert(/Hide for now/.test(card), 'and it can still be put away for a week');
  const setup = read('api/_lib/setupStatus.js');
  const whys = [...setup.matchAll(/why: (?:'([^']+)'|"([^"]+)")/g)].map((m) => m[1] || m[2]);
  assert(whys.length >= 9 && whys.every((w) => !/<|>| - |[–—]/.test(w)), 'no step is explained with a web address pattern, a dash or code');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

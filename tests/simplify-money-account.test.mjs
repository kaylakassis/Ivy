// The "less to face" pass, part two:
//   [1] Money opens on who owes you; settings are behind one button
//   [2] the invoice list can ask the server for "unpaid" (sent + overdue)
//   [3] Account is four short pages, and every old link opens the right one
//   [4] the weekly payoff line only says what the records show
//
// Run: node --import ./tests/bootstrap.mjs ./tests/simplify-money-account.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import invoicesHandler from '../api/invoices/index.js';
import { buildWeekStats, payoffLine, renderWeeklyRecap } from '../api/_lib/weeklyRecap.js';
import { payoffParts } from '../src/features/dashboard/payoff.js';

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
async function list(userId, query) {
  const req = { method: 'GET', url: '/api/invoices', query, headers: { cookie: `ivy_session=${signSession(userId)}`, origin: 'http://localhost:3000', host: 'localhost:3000' } };
  const res = mkRes(); res.req = req;
  await invoicesHandler(req, res);
  return res;
}

async function main() {
  await ensureSchemaApplied();
  const mk = async (tag) => {
    const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
      VALUES (${`mny-${tag}-${S}@example.com`}, 'x', 'Money Owner', NOW(), 'owner') RETURNING id`).rows[0];
    users.push(u.id);
    const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
      VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${ws}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
    return { userId: u.id, ws };
  };
  let n = 0;
  const inv = async (ws, status, rate, extra = {}) => {
    n += 1;
    return (await sql`
      INSERT INTO invoices (workspace_id, number, client_name, items, status, due_date, paid_at, paid_amount,
                            last_overdue_reminder_at, due_soon_reminder_sent_at, archived_at)
      VALUES (${ws}, ${`M-${S}-${n}`}, ${extra.client || 'Casey Client'}, ${JSON.stringify([{ description: 'Session', quantity: 1, rate }])}::jsonb,
              ${status}, ${dayStr(extra.due ?? 5)}, ${extra.paidAt || null}, ${extra.paidAt ? rate : null},
              ${extra.overdueReminderAt || null}, ${extra.dueSoonReminderAt || null}, ${extra.archived ? new Date().toISOString() : null})
      RETURNING id`).rows[0].id;
  };
  const a = await mk('a');
  const b = await mk('b');

  console.log('\n[1] Money opens on who owes you');
  const fin = read('src/features/finance/Finance.jsx');
  assert(/const \[tab, setTab\]\s+= useState\('owed'\);/.test(fin), 'the invoice list starts on "Owed to you"');
  const mainTabs = [...fin.slice(fin.indexOf('const MAIN_TABS = ['), fin.indexOf('const OTHER_TABS')).matchAll(/id: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
  const otherTabs = [...fin.slice(fin.indexOf('const OTHER_TABS = ['), fin.indexOf('// Whether a client can pay')).matchAll(/id: '(\w+)', label: '([^']+)'/g)].map((m) => m[1]);
  assert(mainTabs.join('|') === 'Owed to you|Drafts|Paid|All', `four tabs instead of eight (${mainTabs.join(', ')})`);
  assert(otherTabs.join(',') === 'overdue,sent,refunded,voided,archived', 'the other five lists are still there, in a short menu');
  assert(/\['owed', 'all', 'draft', 'sent', 'overdue', 'paid', 'refunded', 'voided', 'archived'\]\.includes\(filterParam\)/.test(fin), 'links that open one list (for example "Chase", which opens Overdue) still work');
  assert(/a\.status === 'overdue' \? -1 : 1/.test(fin), 'overdue invoices come first');
  const section = fin.slice(fin.indexOf('function InvoicesSection('), fin.indexOf('const QUICK_METHODS'));
  assert(!/<PaymentProviderCard\/>|<ManualMethodsCard\/>|<InvoiceDesignCard\/>|<SummaryCard/.test(section) && /data-money-owed/.test(section), 'the list is no longer under three settings cards and four number tiles; one box says what is owed');
  const page = fin.slice(fin.indexOf('export default function Finance()'), fin.indexOf('const MAIN_TABS'));
  assert(/settingsOpen \? \([\s\S]*?<PaymentProviderCard\/>\s*<ManualMethodsCard\/>\s*<InvoiceDesignCard\/>/.test(page) && /data-money-settings onClick=\{\(\) => setSettingsOpen\(true\)\}/.test(page), 'payment processor, other ways to pay and invoice design are behind the Settings button');
  assert(/p\.get\('settings'\) === '1' \|\| p\.get\('design'\) === '1' \|\| \['stripe', 'square', 'paypal'\]\.some\(\(k\) => p\.has\(k\)\)/.test(page), 'coming back from connecting a processor, or following a design link, lands in Settings so the result is on screen');
  assert(/cardsReady === false && \(/.test(section) && /Clients cannot pay you by card yet\./.test(section) && /useState\(null\)/.test(fin.slice(fin.indexOf('function useCardPayments'), fin.indexOf('function InvoicesSection'))), 'an owner with no processor is told so in one line; nothing is said while it is not known');
  assert(/href: '\/finance\?settings=1'/.test(read('api/_lib/setupStatus.js')), 'the "Connect Stripe" set-up step opens Money settings');
  assert(/Money opens on "Owed to you"/.test(read('api/_lib/ivy.js')) && /Money → "Settings" button at the top of the screen/.test(read('api/_lib/ivy.js')), 'Ivy gives directions for the new Money screen');
  assert(/if \(tab === 'owed'\) return 'status=unpaid';/.test(read('src/features/finance/state.js')), 'the app asks the server for unpaid invoices');

  console.log('\n[2] the "unpaid" list');
  const sent = await inv(a.ws, 'sent', 100);
  const overdue = await inv(a.ws, 'overdue', 60, { due: -4 });
  await inv(a.ws, 'draft', 10);
  await inv(a.ws, 'paid', 80, { paidAt: ago(30) });
  await inv(a.ws, 'voided', 15);
  await inv(a.ws, 'overdue', 999, { archived: true });
  const bSent = await inv(b.ws, 'sent', 777, { client: 'Other Business Client' });
  let r = await list(a.userId, { cursor: '', limit: '50', status: 'unpaid' });
  let got = (r.body.invoices || []).map((i) => i.id).sort();
  assert(r.statusCode === 200 && JSON.stringify(got) === JSON.stringify([sent, overdue].sort()), 'unpaid = sent and overdue together; drafts, paid, void and archived are left out');
  assert(!got.includes(bSent) && !(r.body.invoices || []).some((i) => i.clientName === 'Other Business Client'), 'never another business\'s invoices');
  r = await list(a.userId, { status: 'unpaid' });
  got = (r.body.invoices || []).map((i) => i.id).sort();
  assert(JSON.stringify(got) === JSON.stringify([sent, overdue].sort()), 'the same on the older, unpaged list');
  r = await list(a.userId, { cursor: '', limit: '50', status: 'overdue' });
  assert((r.body.invoices || []).length === 1 && r.body.invoices[0].id === overdue, 'a single status still works');
  r = await list(a.userId, { cursor: '', limit: '50', status: "unpaid' OR '1'='1" });
  assert(r.statusCode === 200 && (r.body.invoices || []).length === 5, 'anything else is ignored (treated as no filter), never passed to the database as text');
  r = await list(b.userId, { cursor: '', limit: '50', status: 'unpaid' });
  assert((r.body.invoices || []).length === 1 && r.body.invoices[0].id === bSent, 'each owner sees their own');

  console.log('\n[3] Account in four pages');
  const { ACCOUNT_PAGES, accountPageFor } = await loadAccountHelpers();
  assert(ACCOUNT_PAGES.map((p) => p.label).join('|') === 'Profile|Plan|Preferences|Security & data', 'Profile, Plan, Preferences, Security & data');
  const at = (search, hash = '') => accountPageFor({ search, hash });
  assert(at('') === 'profile' && at('?support=1') === 'profile', 'Account opens on Profile; the help link too');
  assert(at('?tab=billing') === 'billing' && at('?tab=billing&winback=1') === 'billing' && at('?winback=1') === 'billing' && at('', '#referrals') === 'billing', 'billing, win-back and referral links open Plan');
  assert(at('?tab=notifications') === 'notifications', 'the "manage your emails" link in every email opens Preferences');
  assert(at('?tab=security') === 'security' && at('?tab=blocked') === 'security' && at('?tab=reports') === 'security', 'sign-in alerts and the blocked and reports links open Security & data');
  assert(at('?tab=nonsense') === 'profile' && at('?tab=') === 'profile', 'an unknown link opens Profile, never a blank page');
  const acct = read('src/features/account/AccountPage.jsx');
  const body = acct.slice(acct.indexOf('export default function AccountPage()'), acct.indexOf('function Row('));
  const order = ['profile', 'billing', 'notifications', 'security'];
  const pageOf = (id) => {
    const i = body.indexOf(`{page === '${id}' && (`);
    const next = order[order.indexOf(id) + 1];
    return body.slice(i, next ? body.indexOf(`{page === '${next}' && (`) : body.indexOf('{deleteOpen && ('));
  };
  assert(/<BrandingCard\/>/.test(pageOf('profile')) && /<SupportCard\/>/.test(pageOf('profile')) && /<WalkthroughCard\/>/.test(pageOf('profile')), 'Profile: profile, branding, help and the tours');
  assert(/<SubscriptionCard\/>/.test(pageOf('billing')) && /id="referrals"/.test(pageOf('billing')), 'Plan: subscription and referrals');
  assert(/<NotificationsCard\/>/.test(pageOf('notifications')) && /<NavigationCard\/>/.test(pageOf('notifications')), 'Preferences: notifications and the menu');
  assert(/<SecurityCard\/>/.test(pageOf('security')) && /Export your data/.test(pageOf('security')) && /<BlockedCard id="blocked"/.test(pageOf('security')) && /Delete your account/.test(pageOf('security')), 'Security & data: sign-in security, export, blocked, reports and delete');
  for (const card of ['<BrandingCard/>', '<SubscriptionCard/>', '<NotificationsCard/>', '<NavigationCard/>', '<SupportCard/>', '<WalkthroughCard/>', '<SetupReplayCard/>', '<SecurityCard/>', '<ReportsCard ', 'Delete your account</h3>', 'Export your data</h3>']) {
    assert(body.split(card).length === 2, `${card.replace(/[<>/]/g, '').trim()} is on exactly one page (nothing lost, nothing doubled)`);
  }
  assert(/state: \{ viaTabs: true \}/.test(body) && /useState\(!arrivedByTabs\)/.test(acct) && /data-email-prefs-toggle/.test(acct), 'the dozen email switches are folded while browsing, and open when an email\'s link brings you there');
  assert(/Account has four pages across the top/.test(read('api/_lib/ivy.js')), 'Ivy gives directions for the four pages');

  console.log('\n[4] the weekly payoff line');
  const money = (v) => `$${v}`;
  assert(payoffLine({ revenuePaid: 0, revenueAfterReminder: 0 }, money) === null && payoffLine({}, money) === null && payoffLine(null, money) === null, 'nothing collected: nothing is said');
  assert(payoffLine({ revenuePaid: 480, revenueAfterReminder: 0 }, money) === 'You collected $480 in the last 7 days.', 'collected, no reminder involved: no reminder is mentioned');
  assert(payoffLine({ revenuePaid: 480, revenueAfterReminder: 95 }, money) === 'You collected $480 in the last 7 days, $95 of it after a reminder Ivy sent.', 'part of it followed a reminder');
  assert(payoffLine({ revenuePaid: 95, revenueAfterReminder: 95 }, money) === 'You collected $95 in the last 7 days, all of it after a reminder Ivy sent.', 'all of it followed a reminder');
  assert(payoffLine({ revenuePaid: 50, revenueAfterReminder: 900 }, money) === 'You collected $50 in the last 7 days, all of it after a reminder Ivy sent.', 'the reminder part can never be shown as more than what was collected');
  const parts = payoffParts({ revenuePaid: 480, revenueAfterReminder: 95 }, 'USD');
  assert(parts.headline === 'You collected $480 in the last 7 days' && parts.detail === '$95 of it after a reminder Ivy sent' && payoffParts({ revenuePaid: 0 }, 'USD') === null && payoffParts({ revenuePaid: 20 }, 'USD').detail === null, 'the app builds the same sentence from the same two numbers');
  // real records
  const w = await mk('w');
  const range = { from: new Date(Date.now() - 7 * 86400e3), to: new Date() };
  await inv(w.ws, 'paid', 200, { paidAt: ago(20) });                                                  // no reminder
  await inv(w.ws, 'paid', 95, { paidAt: ago(10), overdueReminderAt: ago(30) });                       // overdue reminder, then paid
  await inv(w.ws, 'paid', 40, { paidAt: ago(12), dueSoonReminderAt: ago(40) });                       // due-soon reminder, then paid
  await inv(w.ws, 'paid', 70, { paidAt: ago(50), overdueReminderAt: ago(5) });                        // reminder stamped AFTER it was paid: does not count
  await inv(w.ws, 'paid', 300, { paidAt: ago(24 * 9), overdueReminderAt: ago(24 * 10) });             // paid outside the window
  await inv(w.ws, 'sent', 500, { overdueReminderAt: ago(30) });                                       // reminded, not paid
  await inv(b.ws, 'paid', 1000, { paidAt: ago(10), overdueReminderAt: ago(30) });                     // another business
  let stats = await buildWeekStats({ workspaceId: w.ws, ...range });
  assert(stats.revenuePaid === 405 && stats.revenueAfterReminder === 135, `collected $405, $135 of it after a reminder (got ${stats.revenuePaid} / ${stats.revenueAfterReminder}): a reminder stamped after payment, an unpaid invoice, an older payment and another business's money are all left out`);
  stats = await buildWeekStats({ workspaceId: a.ws, ...range });
  assert(stats.revenuePaid === 80 && stats.revenueAfterReminder === 0, 'a business whose payments followed no reminder is credited with none');
  const email = renderWeeklyRecap({ firstName: 'Kay', businessName: 'Studio', range, stats: { ...stats, revenuePaid: 405, revenueAfterReminder: 135 } });
  const html = typeof email === 'string' ? email : (email.html || '');
  assert(/You collected \$405 in the last 7 days, \$135 of it after a reminder Ivy sent\./.test(html), 'the weekly email carries the sentence');
  const plain = renderWeeklyRecap({ firstName: 'Kay', businessName: 'Studio', range, stats: { ...stats, revenuePaid: 405, revenueAfterReminder: 0 } });
  assert(!/after a reminder Ivy sent/.test(typeof plain === 'string' ? plain : (plain.html || '')), 'and leaves it out when no reminder was involved');
  assert(/revenueAfterReminder: stats\.revenueAfterReminder/.test(read('api/dashboard.js')), 'Home is given the number');
  const dash = read('src/features/dashboard/Dashboard.jsx');
  assert(/const payoff = payoffParts\(data\?\.week, currency\);/.test(dash) && /\{payoff \? payoff\.headline : 'See your progress'\}/.test(dash), 'Home shows it on the Progress row, with no extra box');
}

// AccountPage.jsx is JSX; pull the two plain helpers out of its source.
async function loadAccountHelpers() {
  const src = read('src/features/account/AccountPage.jsx');
  const start = src.indexOf('export const ACCOUNT_PAGES = [');
  const end = src.indexOf('export default function AccountPage()');
  const code = src.slice(start, end).replace(/export /g, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${code}; return { ACCOUNT_PAGES, accountPageFor };`)();
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

// Guards for the "less to look at" pass (owners said the app felt
// complicated): Money in three groups instead of eleven tabs, one name for
// each area, Clients on the phone bar, and the Ask Ivy box on Home.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

console.log('\n[Money in three groups]');
const fin = src('src/features/finance/Finance.jsx');
const block = fin.slice(fin.indexOf('export const MONEY_GROUPS = ['), fin.indexOf('export const moneyGroupOf'));
const groups = [...block.matchAll(/\{ id: '(\w+)', label: '([^']+)', sections: \[([\s\S]*?)\] \}/g)]
  .map((m) => ({ id: m[1], label: m[2], sections: [...m[3].matchAll(/id: '(\w+)',\s+label: '([^']+)'/g)].map((x) => ({ id: x[1], label: x[2] })) }));
assert(groups.length === 3 && groups.map((g) => g.label).join('|') === 'Get paid|What I sell|Track', 'three groups: Get paid, What I sell, Track');
const all = groups.flatMap((g) => g.sections.map((s) => s.id));
const EVERY = ['invoices', 'quotes', 'recurring', 'pos', 'services', 'products', 'packages', 'memberships', 'giftcards', 'expenses', 'time'];
assert(all.length === EVERY.length && EVERY.every((id) => all.includes(id)) && new Set(all).size === all.length, 'every one of the eleven sections is in exactly one group (nothing was removed)');
assert(groups.every((g) => g.sections.length <= 5), 'no group shows more than five choices');
assert(/moneyGroupOf\(section\)\.sections\.map/.test(fin) && /data-section=\{id\}/.test(fin), 'only the chosen group\'s sections are shown, with the same ids existing links use');
assert(/if \(sectionParam\) setSection\(sectionParam\);/.test(fin), 'an existing ?section= link still opens its screen');
assert(/MONEY_GROUPS\.find\(\(g\) => g\.sections\.some\(\(x\) => x\.id === section\)\) \|\| MONEY_GROUPS\[0\]/.test(fin), 'an unknown section falls back to the first group instead of an empty screen');

console.log('\n[one name per area]');
const nav = src('src/lib/nav.js');
assert(/id: 'finance',\s+to: '\/finance',\s+label: 'Money'/.test(nav) && /finance:\s+\{ title: 'Money'/.test(nav), 'the money area is called Money in the menu and at the top of its screen');
assert(/id: 'dashboard', to: '\/dashboard',\s+label: 'Home'/.test(nav) && /dashboard: \{ title: 'Home'/.test(nav), 'the first screen is called Home in the menu and at the top of its screen');
const visibleFinance = [];
for (const f of ['src/features/finance/Finance.jsx', 'src/features/onboarding/ReadyStep.jsx', 'src/features/dashboard/FirstWinCards.jsx', 'src/lib/tutorials.js', 'src/features/onboarding/Walkthrough.jsx', 'api/_lib/paymentClaims.js', 'api/_lib/setupStatus.js', 'api/_lib/ivy.js']) {
  const hits = src(f).split('\n').filter((l) => /\bFinance\b/.test(l) && !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l) && !/import |function Finance|<Finance|FinanceServices|lazyRoute/.test(l));
  if (hits.length) visibleFinance.push(`${f}: ${hits[0].trim().slice(0, 60)}`);
}
assert(visibleFinance.length === 0, `nothing people read still says "Finance"${visibleFinance.length ? ': ' + visibleFinance.join(' ; ') : ''}`);
const ivy = src('api/_lib/ivy.js');
assert(/MONEY \(sidebar → "Money"/.test(ivy) && /"Get paid": Invoices, Estimates, Recurring, Sell in person\./.test(ivy) && /Money → "Get paid" → "Invoices" → "\+ New invoice"/.test(ivy), 'Ivy\'s directions match the new Money layout');

console.log('\n[phone bar]');
const bar = src('src/components/layout/MobileBottomNav.jsx');
const primary = [...bar.slice(bar.indexOf('const PRIMARY = ['), bar.indexOf('const ADMIN_ITEM')).matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
assert(primary.join('|') === 'Home|Calendar|Clients|Money|Ivy', `the bar is Home, Calendar, Clients, Money, Ivy (${primary.join(', ')})`);
assert(/const NATIVE = PRIMARY;/.test(bar), 'the iPhone app uses the same five');
const labelOf = (id) => (new RegExp(`id: '${id}',\\s+to: '[^']+',\\s+label: '([^']+)'`).exec(nav) || [])[1];
assert(['dashboard', 'calendar', 'clients', 'finance', 'ivy'].map(labelOf).join('|') === primary.join('|'), 'each bar label is the same word the desktop menu uses');
const top = src('src/components/layout/Topbar.jsx');
assert(/\{native && \(\s*<button onClick=\{\(\) => navigate\('\/more'\)\}\s*aria-label="More"/.test(top), 'in the app, the header has a menu button that opens everything else');
assert(/aria-label="Messages"/.test(top), 'Messages stays one tap away in the header');

console.log('\n[Ask Ivy on Home]');
const card = src('src/features/dashboard/AskIvyCard.jsx');
const dash = src('src/features/dashboard/Dashboard.jsx');
assert(/<AskIvyCard\/>\n\s*<FirstWinMoment/.test(dash), 'the box is the first thing under the greeting');
assert(/placeholder="What do you want to do\?"/.test(card) && /openIvy\(\{ prompt: msg, send: true, navigate \}\)/.test(card), 'it asks "What do you want to do?" and hands the words to Ivy');
const starters = [...card.matchAll(/\{ label: '([^']+)', prompt:/g)].map((m) => m[1]);
const heroActions = [...dash.slice(dash.indexOf('const actions = ['), dash.indexOf('// (Ask Ivy is the box')).matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
assert(starters.length === 4 && heroActions.length === 3 && !heroActions.includes('Ask Ivy'), `four starters, and the three buttons above it (${heroActions.join(', ')}) with no second "Ask Ivy"`);
assert(!starters.some((s) => /^book a|new booking|invoice|add a client|new client/i.test(s)), 'the starters do not repeat the buttons right above them');
const open = src('src/features/ivy/openIvy.js');
assert(/if \(send && text && navigate\) \{ navigate\('\/ivy', \{ state: \{ ask: text \} \}\); return; \}/.test(open) && /detail: \{ prompt: text, photo: !!photo, send: !!send && !!text \}/.test(open),
  'a request typed in the app travels in memory (an event or router state)');
assert(!/q\.set\('send'|[?&]send=/.test(open), 'never in a web address: a link still cannot send a message for the owner');
const pro = src('src/features/ivy/IvyPro.jsx');
assert(/location\.state\?\.ask/.test(pro) && /askedRef\.current = true;[\s\S]{0,200}submit\(ask\);/.test(pro) && /params\.delete\('send'\);/.test(pro), 'the Ivy screen sends it once, and still only prefills from a link');
assert(/sentLaunchRef\.current === launch\.key\) return;/.test(src('src/features/ivy/IvyDock.jsx')), 'the desktop Ivy panel sends it once');
assert(!/[–—]/.test(card.replace(/\/\/.*$/gm, '')), 'no dashes in what people read');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

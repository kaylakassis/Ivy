// Tutorials open only when the owner asks.
//   [1] nothing opens by itself; every screen has an (i), in the app too
//   [2] every owner screen has a short tutorial
//   [3] what the tutorials say matches the screens
//
// Run: node --import ./tests/bootstrap.mjs ./tests/tutorials-on-demand.test.mjs
import { readFileSync } from 'node:fs';
import { NAV, TITLES } from '../src/lib/nav.js';
import { TUTORIALS, getTutorial } from '../src/lib/tutorials.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

console.log('\n[1] only when asked');
const top = code('src/components/layout/Topbar.jsx');
assert(!/setTimeout\([^)]*tutorial\.open/.test(top) && !/useEffect/.test(top) && (top.match(/tutorial\.open\(/g) || []).length === 1, 'the header never opens a tutorial by itself: the only way in is the button');
assert(/onClick=\{\(\) => tutorial\.open\(tabId\)\}/.test(top) && /data-tutorial-button/.test(top), 'the (i) button opens the screen\'s tutorial');
assert(/\{hasTutorial && \(\s*<button type="button" data-tutorial-button/.test(top) && !/hasTutorial && !native/.test(top), 'it shows in the iPhone app as well as on the website');
assert(/aria-label=\{`How \$\{title\} works`\}/.test(top), 'it is named for screen readers ("How Clients works")');
assert(/width: compact \? 40 : 30, height: compact \? 40 : 30/.test(top), 'on phones it is big enough to tap');
assert(/const unseen = !!hasTutorial && tutorial\.ready && !tutorial\.seen\(tabId\);/.test(top), 'a tutorial not looked at yet only tints its (i); that is the whole nudge');
const everywhere = ['src/components', 'src/features', 'src/lib'];
const { execSync } = await import('node:child_process');
const opens = execSync(`grep -rn "tutorial\\.open(\\|\\.open(tabId)\\|open(activeTab" ${everywhere.join(' ')} --include=*.jsx --include=*.js || true`, { cwd: new URL('..', import.meta.url).pathname }).toString().trim().split('\n').filter(Boolean);
assert(opens.length === 1 && /Topbar\.jsx/.test(opens[0]), `nothing else in the app opens one (${opens.length} place)`);
const shell = code('src/components/layout/AppShell.jsx');
assert(/NAV\.find\(n => location\.pathname\.startsWith\(`\$\{n\.to\}\/`\)\)/.test(shell), 'a page inside a tool keeps that tool\'s title and tutorial instead of Home\'s');
assert(!/paywalled=/.test(shell), 'the header no longer needs to know about the paywall (it was only used to hold back the pop-up)');

console.log('\n[2] every screen has one');
const screens = [...NAV.filter((n) => !n.superAdminOnly).map((n) => n.id), 'progress', 'account', 'more'];
const missing = screens.filter((id) => !getTutorial(id));
assert(missing.length === 0, `all ${screens.length} owner screens have a tutorial${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
assert(Object.keys(TUTORIALS).every((id) => screens.includes(id)), 'and there is none left over for a screen that no longer exists');
assert(!getTutorial('admin'), 'Admin (the operator\'s own screen) has none');
const long = Object.entries(TUTORIALS).filter(([, t]) => t.steps.length > 4 || t.steps.length < 3).map(([id]) => id);
assert(long.length === 0, `each is three or four steps${long.length ? ` (not: ${long.join(', ')})` : ''}`);
const wordy = Object.entries(TUTORIALS).flatMap(([id, t]) => t.steps.filter((s) => s.body.length > 300).map((s) => `${id}: ${s.title}`));
assert(wordy.length === 0, `no step runs past a few sentences${wordy.length ? ` (${wordy.join('; ')})` : ''}`);
assert(Object.entries(TUTORIALS).every(([id, t]) => t.title === (TITLES[id]?.title || t.title) && t.intro && t.steps.every((s) => s.title && s.body)), 'each is titled like its screen and has an opening line');
const all = JSON.stringify(TUTORIALS);
assert(!/[–—]| - /.test(all), 'no dashes');
for (const [stale, why] of [
  [/Marketing/, 'the Marketing tab'], [/auto-?open/i, 'opening by itself'], [/Court-defensible/i, 'a legal promise'],
  [/Drag the bars/i, 'dragging bars for hours'], [/Recurring blocks/i, 'repeating blocks'], [/when they open it/i, 'seeing when an invoice is opened'],
  [/message blast|campaign/i, 'mass email'], [/\bFinance\b/, 'the old name for Money'], [/before they can book/i, 'forms blocking a booking'],
  [/Three starting points/i, 'three website templates'], [/expense|time tracking/i, 'expenses or time tracking'], [/Stripe|Square|PayPal/, 'a processor by name'],
]) assert(!stale.test(all), `nothing about ${why}`);

console.log('\n[3] the words match the screens');
const said = (id) => JSON.stringify(TUTORIALS[id]);
const checks = [
  ['clients', 'Add client', 'src/features/clients/Clients.jsx', /Add client/],
  ['clients', 'Import clients', 'src/features/clients/Clients.jsx', /Import clients/],
  ['clients', 'Needs attention', 'src/features/clients/Clients.jsx', /Needs attention/],
  ['clients', 'Make folder', 'src/features/clients/Clients.jsx', /'Make folder'/],
  ['calendar', 'Availability', 'src/features/calendar/Calendar.jsx', /Availability/],
  ['calendar', '+ Add window', 'src/features/calendar/AvailabilityDrawer.jsx', /\+ Add window/],
  ['calendar', 'Share', 'src/features/calendar/Calendar.jsx', /Share/],
  ['finance', 'New invoice', 'src/features/finance/Finance.jsx', /New invoice/],
  ['finance', 'Collect in person', 'src/features/finance/InvoiceEditor.jsx', /Collect in person/],
  ['finance', 'Settings', 'src/features/finance/Finance.jsx', /data-money-settings[\s\S]{0,200}Settings/],
  ['finance', 'Owed to you', 'src/features/finance/Finance.jsx', /label: 'Owed to you'/],
  ['ivy', 'Approve', 'src/features/ivy/PendingActionCard.jsx', /Approve/],
  ['ivy', 'New chat', 'src/features/ivy/IvyPro.jsx', /New chat/],
  ['comms', 'Broadcast', 'src/features/messages/Messages.jsx', /label: 'Broadcast'/],
  ['comms', 'Two-way', 'src/features/messages/Messages.jsx', /label: 'Two-way'/],
  ['programs', 'New program', 'src/features/programs/ProgramsPage.jsx', /New program/],
  ['automation', 'Ivy noticed', 'src/features/workflows/Workflows.jsx', /Ivy noticed/],
  ['reviews', 'Respond', 'src/features/reviews/Reviews.jsx', /Respond/],
  ['reviews', 'Appeal for removal', 'src/features/reviews/Reviews.jsx', /Appeal for removal/],
  ['docs', 'Upload a PDF, pick a template, or start blank', 'src/features/documents/Documents.jsx', /Upload a PDF, pick a template, or start blank/],
  ['website', 'Add section', 'src/features/website/SectionLibrary.jsx', /Add section/],
  ['website', 'Link only', 'src/features/website/Editor.jsx', /'Link only'/],
  ['website', 'Publish', 'src/features/website/Editor.jsx', /Publish/],
  ['shops', 'Invite a pro', 'src/features/shops/ShopsPage.jsx', /Invite a pro/],
  ['account', 'Security & data', 'src/features/account/AccountPage.jsx', /label: 'Security & data'/],
  ['account', 'Preferences', 'src/features/account/AccountPage.jsx', /label: 'Preferences'/],
  ['dashboard', 'See your progress', 'src/features/dashboard/Dashboard.jsx', /See your progress/],
];
for (const [id, phrase, file, re] of checks) {
  assert(said(id).includes(phrase.replace(/"/g, '\\"')) && re.test(read(file)), `${TUTORIALS[id].title}: "${phrase}" is what the screen calls it`);
}
assert(/Sent to the client automatically when this service is booked/.test(read('src/features/calendar/ServicesDrawer.jsx')) && /sent to the client automatically whenever that service is booked/.test(said('docs')), 'Documents: forms attached to a service are sent after booking, and the tutorial says exactly that');
assert(/turn that off in Clients, under Reminders/.test(said('reviews')) && /kind: 'review'/.test(read('src/features/workflows/ClientAutomations.jsx')), 'Reviews: it says review requests can be turned off, and where');
assert(/Nothing opens by itself/.test(said('more')), 'More: it says where help is, and that nothing pops up');

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

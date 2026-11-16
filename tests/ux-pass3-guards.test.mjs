// Guards for the third UX pass (1.0.7): risky-action confirmations, a
// brand-new account, the deep editors, Ivy's chat, helper and tablet
// screens, and what happens when things go wrong. Each check is something a
// browser walk found and fixed; these keep it from quietly coming back.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const root = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(root, f), 'utf8');
const walk = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(root, rel)).isDirectory() ? walk(rel) : (/\.(jsx|js)$/.test(rel) ? [rel] : []);
});
const files = walk('src');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------
// 1. One in-app pop-up instead of the browser's own boxes.
// ---------------------------------------------------------------------
console.log('In-app pop-ups');
const nativeBoxes = [];
for (const f of files) {
  if (f === 'src/lib/confirm.js') continue;                    // the fallback lives here
  const s = code(src(f));
  const re = /(^|[^\w.$])(?:window\.)?(confirm|alert)\(/g;
  let m;
  while ((m = re.exec(s))) nativeBoxes.push(`${f}:${s.slice(0, m.index).split('\n').length} ${m[2]}()`);
  // prompt(): only the admin screens (Kayla's own tools) and the copy-link fallback may still use it.
  if (!/features\/admin\//.test(f) && !/ProgramsPage\.jsx$/.test(f)) {
    const pr = /(^|[^\w.$])(?:window\.)?prompt\(/g;
    while ((m = pr.exec(s))) nativeBoxes.push(`${f}:${s.slice(0, m.index).split('\n').length} prompt()`);
  }
}
assert(nativeBoxes.length === 0, `no screen uses the browser's own confirm / alert / prompt box${nativeBoxes.length ? ': ' + nativeBoxes.slice(0, 6).join(', ') : ''}`);

const { confirmAction, showNotice, askText, registerConfirmHost } = await import('../src/lib/confirm.js');
assert(await confirmAction({ title: 'Delete?' }) === false, 'with no pop-up available and no browser, a risky action is NOT confirmed');
assert(await askText({ title: 'Which year?' }) === null, 'with no pop-up available, a question comes back cancelled');
const seen = [];
const off = registerConfirmHost((o) => { seen.push(o); return Promise.resolve(o.kind === 'confirm' ? true : o.kind === 'text' ? 'typed' : true); });
assert(await confirmAction('Plain question?') === true && seen[0].kind === 'confirm' && seen[0].title === 'Plain question?', 'a plain sentence works as the question');
assert(await askText({ title: 'Year?', defaultValue: '2026' }) === 'typed' && seen[1].kind === 'text', 'a typed answer comes back as text');
await showNotice({ title: 'Saved' });
assert(seen[2].kind === 'notice', 'a notice opens as a one-button pop-up');
off();
assert(await confirmAction({ title: 'After unmount' }) === false, 'once the pop-up is gone, the safe answer is "no" again');

const host = src('src/components/ConfirmHost.jsx');
assert(/role="alertdialog" aria-modal="true"/.test(host), 'the pop-up is announced as an alert dialog');
assert(/current\.kind === 'confirm' && current\.danger\) cancelRef\.current\?\.focus\(\)/.test(host), 'for a risky action the keyboard starts on Cancel, so Enter cannot delete by accident');
assert(/answered\.current === current\.id\) return;/.test(host), 'a second tap cannot answer twice (or answer the next question in line)');
assert(/window\.addEventListener\('keydown', onKey, true\)/.test(host) && /stopImmediatePropagation/.test(host), 'Esc closes the pop-up only, not the screen behind it');
assert(/<ConfirmHost\/>/.test(src('src/main.jsx')), 'the pop-up is mounted once for the whole app');

// Deletes that used to act instantly now ask first.
for (const [f, re, what] of [
  ['src/features/goals/Goals.jsx', /title: 'Delete this task\?'/, 'deleting a task'],
  ['src/features/goals/Goals.jsx', /title: 'Delete this goal\?'/, 'deleting a goal'],
  ['src/features/ivy/IvyPro.jsx', /title: 'Delete this chat\?'/, 'deleting an Ivy chat'],
  ['src/features/calendar/EventDrawer.jsx', /'Delete this event\?' : 'Delete this blocked time\?'/, 'deleting a calendar event or blocked time'],
  ['src/features/calendar/SyncDrawer.jsx', /title: 'Turn off calendar sync\?'/, 'turning off calendar sync'],
  ['src/features/calendar/WaitlistDrawer.jsx', /off the waitlist\?`/, 'removing someone from the waitlist'],
  ['src/features/campaigns/Campaigns.jsx', /title: 'Delete this draft\?'/, 'deleting a campaign'],
  ['src/features/documents/DocumentEditor.jsx', /title: 'Void this document\?'/, 'voiding a sent document'],
]) assert(re.test(src(f)), `${what} asks first`);
assert(/if \(reason === null\) return;/.test(src('src/features/client/ClientDms.jsx')), 'cancelling "report this message" no longer sends the report');

// ---------------------------------------------------------------------
// 2. Closing an editor never silently loses work.
// ---------------------------------------------------------------------
console.log('Unsaved work');
const inv = src('src/features/finance/InvoiceEditor.jsx');
assert(/if \(blank\) \{ animateClose\(\{ discardBlank: true \}\); return; \}/.test(inv) && /if \(dirty\) \{[\s\S]{0,300}await onSave\(/.test(inv), 'invoice: closing a draft saves unsaved changes, and a never-filled draft is thrown away');
assert(/info\?\.discardBlank && inv\?\.status === 'draft'\) remove\(inv\.id\)/.test(src('src/features/finance/Finance.jsx')), 'invoice: the list drops the never-filled draft');
const camp = src('src/features/campaigns/Campaigns.jsx');
assert(/onClose\(\{ discardBlank: true \}\)/.test(camp) && /if \(dirty\) \{[\s\S]{0,200}await onSave\(/.test(camp), 'campaign: same save-on-close and no empty drafts left behind');
assert(/const close = async \(\) => \{[\s\S]{0,700}await onSave\(\{ name: name\.trim\(\) \|\| 'Untitled', contentHtml: body, fields \}\)/.test(src('src/features/documents/DocumentEditor.jsx')), 'document: closing a draft saves it first');
for (const f of ['finance/Quotes.jsx', 'finance/Recurring.jsx', 'finance/Time.jsx', 'finance/Expenses.jsx', 'finance/Memberships.jsx']) {
  const s = src(`src/features/${f}`);
  assert(/useDiscardGuard\(\{/.test(s) && /guard\.close\(onClose\)/.test(s), `${f.split('/')[1]}: closing with unsaved changes asks "Close without saving?"`);
}
assert(/cancelLabel: 'Keep editing'/.test(src('src/lib/useDiscardGuard.js')), 'the safe choice on that question is "Keep editing"');

// ---------------------------------------------------------------------
// 3. When things go wrong.
// ---------------------------------------------------------------------
console.log('Failures');
const { describeUncaught, uncaughtNotice } = await import('../src/lib/uncaughtNotice.js');
assert(describeUncaught({ status: 500, method: 'DELETE', message: 'Internal Server Error' })?.body === 'Something went wrong on our side. Please try again in a moment.', 'a failed change with no handler gets a plain message, never the raw server error');
assert(describeUncaught({ status: 400, method: 'POST', message: 'Pick a client first.' })?.body === 'Pick a client first.', 'a refused change shows the reason the server gave');
assert(describeUncaught({ status: 0, method: 'PATCH', offline: true })?.title === "You're offline", 'no connection is called what it is');
assert(describeUncaught({ status: 500, method: 'GET' }) === null, 'a background load that fails stays quiet');
assert(describeUncaught({ status: 401, method: 'POST' }) === null && describeUncaught({ status: 402, method: 'POST' }) === null, 'signed out and trial-ended are left to their own screens');
assert(describeUncaught(new Error('some bug')) === null && describeUncaught(null) === null, 'anything that is not a failed request is ignored');
let shown = 0; const off2 = registerConfirmHost(() => { shown++; return Promise.resolve(true); });
uncaughtNotice({ status: 500, method: 'POST' }, 100000); uncaughtNotice({ status: 500, method: 'POST' }, 101000); uncaughtNotice({ status: 500, method: 'POST' }, 105000);
off2();
assert(shown === 2, 'several failures at once show one message, not a pile');
assert(/uncaughtNotice\(e\?\.reason\)/.test(src('src/main.jsx')), 'the app listens for failures nobody handled');

const api = src('src/lib/api.js');
assert(/res\.status === 401 && !\/\^\\\/auth\\\/\/\.test\(path\)/.test(api) && /new CustomEvent\('ivy:unauthorized'/.test(api), 'a "not signed in" answer while using the app is reported to the app');
assert(/SIGNED_OUT_MESSAGE = 'You have been signed out\. Please sign in again\.'/.test(api), 'the message says "signed out", not "Unauthorized"');
const auth = src('src/lib/auth.jsx');
assert(/window\.addEventListener\('ivy:unauthorized', onUnauthorized\)/.test(auth) && /const still = await refresh\(\);/.test(auth), 'the app checks with the server before signing anyone out');
assert(/You were signed out\. Sign in again to pick up where you left off\./.test(src('src/features/auth/AuthPage.jsx')), 'the sign-in page explains what happened');

const ivy = src('src/features/ivy/state.jsx');
assert(/quick \? \{ tries: 2, waitMs: 1500 \} : \{\}/.test(ivy), 'Ivy: a send that fails straight away reports in a couple of seconds, not half a minute');
assert(/outcome = \{ ok: false, retryText: t \}/.test(ivy) && /return outcome;/.test(ivy), 'Ivy: an unsent message is handed back');
for (const f of ['IvyPro.jsx', 'IvyDock.jsx']) assert(/r\.ok === false && r\.retryText\) setDraft\(\(d\) => d \|\| r\.retryText\)/.test(src(`src/features/ivy/${f}`)), `Ivy (${f}): the unsent message goes back in the box`);
assert(/You are offline, so that was not sent\./.test(ivy), 'Ivy: offline is called offline');
assert(/That did not go through, so nothing was changed\. You can approve it again\./.test(ivy), 'Ivy: an approval that did not run says so');

// ---------------------------------------------------------------------
// 4. Layout: documents, invoice design, onboarding, tablets.
// ---------------------------------------------------------------------
console.log('Layout');
const css = src('src/styles/global.css');
assert(/\.doc-editor-pane-left\[data-mobile-tab="preview"\]\s*\{ display: none !important; \}/.test(css) && /\.doc-editor-pane-right\[data-mobile-tab="edit"\]\s*\{ display: none !important; \}/.test(css), 'documents on a phone: Edit and Preview show one at a time');
assert(/\.inv-design-body \{ display: block !important;/.test(css), 'invoice design on a phone: options and sample stack');
assert(/\.onb-actions \.onb-primary \{ flex: 1 0 100%;/.test(css) && /className="btn btn-primary onb-primary"/.test(src('src/features/onboarding/OnboardingPage.jsx')), 'onboarding on a phone: the main button has its own full-width row');
assert(/@media \(min-width: 521px\) and \(max-width: 1023px\) \{\s*\.stat-grid \{ grid-template-columns: repeat\(2,/.test(css), 'summary cards on a tablet: two to a row');
assert(/const cardList = isMobile \|\| isTablet;/.test(src('src/features/clients/Clients.jsx')), 'clients on a tablet: cards, not a table that squeezes names to two letters');
assert(/const cardList = isMobile \|\| isTablet;/.test(src('src/features/finance/Finance.jsx')), 'invoices on a tablet: cards, not a row that runs off the edge');
const docs = src('src/features/documents/Documents.jsx');
assert(docs.indexOf('{err && (') > 0 && docs.indexOf('{err && (') < docs.indexOf('{myTemplates.length > 0 && ('), 'new document: an upload error shows at the top, where the owner is looking');
assert(/tzDisplay\(browserTimeZone\(\)\)/.test(src('src/features/onboarding/OnboardingPage.jsx')), 'onboarding: the time zone is named in plain words');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

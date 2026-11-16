// Guards for the second UX pass (1.0.7): every form, pop-up and multi-step
// flow was walked in a browser on a phone and a desktop. These checks keep
// what that walk fixed from quietly coming back.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const root = new URL('..', import.meta.url).pathname;
const src = (f) => readFileSync(join(root, f), 'utf8');
const walk = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(root, rel)).isDirectory() ? walk(rel) : (rel.endsWith('.jsx') ? [rel] : []);
});
const files = walk('src');

// ---------------------------------------------------------------------
// 1. Tap areas. The enlarged tap area hangs off the button it belongs to.
//    A button that resets its own styles ("all: unset") is not an anchor,
//    so its tap area landed on a parent panel and swallowed every tap in
//    it (the month grid, the Pages list, the invoice client list).
// ---------------------------------------------------------------------
console.log('Tap areas');
const css = src('src/styles/global.css');
const touch = css.slice(css.indexOf('@media (pointer: coarse)'));
const afterRule = (touch.match(/:where\(button, \[role="button"\], a\.btn, summary\)([^{]*)::after\s*\{/) || [])[1] || '';
assert(/\[style\*="all:"\]/.test(afterRule), 'a control that resets its styles gets no enlarged tap area (one spelling browsers use)');
assert(/\[style\*="position: unset"\]/.test(afterRule), 'a control that resets its styles gets no enlarged tap area (the other spelling)');
assert(/\[style\*="position: static"\]/.test(afterRule), 'a control pinned to "static" gets no enlarged tap area');
const unsetLines = files.flatMap((f) => src(f).split('\n').map((line, i) => ({ f, i: i + 1, line })).filter((x) => /all: 'unset'/.test(x.line)));
assert(unsetLines.length > 0 && unsetLines.every((x) => /all: 'unset', position: 'relative'/.test(x.line)),
  `every control that resets its styles also anchors itself (${unsetLines.filter((x) => !/all: 'unset', position: 'relative'/.test(x.line)).map((x) => `${x.f}:${x.i}`).join(', ') || 'all ' + unsetLines.length})`);

// ---------------------------------------------------------------------
// 2. Every button that shows only an icon has a name (screen readers,
//    voice control, and the hover hint on desktop).
// ---------------------------------------------------------------------
console.log('Icon-only buttons');
const unnamed = [];
for (const f of files) {
  const s = src(f);
  const re = /<button\b/g;
  let m;
  while ((m = re.exec(s))) {
    // Find the end of the opening tag, skipping over { } and quotes.
    let depth = 0, q = null, j = m.index;
    for (; j < s.length; j++) {
      const c = s[j];
      if (q) { if (c === q && s[j - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && s[j - 1] !== '=') break;
    }
    const attrs = s.slice(m.index, j);
    if (/aria-label|title=|aria-labelledby/.test(attrs)) continue;
    const rest = s.slice(j + 1, j + 260);
    if (/^\s*<Icons\.\w+\b[^<>]*?\/>\s*<\/button>/.test(rest)) unnamed.push(`${f}:${s.slice(0, m.index).split('\n').length}`);
  }
}
assert(unnamed.length === 0, `no icon-only button is left without a name${unnamed.length ? ': ' + unnamed.slice(0, 8).join(', ') : ''}`);
const calendar = src('src/features/calendar/Calendar.jsx');
for (const name of ['Availability', 'Share', 'Staff', 'Add event', 'Reminders', 'Waitlist']) {
  assert(new RegExp(`aria-label="${name}"`).test(calendar), `Calendar toolbar: "${name}" keeps its name when the label is hidden on a tablet`);
}
assert(/aria-label="Send message"/.test(src('src/features/client/ClientMessages.jsx')), 'Client messages: the send button has a name');
assert(/aria-label=\{smsMode \? 'Send as a text message' : 'Send message'\}/.test(src('src/features/messages/Messages.jsx')), 'Messages: the send button has a name');

// ---------------------------------------------------------------------
// 3. Invoices: a draft can be given a client from inside the editor, and
//    the line items fit a phone.
// ---------------------------------------------------------------------
console.log('Invoice editor');
const editor = src('src/features/finance/InvoiceEditor.jsx');
const picker = src('src/features/finance/InvoiceClientPicker.jsx');
assert(/invoice\.status === 'draft' && \(\s*<InvoiceClientPicker invoice=\{invoice\} mobile=\{isMobile\} onPick=\{\(patch\) => onSave\(patch\)\}\/>/.test(editor), 'a draft invoice offers "Choose a client" in the editor; a sent one does not');
assert(/onPick\(\{ clientId: c\.id, clientName: c\.name, clientEmail: c\.email \|\| null \}\)/.test(picker), 'picking a client saves the client, their name and their email together');
assert(/Choose a client/.test(picker) && /Change client/.test(picker), 'the button reads "Choose a client" first and "Change client" after');
assert(/fontSize: 16/.test(picker), 'the client search box does not make an iPhone zoom in');
assert(/isMobile \? \(/.test(editor) && /aria-label=\{`Remove line \$\{i \+ 1\}`\}/.test(editor), 'on a phone each invoice line is its own card with a named remove button (no sideways scrolling)');
const invoiceApi = src('api/invoices/[id].js');
assert(/FROM clients WHERE id = \$\{clientId\} AND workspace_id = \$\{workspaceId\}/.test(invoiceApi) && /Unknown client/.test(invoiceApi), 'the server only accepts a client that belongs to the same business');

// ---------------------------------------------------------------------
// 4. Calendar month on a phone fits the screen.
// ---------------------------------------------------------------------
console.log('Calendar month');
const month = src('src/features/calendar/MonthView.jsx');
assert(/if \(isMobile\) \{/.test(month) && /gridTemplateColumns: 'repeat\(7, minmax\(0, 1fr\)\)'/.test(month), 'phone: all seven days fit across the screen');
assert(/onClick=\{\(\) => onPickDay\(d\)\} aria-label=\{said\}/.test(month), 'phone: each day is a button that says the date and how many bookings it has');

// ---------------------------------------------------------------------
// 5. Search pop-up: no web addresses, and a Close button on a phone.
// ---------------------------------------------------------------------
console.log('Search');
const palette = src('src/components/CommandPalette.jsx');
assert(!/subtitle: n\.to/.test(palette), 'page rows do not show their web address');
assert(/aria-label="Close search"/.test(palette) && /\{touch \? 'Close' : 'esc'\}/.test(palette), 'there is a real Close button (it says Close on a phone)');
assert(/\{!touch && \(/.test(palette), 'keyboard tips are hidden where there is no keyboard');

// ---------------------------------------------------------------------
// 6. Menus that ran off the screen.
// ---------------------------------------------------------------------
console.log('Menus');
const discover = src('src/features/client/ClientDiscover.jsx');
assert(/r\.right > window\.innerWidth - 8\) setFlip\(true\)/.test(discover) && /maxWidth: 'calc\(100vw - 24px\)'/.test(discover), 'Discover: a filter menu near the right edge opens inward');
const siteEditor = src('src/features/website/Editor.jsx');
assert(/maxHeight: 'min\(560px, calc\(100vh - 190px\)\)', overflowY: 'auto'/.test(siteEditor), 'Website builder: the style list scrolls, so the last styles can be reached');
assert(/onClick=\{\(\) => setShowTemplateMenu\(false\)\} aria-hidden="true"/.test(siteEditor), 'Website builder: clicking away closes the style list');

// ---------------------------------------------------------------------
// 7. Small errors.
// ---------------------------------------------------------------------
console.log('Errors');
assert(/if \(!wrapRef\.current \|\| !innerRef\.current\) return;\s*const avail/.test(src('src/features/website/Canvas.jsx')), 'Website builder: leaving the builder no longer throws an error');
const booking = src('src/features/calendar/PublicBooking.jsx');
assert(/if \(embedded \|\| authLoading \|\| !signedIn\) return;/.test(booking), 'Booking page: a visitor who is not signed in is not asked for their packages');
for (const [f, what] of [['src/features/finance/PublicInvoice.jsx', 'the invoice'], ['src/features/finance/PublicQuote.jsx', 'the estimate'], ['src/features/documents/SignPage.jsx', 'the document']]) {
  assert(new RegExp(`Need a new one\\? Ask the business that sent it to send ${what} again\\.`).test(src(f)), `${f.split('/').pop()}: a dead link says what to do next`);
}

// No long dashes in the copy this pass touched.
const touched = ['src/features/finance/InvoiceClientPicker.jsx', 'src/features/calendar/MonthView.jsx', 'src/components/CommandPalette.jsx'];
const dashy = touched.filter((f) => /[–—]/.test(src(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
assert(dashy.length === 0, `no long dashes in new on-screen wording${dashy.length ? ': ' + dashy.join(', ') : ''}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

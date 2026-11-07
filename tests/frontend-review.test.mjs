// Front-end review fixes (Ivy 1.0.6):
//   1. Bare calendar dates (invoice due/issue, quote expiry, task due) are
//      shown on the viewer's own day, and "today" is the viewer's today,
//      not UTC's (src/lib/dateOnly.js + the screens that use it).
//   2. Video-call links an owner typed are passed through safeHref on every
//      screen (client portal, public booking, helper, owner).
//   3. The message pane is remounted per conversation (no draft or SMS
//      toggle carried to the next client, no stale poll painting the old
//      thread into the new one).
//   4. The helper shell remounts its screen when the helper switches
//      business, so the new business's data is fetched.
//   5. The Clients page draws a page of rows at a time.
// Run: node --import ./tests/bootstrap.mjs ./tests/frontend-review.test.mjs
import fs from 'node:fs';

// Pacific time: west of UTC, so a bare date read as UTC midnight shows the
// day before, and 8pm local is already tomorrow in UTC.
process.env.TZ = 'America/Los_Angeles';
const { parseDateOnly, fmtDateOnly, localISODate } = await import('../src/lib/dateOnly.js');
const { safeHref } = await import('../src/lib/safeHref.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const read = (f) => fs.readFileSync(f, 'utf8');

console.log('\n[1] bare dates stay on their calendar day');
assert(new Date('2026-11-15').getDate() === 14, 'precondition: the old parse shows Nov 14 in Pacific time');
assert(parseDateOnly('2026-11-15').getDate() === 15, 'parseDateOnly keeps Nov 15');
assert(fmtDateOnly('2026-11-15', { month: 'short', day: 'numeric' }) === 'Nov 15', 'fmtDateOnly prints Nov 15');
assert(fmtDateOnly('') === '' && fmtDateOnly(null) === '' && fmtDateOnly('nope') === '', 'empty / bad input prints nothing');
assert(parseDateOnly('2026-11-15T18:30:00Z').getTime() === Date.parse('2026-11-15T18:30:00Z'), 'full timestamps parse as before');
const evening = new Date('2026-11-07T20:00:00-08:00');
assert(evening.toISOString().slice(0, 10) === '2026-11-08', 'precondition: UTC "today" at 8pm Pacific is tomorrow');
assert(localISODate(evening) === '2026-11-07', 'localISODate at 8pm Pacific is still Nov 7');
assert(/^\d{4}-\d{2}-\d{2}$/.test(localISODate()), 'localISODate() defaults to now');

const badDisplay = /new Date\([\w.?]*(dueDate|issueDate|expiryDate|nextRunAt)\)\.toLocaleDateString/;
for (const f of ['src/features/finance/Finance.jsx', 'src/features/finance/Quotes.jsx', 'src/features/finance/PublicQuote.jsx', 'src/features/finance/Recurring.jsx']) {
  assert(!badDisplay.test(read(f)), `${f} formats due/issue/expiry/next-run dates with fmtDateOnly`);
}
for (const f of [
  'src/features/goals/Goals.jsx', 'src/features/finance/Quotes.jsx', 'src/features/finance/Expenses.jsx',
  'src/features/finance/Recurring.jsx', 'src/features/client/ClientBookings.jsx', 'src/features/client/ClientPackages.jsx',
]) {
  assert(!read(f).includes('toISOString().slice(0, 10)'), `${f} takes "today" from the viewer's calendar`);
}

console.log('\n[2] owner-typed video links go through safeHref');
assert(safeHref('javascript:alert(1)') === '#', 'precondition: safeHref drops script URLs');
assert(safeHref('https://zoom.us/j/1') === 'https://zoom.us/j/1', 'precondition: safeHref keeps https links');
for (const f of [
  'src/features/client/ClientHome.jsx', 'src/features/client/ClientBookings.jsx', 'src/features/calendar/PublicBooking.jsx',
  'src/features/helper/HelperSchedule.jsx', 'src/features/calendar/EventDrawer.jsx',
]) {
  const raw = read(f).match(/href=\{[^}]*(videoRoomUrl|VideoUrl)[^}]*\}/g) || [];
  assert(raw.length > 0 && raw.every((h) => h.includes('safeHref(')), `${f}: every video link href uses safeHref`);
}

console.log('\n[3] one message pane per conversation');
assert(/<ConversationPane\s+key=\{selectedId/.test(read('src/features/messages/Messages.jsx')), 'owner inbox keys the pane by thread');
assert(/<ConversationPane key=\{selectedId/.test(read('src/features/client/ClientMessages.jsx')), 'client inbox keys the pane by thread');

console.log('\n[4] helper screens follow the selected business');
assert(/key=\{`\$\{location\.pathname\}\|\$\{me\?\.business\?\.workspaceId/.test(read('src/features/helper/HelperShell.jsx')),
  'helper shell keys the screen by business as well as path');

console.log('\n[5] Clients page draws a page of rows at a time');
const clients = read('src/features/clients/Clients.jsx');
assert(/rows\.slice\(0, shown\)\.map/.test(clients), 'rows are sliced to the drawn page');
assert(/setShown\(ROW_PAGE\); \}, \[tab, query\]/.test(clients), 'the page resets when the tab or search changes');
assert(/Show more/.test(clients), 'a Show more button reveals the next page');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

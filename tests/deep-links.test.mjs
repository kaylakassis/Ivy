// Deep links the API/emails/pushes emit must be honored by the page they
// land on. The API side mints URLs like /messages?group=, /goals?task=,
// /finance?filter=overdue, /account?tab=billing, /admin?tab=bugs,
// /site/:handle?order=success, ?payment=error&msg= and the Stripe cancel
// returns; this suite checks (statically) that each target page reads
// that param, that stale links were retargeted, and (functionally) that
// the SSR site renderer emits the order banner without an inline script.
// Run: node --import ./tests/bootstrap.mjs ./tests/deep-links.test.mjs
import fs from 'node:fs';
import { renderSiteHtml } from '../api/_lib/siteHtml.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const read = (f) => fs.readFileSync(f, 'utf8');
// Line-based comment stripping: a multi-line block stripper would eat
// real code after a "/api/admin/*" glob in a comment.
const codeOnly = (src) => src.split('\n')
  .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/, '$1'))
  .join('\n');

console.log('\n[1] deep-link params are read by their target page');
const reads = [
  ['src/features/messages/Messages.jsx',        /get\('group'\)/,                       '/messages?group= opens the Groups tab'],
  ['src/features/messages/GroupChats.jsx',      /initialId/,                             'GroupChats takes the initial group id'],
  ['src/App.jsx',                               /\/dashboard\$\{q\}#goals/,              '/goals redirect carries its query to /dashboard#goals'],
  ['src/features/goals/Goals.jsx',              /get\('task'\)/,                         '/goals?task= highlights the task row'],
  ['src/features/finance/Finance.jsx',          /get\('filter'\)/,                       '/finance?filter= sets the invoice status filter'],
  ['src/features/account/AccountPage.jsx',      /id="billing"/,                          'Billing card has an anchor'],
  ['src/features/account/AccountPage.jsx',      /id="security"/,                         'Security card has an anchor'],
  ['src/features/account/AccountPage.jsx',      /tab === 'billing'[\s\S]*tab === 'security'/, '/account?tab=billing|security scroll to their card'],
  ['src/features/admin/AdminPage.jsx',          /TABS\.some\(\(t\) => t\.id === want\)/, '/admin?tab= initialises the tab when it names a real one'],
  ['src/features/website/PublicSite.jsx',       /get\('order'\)/,                        '/site/:handle?order= shows a notice (React)'],
  ['api/site/[handle]/index.js',                /req\.query\.order/,                     '/site/:handle?order= shows a notice (SSR)'],
  ['src/features/finance/PublicInvoice.jsx',    /get\('payment'\) === 'error'/,          'PublicInvoice shows ?payment=error&msg='],
  ['src/features/calendar/PublicBooking.jsx',   /get\('payment'\) === 'error'/,          'PublicBooking shows ?payment=error&msg='],
  ['src/features/calendar/PublicBooking.jsx',   /get\('giftcard'\) === 'cancel'/,        'PublicBooking shows ?giftcard=cancel'],
  ['src/features/calendar/PublicBooking.jsx',   /get\('package'\) === 'cancel'/,         'PublicBooking shows ?package=cancel'],
  ['src/features/programs/PublicProgram.jsx',   /get\('cancelled'\) === '1'/,            'PublicProgram shows ?cancelled=1'],
  ['src/features/calendar/Calendar.jsx',        /section=services&service=\$\{encodeURIComponent\(serviceId\)\}/, '/calendar?service= forwards the id to Finance'],
  ['src/features/finance/Services.jsx',         /get\('service'\)/,                      'Finance services section consumes ?service='],
  ['src/features/calendar/ServicesDrawer.jsx',  /openId/,                                'ServicesDrawer opens the deep-linked service'],
];
for (const [file, re, label] of reads) assert(re.test(codeOnly(read(file))), `${label} (${file})`);

console.log('\n[2] stale links and dishonest copy are gone');
const absent = [
  ['src/features/marketing/MarketingShell.jsx', /<Link[^>]*to="\/blog"/,            'no React Router <Link> to the static /blog page'],
  ['src/App.jsx',                               /view=folders/,                      'ProjectsRedirect no longer emits the ignored view=folders'],
  ['src/features/onboarding/Walkthrough.jsx',   /nav-rewards|route: '\/rewards'/,    'walkthrough no longer targets the removed Rewards nav item'],
  ['src/lib/tutorials.js',                      /Tap Services \(top action menu\)/,  'calendar tutorial no longer points at the Calendar action menu for services'],
  ['api/cron/setup-nudge.js',                   /'add your first service', href: '\/calendar'/, 'setup nudge links services to Finance'],
  ['api/_lib/subscriptionNotify.js',            /['`]\/referrals['`]/,                'referral emails/pushes use /account#referrals'],
  ['src/features/marketing/site/SiteTour.jsx',  /id: 'programs'/,                    'site tour does not list Programs as shipped'],
  ['src/features/marketing/IntegrationsPage.jsx', /clients, bookings, invoices/,     'CSV import copy no longer claims bookings/invoices import'],
  ['src/features/calendar/StaffDrawer.jsx',     /Commission \(%\)|Hourly rate \(\$\)/, 'staff drawer dropped the unused rate/commission fields'],
];
for (const [file, re, label] of absent) assert(!re.test(codeOnly(read(file))), `${label} (${file})`);
const present = [
  ['src/features/marketing/MarketingShell.jsx', /<a href="\/blog"/,                         'MarketingShell links /blog with a plain anchor'],
  ['src/features/onboarding/Walkthrough.jsx',   /nav-marketing/,                             'walkthrough targets the Marketing nav item'],
  ['src/lib/tutorials.js',                      /to: '\/finance\?section=services'/,         'calendar tutorial CTA opens Finance → Services'],
  ['api/cron/setup-nudge.js',                   /href: '\/finance\?section=services'/,       'setup nudge "add your first service" opens Finance → Services'],
  ['api/_lib/subscriptionNotify.js',            /\/account#referrals/,                       'referral links point at /account#referrals'],
];
for (const [file, re, label] of present) assert(re.test(codeOnly(read(file))), `${label} (${file})`);

console.log('\n[3] SSR site renders the order banner without an inline script');
const site = { handle: 'demo', businessName: 'Demo Studio', template: 'clean' };
const page = { title: 'Home', sections: [] };
const base = { site, page, nav: [], handle: 'demo', currentSlug: '', host: 'example.com' };
const okHtml = renderSiteHtml({ ...base, order: 'success' });
const cancelHtml = renderSiteHtml({ ...base, order: 'cancel' });
const plainHtml = renderSiteHtml(base);
const junkHtml = renderSiteHtml({ ...base, order: '<script>alert(1)</script>' });
assert(/Thanks for your order/.test(okHtml), 'order=success renders the thank-you banner');
assert(/Checkout cancelled/.test(cancelHtml) && /Nothing was charged/.test(cancelHtml), 'order=cancel says nothing was charged');
assert(!/Thanks for your order|Checkout cancelled/.test(plainHtml), 'no banner without ?order=');
assert(!/Thanks for your order|Checkout cancelled|alert\(1\)/.test(junkHtml), 'unknown order values render nothing');
// The banner itself must not rely on a <script>: count scripts with and
// without the banner, they must match (pageview beacon + JSON-LD only).
const scripts = (h) => (h.match(/<script/g) || []).length;
assert(scripts(okHtml) === scripts(plainHtml), 'order banner adds no inline <script> (CSP has no unsafe-inline)');
assert(/href="\/site\/demo"[^>]*aria-label="Dismiss"/.test(okHtml), 'dismiss is a plain link back to the clean URL');
assert(!/[—]/.test(okHtml + cancelHtml), 'no em dashes in the banner copy');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

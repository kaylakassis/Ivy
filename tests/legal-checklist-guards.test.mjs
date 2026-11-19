// Guards for the site-safety pass: accessibility, privacy notices on public
// forms, fonts served from our own server, and the mailing address on
// marketing email. Each check is something a scan or a read of the code
// found; the checks keep them from quietly coming back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { labelled } from '../src/lib/labelled.js';
import { TEMPLATES } from '../src/features/website/templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// ---- keyboard focus -------------------------------------------------------
console.log('\n[keyboard focus]');
const css = src('src/styles/global.css');
assert(/:focus-visible \{ outline: 2px solid var\(--accent, #4CBA7F\)/.test(css), 'the focus outline has a fallback colour, so it shows on pages that do not set --accent (the marketing site)');
assert(/:where\(input, textarea, select\):where\(\[style\*="outline: none"\], \[style\*="outline: 0"\]\)[^{]*:focus-visible \{\s*box-shadow:/.test(css), 'a bordered field that turns its outline off still shows a ring when focused');
assert(/\.sr-only \{ position: absolute !important; width: 1px; height: 1px;/.test(css), 'there is a screen-reader-only text helper');
assert(!/outline: 'none'/.test(src('src/features/goals/Goals.jsx').split('aria-label={task.done ? undefined : `Edit task: ${task.title}`}')[1].slice(0, 400)), 'the task title keeps its focus outline and its name includes the task');

// ---- names for form controls ----------------------------------------------
console.log('\n[form control names]');
const el = (type, props) => React.createElement(type, props);
assert(labelled(el('input', { value: '' }), 'Amount').props['aria-label'] === 'Amount', 'a caption above a plain input becomes its name');
assert(labelled(el('select', {}), ' Category ').props['aria-label'] === 'Category', 'the same for a select, trimmed');
assert(labelled(el('input', { 'aria-label': 'Own' }), 'Amount').props['aria-label'] === 'Own', 'a control that already has a name keeps it');
assert(labelled(el('input', { id: 'x' }), 'Amount').props['aria-label'] === undefined, 'a control tied to a label by id is left alone');
const wrapper = el('div', {}, el('input', {}));
assert(labelled(wrapper, 'Amount') === wrapper, 'anything that is not a single plain control is returned untouched');
assert(labelled(el('input', {}), el('b', {}, 'x')).props['aria-label'] === undefined, 'a caption that is not plain text is not used as a name');
const WRAPPERS = ['admin/AdminPage', 'finance/Quotes', 'finance/Time', 'finance/InvoiceEditor', 'finance/Recurring', 'finance/Expenses', 'finance/Memberships',
  'rewards/Rewards', 'workflows/WorkflowEditor', 'clients/AddClientModal', 'website/editorKit', 'onboarding/OnboardingPage', 'calendar/ShareDrawer',
  'calendar/ServicesDrawer', 'calendar/PackagesDrawer', 'calendar/AddBookingModal', 'calendar/EventDrawer', 'calendar/StaffDrawer', 'documents/Documents'];
assert(WRAPPERS.every((w) => /\{labelled\(children, label\)\}/.test(src(`src/features/${w}.jsx`))), `all ${WRAPPERS.length} caption-above-field wrappers name their control`);
const pricing = src('src/features/marketing/site/SitePricing.jsx');
assert((pricing.match(/<input type="range" aria-label="/g) || []).length === 5 && !/<input type="range" (?!aria-label)/.test(pricing), 'every pricing slider has a name');
const renderer = src('src/features/website/SectionRenderer.jsx');
assert(/placeholder="Your name" aria-label="Your name"/.test(renderer) && /aria-label="Email address"/.test(renderer) && /placeholder="Message" aria-label="Message"/.test(renderer), 'customer-site contact and newsletter fields have names, not only placeholder text');

// ---- contrast -------------------------------------------------------------
console.log('\n[contrast]');
const lum = (h) => { const v = [0, 2, 4].map((i) => parseInt(h.replace('#', '').substr(i, 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const weak = [];
for (const t of Object.values(TEMPLATES)) {
  for (const bg of [t.vars['--site-bg'], t.vars['--site-surface']]) {
    for (const k of ['--site-muted', '--site-fg-2', '--site-fg', '--site-accent']) {
      if (ratio(t.vars[k], bg) < 4.5) weak.push(`${t.id} ${k} on ${bg}`);
    }
  }
}
assert(weak.length === 0, `every website template's body text, small grey text and brand colour reaches 4.5:1 on its backgrounds${weak.length ? ': ' + weak.join(', ') : ''}`);
const weakButtons = Object.values(TEMPLATES).filter((t) => ratio(t.vars['--site-accent-ink'], t.vars['--site-accent']) < 4.5).map((t) => t.id);
assert(weakButtons.length === 0, `button text is readable on every template's brand colour${weakButtons.length ? ': ' + weakButtons.join(', ') : ''}`);
const tokens = src('src/styles/tokens.css');
assert(/--danger: #9B2C2C;\n\s*--danger-ink: #FFFFFF;/.test(tokens) && /--danger: #FF6B6B;\n\s*--danger-ink: #2B0A0A;/.test(tokens), 'each theme says what colour text goes on its danger colour');
assert(ratio('#FFFFFF', '#9B2C2C') >= 4.5 && ratio('#2B0A0A', '#FF6B6B') >= 4.5, 'and both pairs are readable');
assert(/color: 'var\(--danger-ink, #fff\)'/.test(src('src/components/layout/NotificationBell.jsx')) && /color: 'var\(--danger-ink, #fff\)'/.test(src('src/components/ConfirmHost.jsx')), 'the unread badge and the delete button use it');
assert(!/opacity: 0\.75/.test(src('src/components/layout/Sidebar.jsx').split('{item.section}')[0].slice(-400)) && !/padding: '14px 12px 4px', opacity/.test(src('src/features/client/ClientShell.jsx')), 'sidebar section labels are not dimmed below readable');

// ---- claims on the Security page ------------------------------------------
console.log('\n[security page claims]');
assert(!/disable Ivy site-wide/.test(src('src/features/marketing/SecurityPage.jsx')), 'the Security page does not promise a switch to turn Ivy off (there is none)');
const security = src('src/features/marketing/SecurityPage.jsx');
assert(!/60 days/.test(security) && /available to download for 7 days/.test(security) && /kept for 4 weeks/.test(security), 'it gives the same data-retention times as the Terms and the app (7 days, 4 weeks for a trial), not 60 days');
assert(!/No data leaves US data centers/.test(security) && /Frankfurt/.test(security) && /Sydney/.test(security), 'it says where requests are handled, instead of claiming nothing leaves the US');
assert(!/only happens when you explicitly request support/.test(security) && /can see account totals and usage/.test(security), 'it says what Ivy staff can see, matching the Privacy Policy');
assert(!/any point in the last 30 days/.test(security), 'it does not promise a backup window that depends on the database plan');
const llmsFull = src('public/llms-full.txt');
assert(!/for 60 days|any point in the last 30 days|only happens when the owner explicitly asks/.test(llmsFull), 'the plain-text site summary carries the same corrections');

// ---- privacy policy ---------------------------------------------------------
console.log('\n[privacy policy]');
const policy = src('src/features/legal/PrivacyPage.jsx');
const named = ['Vercel', 'Neon', 'Resend', 'Stripe', 'Square and PayPal', 'Twilio', 'Apple and RevenueCat', 'Google', 'Sentry', 'OpenStreetMap'];
assert(named.every((n) => policy.includes(`<strong>${n}</strong>`)) && /AI model provider/.test(policy), 'it lists every outside service the app sends data to');
assert(!/We do not share data with anyone else, and we do not sell data/.test(policy) && /unless the law\s+requires us to/.test(policy), 'it no longer says data goes to nobody else');
assert(!/an optional name/.test(policy) && /the country you signed up from/.test(policy), 'it says what sign-up really collects (name required, sign-up country, set-up questions)');
assert(/If you are a client of a business that uses Ivy/.test(policy) && /Reply STOP/.test(policy), 'it has a section for the clients of businesses that use Ivy');
assert(/California residents/.test(policy) && /href="\/do-not-sell"/.test(policy), 'it has a California section');
assert(!/Anthropic|Claude|OpenAI|GPT/.test(policy), 'it does not name the AI provider');
const vApi = /CURRENT_PRIVACY_VERSION = '([^']+)'/.exec(src('api/_lib/legal.js'))[1];
const vWeb = /CURRENT_PRIVACY_VERSION = '([^']+)'/.exec(src('src/lib/legal.js'))[1];
const vPage = /PRIVACY_VERSION = '([^']+)'/.exec(policy)[1];
assert(vApi === vWeb && vWeb === vPage && vApi >= '2026-11-19', `the policy version is the same in the server, the app and the page (${vApi})`);
assert(new RegExp(`PRIOR_PRIVACY_VERSIONS = \\['2026-11-05'`).test(src('api/_lib/legal.js')), 'the previous version is still accepted at sign-up from app builds that carry it');
assert(/ME_PATH = `\/auth\/me\?pv=\$\{encodeURIComponent\(CURRENT_PRIVACY_VERSION\)\}&tv=\$\{encodeURIComponent\(CURRENT_TERMS_VERSION\)\}`/.test(src('src/lib/auth.jsx')) && /clientCanShowCurrentPrivacy\(req\)/.test(src('api/auth/me.js')) && /clientCanShowCurrentTerms\(req\)/.test(src('api/auth/me.js')),
  'the app tells the server which policy version it carries, so an older iPhone app is never stuck behind a notice it cannot accept');

// ---- copyright page -----------------------------------------------------------
console.log('\n[copyright page]');
const copyrightPage = src('src/features/legal/CopyrightPage.jsx');
assert(/path="\/copyright"/.test(copyrightPage) && /support@joinivy\.ai/.test(copyrightPage) && /penalty of perjury/.test(copyrightPage) && /counter-notice/.test(copyrightPage) && /repeatedly post/.test(copyrightPage),
  'it says how to report, what a notice needs, what happens next, and the repeat-infringer rule');
assert(/24930 Washington Avenue Unit #268, Murrieta, CA 92564/.test(copyrightPage), 'it gives the mailing address for notices');
assert(!/[\u2013\u2014]/.test(copyrightPage.replace(/\/\/.*$/gm, '')), 'no dashes in what people read');
assert(/path="\/copyright" element=\{<CopyrightPage \/>\}/.test(src('src/App.jsx')) && /path: '\/copyright'/.test(src('scripts/_lib/marketing-routes.mjs')) && /"source": "\/copyright"/.test(src('vercel.json')), 'it is a real, pre-rendered page in the sitemap list');
assert(/href="\/copyright">Copyright<\/a>/.test(src('src/features/marketing/site/Chrome.jsx')) && /href="\/copyright">Copyright<\/a>/.test(src('public/blog.html')), 'the site and blog footers link to it');

// ---- privacy notice on public forms ---------------------------------------
console.log('\n[privacy notice on public forms]');
const note = src('src/components/PrivacyNote.jsx');
assert(/https:\/\/www\.joinivy\.ai\/privacy/.test(note) && /target="_blank" rel="noopener noreferrer"/.test(note), 'the notice links to the privacy policy with an absolute address (it also runs on customer domains and in embeds)');
assert(!/[–—]/.test(note.replace(/\/\/.*$/gm, '')), 'no dashes in what people read');
const booking = src('src/features/calendar/PublicBooking.jsx');
assert((booking.match(/<PrivacyNote /g) || []).length >= 6, 'the booking form and each pop-up that asks for details carries it (membership, package, gift card, message, program)');
assert(/<PrivacyNote color="var\(--site-muted\)"\/>/.test(renderer) && /state !== 'sent' && <PrivacyNote/.test(renderer), 'customer-site contact and newsletter forms carry it');
assert(/<PrivacyNote\/>/.test(src('src/features/embed/EmbedContact.jsx')) && /<PrivacyNote business=\{business\?\.name\}\/>/.test(src('src/features/programs/PublicProgram.jsx')), 'so do the embedded contact form and the program checkout');

// ---- fonts from our own server --------------------------------------------
console.log('\n[fonts]');
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(jsx?|css|html)$/.test(e.name)) out.push(p); } return out; };
const offenders = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'index.html'), path.join(ROOT, 'public', 'blog.html'), path.join(ROOT, 'public', 'sw.js'), ...walk(path.join(ROOT, 'public', 'blog'))]
  .filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
assert(offenders.length === 0, `no page asks Google for a font${offenders.length ? ': ' + offenders.slice(0, 5).join(', ') : ''}`);
for (const f of ['index.html', 'vercel.json']) {
  assert(!/fonts\.(googleapis|gstatic)\.com/.test(src(f)) && /font-src 'self' data:;/.test(src(f)) && /style-src 'self' 'unsafe-inline';/.test(src(f)), `${f}: the content-security policy no longer allows an outside font host`);
}
const inter = src('public/fonts/inter.css');
const families = src('public/fonts/families.css');
const files = (text) => [...text.matchAll(/url\(\/fonts\/g\/([^)]+)\)/g)].map((m) => m[1]);
assert(files(inter).length >= 2 && /font-family:'Inter'/.test(inter) && /font-display:swap/.test(inter), 'Inter is defined from our own files and never blocks text');
const missing = [...new Set([...files(inter), ...files(families)])].filter((n) => !fs.existsSync(path.join(ROOT, 'public', 'fonts', 'g', n)));
assert(missing.length === 0, `every font file the stylesheets name is in the repository${missing.length ? ': missing ' + missing.join(', ') : ''}`);
const builder = src('src/lib/builderFonts.js');
const wanted = ['Inter', 'Fraunces', 'Space Grotesk', 'Playfair Display', 'Lato', 'DM Serif Display', 'DM Sans', 'Bodoni Moda', 'Montserrat', 'Cormorant Garamond', 'Open Sans',
  'Archivo Black', 'Archivo', 'Abril Fatface', 'IBM Plex Mono', 'IBM Plex Sans', 'Oswald', 'Lora', 'Spectral', 'Jost', 'Marcellus', 'Nunito', 'Bebas Neue'];
assert(/const HREF = '\/fonts\/families\.css';/.test(builder) && wanted.every((n) => families.includes(`font-family:'${n}'`)), 'every website and invoice font choice is in the self-hosted stylesheet');
const lic = fs.readdirSync(path.join(ROOT, 'public', 'fonts', 'g', 'licenses'));
assert(lic.length === wanted.length, 'each font family ships with its license');
assert(/sameOrigin && url\.pathname\.startsWith\('\/fonts\/'\)/.test(src('public/sw.js')), 'the offline cache keeps our own font files');

// ---- accessibility statement ----------------------------------------------
console.log('\n[accessibility statement]');
const page = src('src/features/legal/AccessibilityPage.jsx');
assert(/path="\/accessibility"/.test(page) && /support@joinivy\.ai/.test(page) && /What is not finished/.test(page), 'the page says how to report a barrier and what is not finished');
assert(!/fully (compliant|accessible|conform)|100%|certified/i.test(page.replace(/\/\/.*$/gm, '')), 'it makes no claim of full conformance');
assert(!/[–—]/.test(page.replace(/\/\/.*$/gm, '')), 'no dashes in what people read');
assert(/path="\/accessibility" element=\{<AccessibilityPage \/>\}/.test(src('src/App.jsx')) && /'\/accessibility': AccessibilityPage/.test(src('src/App.jsx')), 'it is a real route and is pre-rendered');
assert(/path: '\/accessibility'/.test(src('scripts/_lib/marketing-routes.mjs')) && /"source": "\/accessibility"/.test(src('vercel.json')), 'it is in the sitemap list and served as a static page');
assert(/href="\/accessibility">Accessibility<\/a>/.test(src('src/features/marketing/site/Chrome.jsx')) && /href="\/accessibility">Accessibility<\/a>/.test(src('public/blog.html')), 'the site and blog footers link to it');

// ---- mailing address on marketing email -----------------------------------
console.log('\n[mailing address on marketing email]');
const campaigns = src('api/_lib/campaigns.js');
assert(/export async function sendCampaign\(\{ workspaceId, campaign \}\) \{\n[^\n]*\n\s*await requireMailingAddress\(workspaceId\);/.test(campaigns), 'every campaign send (the app and Ivy) first requires a business mailing address');
assert(/showMailingAddress: true/.test(campaigns), 'the campaign email prints it');
const send = src('api/campaigns/[id]/send.js');
assert(send.indexOf('requireMailingAddress(workspaceId)') > 0 && send.indexOf('requireMailingAddress(workspaceId)') < send.indexOf("SET status = 'sending'"), 'a refusal happens before the campaign is claimed, so it stays a draft');
assert(/code: e\.code/.test(send), 'the refusal carries a code the screen can act on');
assert(/showMailingAddress = false/.test(src('api/_lib/email.js')), 'other emails do not print it unless asked');
assert(/mailing_address:\s+\{ type: 'string'/.test(src('api/_lib/ivyTools.js')) && /Never invent it/.test(src('api/_lib/ivyTools.js')), 'Ivy can save the address for the owner and is told never to make one up');
assert(/id="campaign-mailing-address"/.test(src('src/features/campaigns/Campaigns.jsx')) && /id="brand-mailing-address"/.test(src('src/features/account/AccountPage.jsx')), 'the owner can enter it in the campaign editor and in Account');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

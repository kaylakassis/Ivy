// Legal documents, 2026-11-24: the owner's new Terms of Service (37
// sections), Privacy Policy (26 sections), Accessibility Statement and Do
// Not Sell page, all put in word for word as she supplied them.
//   [1] each page says exactly what was supplied (tests/fixtures/legal)
//   [2] the version is the same everywhere, and the notice period is honoured
//   [3] an older iPhone app can still sign people up, and is never walled
//   [4] a copy of the app that carries the new Terms asks once, and records it
//   [5] review names on public pages are first name + last initial
//
// Run: node --import ./tests/bootstrap.mjs ./tests/terms-update.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, invalidateUserCache } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, PRIOR_TERMS_VERSIONS, acceptableTermsVersion, CURRENT_PRIVACY_VERSION, PRIOR_PRIVACY_VERSIONS, acceptablePrivacyVersion, LEGAL_EFFECTIVE_AT, LEGAL_EFFECTIVE_LABEL, inLegalNoticePeriod } from '../api/_lib/legal.js';
import { CURRENT_TERMS_VERSION as WEB_TERMS, CURRENT_PRIVACY_VERSION as WEB_PRIVACY } from '../src/lib/legal.js';
import { issueFormToken } from '../api/_lib/humanCheck.js';
import { serializeReview, publicReviewerName } from '../api/_lib/reviews.js';
import signupHandler from '../api/auth/signup.js';
import meHandler from '../api/auth/me.js';
import acceptHandler from '../api/me/accept-terms.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'localhost:3000';
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
let ipN = 20;
async function call(handler, { method = 'GET', userId, query = {}, body, headers = {} } = {}) {
  const req = { method, url: '/api/x', query, body, headers: { host: HOST, origin: `http://${HOST}`, 'x-real-ip': `198.51.100.${ipN}`, 'content-type': 'application/json', ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}), ...headers } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] the documents');
  // What a reader sees: the page with its markup taken away.
  const shown = (file, from, to) => {
    const code = read(file);
    const body = code.slice(code.indexOf(from) + from.length, code.lastIndexOf(to));
    return body.replace(/<\/?(?:a|LegalLink|strong)\b[^>]*>/g, '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean);
  };
  const supplied = (name) => read(`tests/fixtures/legal/${name}`).replace(/^\* /gm, '').split(/\s+/).filter(Boolean);
  const firstDiff = (a, b) => { const i = a.findIndex((w, n) => w !== b[n]); return i < 0 ? (a.length === b.length ? '' : `length ${a.length} vs ${b.length}`) : `word ${i}: "${a.slice(Math.max(0, i - 3), i + 3).join(' ')}" vs "${b.slice(Math.max(0, i - 3), i + 3).join(' ')}"`; };
  const docs = [
    ['Terms of Service', 'src/features/legal/TermsPage.jsx', 'path="/terms"', '</LegalPage>', 'terms-2026-11-24.txt'],
    ['Privacy Policy', 'src/features/legal/PrivacyPage.jsx', '    <>', '    </>', 'privacy-2026-11-24.txt'],
    ['Accessibility Statement', 'src/features/legal/AccessibilityPage.jsx', 'path="/accessibility"', '</LegalPage>', 'accessibility-2026-11-24.txt'],
    ['Do Not Sell page', 'src/features/legal/DoNotSellPage.jsx', 'path="/do-not-sell"', '</LegalPage>', 'do-not-sell-2026-11-24.txt'],
  ];
  for (const [name, file, from, to, fx] of docs) {
    // The opening tag's own description="..." line comes before the text.
    const words = shown(file, from, to); const want = supplied(fx);
    const start = words.indexOf(want[0]);
    const diff = firstDiff(words.slice(start), want);
    assert(start >= 0 && diff === '', `${name}: word for word what was supplied (${want.length} words)${diff ? ' - ' + diff : ''}`);
    const code = read(file).replace(/^\s*\/\/.*$/gm, '');
    const emails = [...new Set(code.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [])];
    assert(emails.length === 1 && emails[0] === 'support@joinivy.ai', `${name}: every email address is support@joinivy.ai (${emails.join(', ')})`);
    assert(!/[–—]/.test(code) && !/Anthropic|Claude|OpenAI|GPT/.test(code), `${name}: no dashes, and the AI provider is not named`);
  }
  const page = read('src/features/legal/TermsPage.jsx');
  const heads = [...page.matchAll(/<H2>(\d+)\. ([^<]+)<\/H2>/g)].map((m) => [Number(m[1]), m[2]]);
  assert(heads.length === 37 && heads.every(([n], i) => n === i + 1), `the Terms have 37 sections, numbered in order (${heads.length})`);
  assert(heads[3][1] === 'Artificial Intelligence Features' && heads[18][1] === 'Subscription Fees, Billing, and Automatic Renewal' && heads[27][1] === 'Dispute Resolution and Arbitration' && heads[29][1] === 'Changes to These Terms' && heads[36][1] === 'Contact Information',
    'with the AI, billing, arbitration, changes and contact sections where the supplied text has them');
  assert((page.match(/<H3>\d+\.\d+ /g) || []).length === 31 && /<H3>28\.6 Right to opt out<\/H3>/.test(page) && /subject line should be "Arbitration Opt-Out\."/.test(page), 'sub-sections are headed, including the arbitration opt-out');
  assert((page.match(/<P><strong>(?:\([ab]\) )?[^a-z<]{20,}<\/strong><\/P>/g) || []).length === 12, 'the twelve capital-letter paragraphs stand out in bold');
  const policy = read('src/features/legal/PrivacyPage.jsx');
  const pHeads = [...policy.matchAll(/<H2>(\d+)\. ([^<]+)<\/H2>/g)].map((m) => Number(m[1]));
  assert(pHeads.length === 26 && pHeads.every((n, i) => n === i + 1) && /export function PrivacyPolicyBody\(\)/.test(policy), 'the Privacy Policy has 26 sections, and the in-app notice can still show it');
  assert(/TERMS_LAST_UPDATED = 'November 24, 2026'/.test(page) && /TERMS_EFFECTIVE = 'December 8, 2026'/.test(page) && /PRIVACY_EFFECTIVE = 'December 8, 2026'/.test(policy) && /Effective date: \{effectiveDate\}/.test(read('src/features/legal/LegalPage.jsx')),
    'both show "Last updated: November 24, 2026" and "Effective date: December 8, 2026"');

  console.log('\n[2] one version everywhere, and the notice period');
  const pageVersion = /TERMS_VERSION = '([^']+)'/.exec(page)[1];
  const policyVersion = /PRIVACY_VERSION = '([^']+)'/.exec(policy)[1];
  assert(CURRENT_TERMS_VERSION === '2026-11-24' && WEB_TERMS === CURRENT_TERMS_VERSION && pageVersion === CURRENT_TERMS_VERSION, `Terms: server, app and page agree (${CURRENT_TERMS_VERSION})`);
  assert(CURRENT_PRIVACY_VERSION === '2026-11-24' && WEB_PRIVACY === CURRENT_PRIVACY_VERSION && policyVersion === CURRENT_PRIVACY_VERSION, `Privacy Policy: server, app and page agree (${CURRENT_PRIVACY_VERSION})`);
  assert(PRIOR_TERMS_VERSIONS.includes('2026-11-19') && PRIOR_TERMS_VERSIONS.includes('2026-05-05') && acceptableTermsVersion('2026-11-19') === '2026-11-19' && acceptableTermsVersion('2026-05-05') === '2026-05-05' && acceptableTermsVersion(CURRENT_TERMS_VERSION) === CURRENT_TERMS_VERSION && acceptableTermsVersion('1999-01-01') === null && acceptableTermsVersion('') === null,
    'the earlier Terms versions are the only others accepted at sign-up (iPhone apps that still carry them)');
  assert(PRIOR_PRIVACY_VERSIONS[0] === '2026-11-19' && acceptablePrivacyVersion('2026-11-19') === '2026-11-19' && acceptablePrivacyVersion('2020-01-01') === null, 'and the same for the Privacy Policy');
  assert(LEGAL_EFFECTIVE_AT === '2026-12-08T08:00:00Z' && LEGAL_EFFECTIVE_LABEL === 'December 8, 2026' && inLegalNoticePeriod(Date.parse('2026-11-24T12:00:00Z')) && inLegalNoticePeriod(Date.parse('2026-12-08T07:59:00Z')) && !inLegalNoticePeriod(Date.parse('2026-12-08T08:00:00Z')),
    'the notice period runs from publication to the start of December 8 in California, 14 days');

  console.log('\n[3] an older iPhone app');
  const signup = (email, terms, extra = {}) => { ipN++; return call(signupHandler, { method: 'POST', body: {
    email, password: 'a-good-password-123', name: 'Terms Tester', acceptedTermsVersion: terms, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
    accountEmailsConsent: true, formToken: issueFormToken(Date.now() - 5000), ...extra } }); };
  const oldEmail = `terms-old-${S}@example.com`;
  let r = await signup(oldEmail, '2026-05-05');
  const oldUser = (await sql`SELECT id, terms_version FROM users WHERE email = ${oldEmail}`).rows[0];
  if (oldUser) users.push(oldUser.id);
  assert(r.statusCode === 201 && oldUser?.terms_version === '2026-05-05', `it can still create an account, recorded as the version it showed (${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
  const acc = oldUser ? (await sql`SELECT version FROM legal_acceptances WHERE user_id = ${oldUser.id} AND document = 'terms'`).rows[0] : null;
  assert(acc?.version === '2026-05-05', 'and the acceptance record says the same');
  r = await signup(`terms-bad-${S}@example.com`, '2020-01-01');
  assert(r.statusCode === 400 && /current Terms/.test(r.body.error), 'a made-up version is refused');
  r = await call(meHandler, { userId: oldUser.id, headers: { 'x-client-platform': 'ios', origin: 'capacitor://localhost' } });
  assert(r.statusCode === 200 && r.body.terms.needsAcceptance === false && r.body.terms.currentVersion === CURRENT_TERMS_VERSION, 'the old app is not walled: it cannot show the new Terms, so it is not asked');
  r = await call(meHandler, { userId: oldUser.id, query: { tv: '2026-05-05' } });
  assert(r.body.terms.needsAcceptance === false, 'same for any copy that says it carries the old version');
  r = await call(meHandler, { userId: oldUser.id });
  assert(r.body.terms.needsAcceptance === false, 'and for a browser tab left open from before the update');
  r = await call(acceptHandler, { method: 'POST', userId: oldUser.id, body: { version: '2026-05-05' } });
  assert(r.statusCode === 400, 'acceptance of the old text is never recorded as acceptance of the new');
  const midEmail = `terms-mid-${S}@example.com`;
  r = await signup(midEmail, '2026-11-19', { acceptedPrivacyVersion: '2026-11-19' });
  const midUser = (await sql`SELECT id, terms_version, privacy_version FROM users WHERE email = ${midEmail}`).rows[0];
  if (midUser) users.push(midUser.id);
  assert(r.statusCode === 201 && midUser?.terms_version === '2026-11-19' && midUser?.privacy_version === '2026-11-19', 'an iPhone app carrying last week\'s documents can still sign people up, recorded as what it showed');
  r = await call(meHandler, { userId: midUser.id, query: { tv: '2026-11-19', pv: '2026-11-19' }, headers: { 'x-client-platform': 'ios', origin: 'capacitor://localhost' } });
  assert(r.body.terms.needsAcceptance === false && r.body.privacy.needsAcknowledgement === false, 'and that app is asked nothing it cannot show');

  console.log('\n[4] a copy that carries the new Terms');
  r = await call(meHandler, { userId: oldUser.id, query: { tv: CURRENT_TERMS_VERSION, pv: CURRENT_PRIVACY_VERSION } });
  assert(r.body.terms.needsAcceptance === true && r.body.terms.acceptedVersion === '2026-05-05', 'asks this person to accept');
  assert(r.body.terms.canDefer === inLegalNoticePeriod() && r.body.terms.effectiveLabel === 'December 8, 2026' && r.body.terms.effectiveAt === LEGAL_EFFECTIVE_AT,
    `during the 14 days' notice they may put it off; from the effective date they may not (now: ${r.body.terms.canDefer ? 'may put it off' : 'must answer'})`);
  await sql`UPDATE users SET terms_version = NULL WHERE id = ${midUser.id}`; invalidateUserCache(midUser.id);
  r = await call(meHandler, { userId: midUser.id, query: { tv: CURRENT_TERMS_VERSION, pv: CURRENT_PRIVACY_VERSION } });
  assert(r.body.terms.needsAcceptance === true && r.body.terms.canDefer === false, 'someone with no acceptance on record at all cannot put it off');
  await sql`UPDATE users SET terms_version = '2026-11-19' WHERE id = ${midUser.id}`; invalidateUserCache(midUser.id);
  r = await call(meHandler, { userId: midUser.id, query: { tv: CURRENT_TERMS_VERSION, pv: CURRENT_PRIVACY_VERSION } });
  assert(r.body.terms.needsAcceptance === true && r.body.privacy.needsAcknowledgement === true, 'someone on last week\'s versions is asked about both documents');
  r = await call(acceptHandler, { method: 'POST', userId: midUser.id, body: { version: CURRENT_TERMS_VERSION } });
  const r2 = await call(acceptHandler, { method: 'POST', userId: midUser.id, body: { document: 'privacy', version: CURRENT_PRIVACY_VERSION } });
  invalidateUserCache(midUser.id);
  const both = (await sql`SELECT document, version FROM legal_acceptances WHERE user_id = ${midUser.id}`).rows.map((x) => `${x.document}:${x.version}`);
  assert(r.statusCode === 200 && r2.statusCode === 200 && both.includes(`terms:${CURRENT_TERMS_VERSION}`) && both.includes(`privacy:${CURRENT_PRIVACY_VERSION}`) && both.includes('terms:2026-11-19'),
    'accepting records each document, with the earlier acceptance kept');
  r = await call(meHandler, { userId: midUser.id, query: { tv: CURRENT_TERMS_VERSION, pv: CURRENT_PRIVACY_VERSION } });
  assert(r.body.terms.needsAcceptance === false && r.body.privacy.needsAcknowledgement === false, 'and neither is asked again');
  r = await call(acceptHandler, { method: 'POST', userId: oldUser.id, body: { version: CURRENT_TERMS_VERSION } });
  invalidateUserCache(oldUser.id);
  const now = (await sql`SELECT terms_version FROM users WHERE id = ${oldUser.id}`).rows[0];
  const rows = (await sql`SELECT version FROM legal_acceptances WHERE user_id = ${oldUser.id} AND document = 'terms' ORDER BY accepted_at`.catch(() => sql`SELECT version FROM legal_acceptances WHERE user_id = ${oldUser.id} AND document = 'terms'`)).rows.map((x) => x.version);
  assert(r.statusCode === 200 && now.terms_version === CURRENT_TERMS_VERSION && rows.includes('2026-05-05') && rows.includes(CURRENT_TERMS_VERSION), 'accepting records the new version and keeps the earlier record');
  r = await call(meHandler, { userId: oldUser.id, query: { tv: CURRENT_TERMS_VERSION } });
  assert(r.body.terms.needsAcceptance === false, 'and they are not asked again');
  const newEmail = `terms-new-${S}@example.com`;
  r = await signup(newEmail, CURRENT_TERMS_VERSION);
  const newUser = (await sql`SELECT id, terms_version FROM users WHERE email = ${newEmail}`).rows[0];
  if (newUser) users.push(newUser.id);
  assert(newUser?.terms_version === CURRENT_TERMS_VERSION, 'a new sign-up on the current app accepts the current Terms');
  const auth = read('src/lib/auth.jsx'); const modal = read('src/components/TermsAcceptModal.jsx');
  assert(/&tv=\$\{encodeURIComponent\(CURRENT_TERMS_VERSION\)\}/.test(auth), 'the app tells the server which Terms it carries');
  const intro = modal.slice(modal.indexOf('const docs ='), modal.indexOf('return ('));
  assert(/We updated our \$\{docs\}\. Please read them, then accept to continue\./.test(intro) && /We updated our \$\{docs\}\. They take effect on \$\{terms\.effectiveLabel\}\. Please read them, then accept\./.test(intro)
    && !/arbitration|section \d|class|liabil|what changed|we changed/i.test(intro) && /Read Terms/.test(modal) && /Read Privacy Policy/.test(modal) && /Sign out/.test(modal),
    'the prompt only says the documents were updated (and when they take effect), with links to read them and a choice to accept or sign out');
  assert(/\{canDefer && \(\s*<button onClick=\{remindLater\}[^>]*data-terms-later>\s*Remind me later/.test(modal) && /if \(canDefer && later === terms\.currentVersion\) return null;/.test(modal) && /sessionStorage\.setItem\(LATER_KEY, terms\.currentVersion\)/.test(modal),
    '"Remind me later" exists only while the server says the notice period is running, and only lasts until Ivy is next opened');
  assert(/if \(privacy\?\.needsAcknowledgement\) \{\s*await api\.post\('\/me\/accept-terms', \{ document: 'privacy', version: CURRENT_PRIVACY_VERSION \}\)/.test(auth) && /privacyAlsoUpdated/.test(modal),
    'one answer covers both documents when both were updated, so nobody is asked twice in a row');
  const helper = read('api/helper/accept.js');
  assert(/acceptableTermsVersion\(body\.acceptedTermsVersion\)/.test(helper), 'a helper accepting an invite from an older app is handled the same way');
  const account = read('src/features/account/AccountPage.jsx');
  assert(/every week or every year/.test(account) && !/monthly or annual/.test(account) && /until you cancel/.test(account) && /Account, then Plan, then Manage subscription/.test(account),
    'the checkout confirmation describes renewal the way the Terms do: weekly or yearly, until cancelled, and where to cancel');

  console.log('\n[5] reviewers on public pages');
  assert(publicReviewerName('Jane Doe') === 'Jane D.' && publicReviewerName('Mary Ann O\'Neil') === 'Mary O.' && publicReviewerName('José García-López') === 'José G.', 'first name and last initial');
  assert(publicReviewerName('Cher') === 'Cher' && publicReviewerName('jane.doe') === 'jane' && publicReviewerName('') === 'Anonymous' && publicReviewerName('Verified client') === 'Verified client', 'one-word names, email-style names and placeholders are handled');
  const row = { id: 'r', rating: 5, text: 'Great', reviewer_name: 'Jane Doe', status: 'visible', created_at: new Date() };
  assert(serializeReview(row).reviewerName === 'Jane D.' && serializeReview(row, { includeHidden: true }).reviewerName === 'Jane Doe', 'the public gets "Jane D."; the owner still sees "Jane Doe"');
  assert(/reviewerName: publicReviewerName\(r\.reviewer_name\)/.test(read('api/calendar/public/[slug].js')) && /reviewerName: publicReviewerName\(r\.reviewer_name\)/.test(read('api/_lib/shops.js')), 'the booking page and shop pages use the same rule');

  console.log('\n[6] old files');
  assert(!existsSync(new URL('../chats', import.meta.url)) && !existsSync(new URL('../project', import.meta.url)) && !/project\/|chats\//.test(read('README.md')), 'the old chat transcript and prototype are out of the code');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

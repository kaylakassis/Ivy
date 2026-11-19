// Terms of Service 2026-11-19: section 8 "Ivy's property" added.
//   [1] the page: section 8 is there, with the owner's edits; the rest is renumbered
//   [2] the version is the same everywhere
//   [3] an older iPhone app can still sign people up, and is never walled
//   [4] a copy of the app that carries the new Terms asks once, and records it
//   [5] review names on public pages are first name + last initial
//
// Run: node --import ./tests/bootstrap.mjs ./tests/terms-update.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, invalidateUserCache } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, PRIOR_TERMS_VERSIONS, acceptableTermsVersion, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { CURRENT_TERMS_VERSION as WEB_TERMS } from '../src/lib/legal.js';
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

  console.log('\n[1] the page');
  const page = read('src/features/legal/TermsPage.jsx');
  const heads = [...page.matchAll(/<H2>(\d+)\. ([^<]+)<\/H2>/g)].map((m) => [Number(m[1]), m[2]]);
  assert(heads.length === 19 && heads.every(([n], i) => n === i + 1), `19 sections, numbered 1 to 19 in order (${heads.map((h) => h[0]).join(',')})`);
  assert(heads[7][1] === "Ivy's property" && heads[6][1].startsWith('Your content') && heads[8][1] === 'Service availability' && heads[10][1] === 'Termination' && heads[15][1] === 'Changes to these Terms',
    'section 8 is "Ivy\'s property", right after "Your content & data"; the rest moved down one');
  const s8 = page.slice(page.indexOf("<H2>8. Ivy's property</H2>"), page.indexOf('<H2>9. '));
  const flat = s8.replace(/\s+/g, ' ');
  assert(/We own the Service/.test(flat) && /Ivy AI LLC and its licensors/.test(flat) && /The Ivy name and logo/.test(flat) && /Feedback\./.test(flat) && /Protecting the Service/.test(flat) && /Templates and material we provide/.test(flat),
    'it covers ownership, the name and logo, templates, feedback and protecting the Service');
  assert(/Access or use the Service in order to build a competing product or service/.test(flat) && !/anything you learn from it/.test(flat) && /Except where the law says a restriction like this cannot apply/.test(flat),
    'the competing-product line limits what the Service may be used for, not the right to compete, and yields to the law');
  assert(!/comparison|compare it|benchmark/i.test(flat), 'the "no comparison tests" line was dropped, as decided');
  assert(!/\bbond\b|court for an order/i.test(flat), 'the "court order without a bond" paragraph was dropped, as decided');
  assert(/suspend it under section 11 \(Termination\)/.test(flat) && /stays yours under section 7/.test(flat), 'its two cross-references point at the right sections after renumbering');
  assert(!/registered trademark|®/.test(flat), 'it does not claim the name is a registered trademark');
  assert(/takes effect on December 3, 2026/.test(flat) && /added on November 19, 2026/.test(flat), 'it says when it was added and that it takes effect 14 days later');
  const s6 = page.slice(page.indexOf('<H2>6. Acceptable use</H2>'), page.indexOf('<H2>7. ')).replace(/\s+/g, ' ');
  assert(/Reverse-engineer, scrape, attack, or attempt to gain unauthorized access to the Service or its infrastructure\./.test(s6) && /Resell the Service, sublicense it, or use it to build a competing product\./.test(s6),
    'section 6 is word for word what it was');
  const s16 = page.slice(page.indexOf('<H2>16. Changes to these Terms</H2>'), page.indexOf('<H2>17. ')).replace(/\s+/g, ' ');
  assert(/at least fourteen \(14\) days before they take effect/.test(s16), 'the changes section still promises 14 days\' notice');
  assert(!/[–—]/.test(s8), 'no dashes in the new text');

  console.log('\n[2] one version everywhere');
  const pageVersion = /TERMS_VERSION = '([^']+)'/.exec(page)[1];
  assert(CURRENT_TERMS_VERSION === '2026-11-19' && WEB_TERMS === CURRENT_TERMS_VERSION && pageVersion === CURRENT_TERMS_VERSION, `server, app and page agree (${CURRENT_TERMS_VERSION})`);
  assert(PRIOR_TERMS_VERSIONS.includes('2026-05-05') && acceptableTermsVersion('2026-05-05') === '2026-05-05' && acceptableTermsVersion(CURRENT_TERMS_VERSION) === CURRENT_TERMS_VERSION && acceptableTermsVersion('1999-01-01') === null && acceptableTermsVersion('') === null,
    'the previous version is the only other one accepted at sign-up');

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

  console.log('\n[4] a copy that carries the new Terms');
  r = await call(meHandler, { userId: oldUser.id, query: { tv: CURRENT_TERMS_VERSION, pv: CURRENT_PRIVACY_VERSION } });
  assert(r.body.terms.needsAcceptance === true && r.body.terms.acceptedVersion === '2026-05-05', 'asks this person to accept');
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
  assert(/section 8, "Ivy\\'s property"/.test(modal) && /December 3, 2026/.test(modal) && /Nothing else changed/.test(modal) && !/[–—]/.test(modal.slice(modal.indexOf('const intro'), modal.indexOf('return ('))),
    'the prompt says in plain words what changed and when it takes effect');
  const helper = read('api/helper/accept.js');
  assert(/acceptableTermsVersion\(body\.acceptedTermsVersion\)/.test(helper), 'a helper accepting an invite from an older app is handled the same way');
  const privacy = read('src/features/legal/PrivacyPage.jsx').replace(/\s+/g, ' ');
  assert(/unusual-activity records/.test(privacy) && /automated collection of data from the Service/.test(privacy) && /kept for up to 30 days/.test(privacy), 'the Privacy Policy mentions the unusual-activity records the new section relies on');

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

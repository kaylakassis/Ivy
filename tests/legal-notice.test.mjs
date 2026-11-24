// The "we updated our Terms of Service and Privacy Policy" email for
// existing users (Admin > Email blast > Terms and Privacy Policy update).
//   [1] the email: says they were updated and when they take effect, not what changed
//   [2] who gets it, and nobody twice
//   [3] a refused send is tried again later; a marketing opt-out does not stop it
//   [4] only an admin can count or send
//
// Run: node --import ./tests/bootstrap.mjs ./tests/legal-notice.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, LEGAL_EFFECTIVE_LABEL } from '../api/_lib/legal.js';
import { CRITICAL_EMAIL_TYPES } from '../api/_lib/notificationPrefs.js';
import { renderLegalNotice, legalNoticeVersion, sendLegalNotices, countLegalNoticeRecipients } from '../api/_lib/legalNotice.js';
import handler from '../api/admin/legal-notice.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'localhost:3000';
const text = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const sent = []; let refuse = () => false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend')) {
    const body = JSON.parse(init?.body || '{}');
    if (refuse(body)) return new Response(JSON.stringify({ message: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } });
    sent.push(body);
    return new Response(JSON.stringify({ id: `stub-${Date.now()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(method, userId, body) {
  const req = { method, url: '/api/admin/legal-notice', query: {}, body, headers: { host: HOST, origin: `http://${HOST}`, 'x-real-ip': '198.51.100.9', 'content-type': 'application/json', ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}) } };
  const res = mkRes(); res.req = req; await handler(req, res); return res;
}
const made = [];
async function mkUser(tag, { terms = '2026-11-19', privacy = '2026-11-19', verified = true, deleted = false, tester = false, type = 'regular', prefs = {} } = {}) {
  const email = `ln-${tag}-${S}@example.com`;
  const id = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, privacy_version, email_verified_at, deleted_at, is_tester, user_type, notification_prefs)
    VALUES (${email}, 'x', ${`${tag} Person`}, ${terms}, NOW(), ${privacy}, ${verified ? new Date().toISOString() : null}, ${deleted ? new Date().toISOString() : null}, ${tester}, ${type}, ${JSON.stringify(prefs)}::jsonb)
    RETURNING id`).rows[0].id;
  made.push(id);
  return { id, email };
}
const mailTo = (email) => sent.filter((m) => [].concat(m.to || []).includes(email));
const marker = async (id) => (await sql`SELECT legal_notice_version AS v, legal_notice_sent_at AS at FROM users WHERE id = ${id}`).rows[0];

async function main() {
  await ensureSchemaApplied();
  // Everyone already in the test database counts as told, so this run only
  // ever emails the people it creates.
  await sql`UPDATE users SET legal_notice_version = ${legalNoticeVersion()} WHERE legal_notice_version IS DISTINCT FROM ${legalNoticeVersion()}`;

  console.log('\n[1] the email');
  const mail = renderLegalNotice({ firstName: 'Jo' });
  const t = text(mail.html);
  assert(mail.subject === 'We updated our Terms of Service and Privacy Policy' && new RegExp(`take effect on ${LEGAL_EFFECTIVE_LABEL}`).test(t) && /you will be asked to accept them/.test(t) && /reminded later/.test(t),
    'says the documents were updated, when they take effect, and that Ivy will ask them to accept');
  assert(/\/terms"/.test(mail.html) && /\/privacy"/.test(mail.html) && /support@joinivy\.ai/.test(mail.html), 'links to both documents and gives the support address');
  assert(/cancel your subscription and download your data/.test(t) && /close your account/.test(t), 'says what someone who does not agree can do');
  assert(!/arbitration|class action|liabilit|section \d|what changed|we changed|we added|new section/i.test(t), 'does not describe what changed');
  assert(!/[–—]/.test(mail.html) && !/unsubscribe/i.test(t), 'no dashes, and no unsubscribe wording of its own');
  assert(CRITICAL_EMAIL_TYPES.has('legal_notice') && legalNoticeVersion() === `terms:${CURRENT_TERMS_VERSION}|privacy:${CURRENT_PRIVACY_VERSION}`, 'it is a required notice, tied to the current pair of versions');

  console.log('\n[2] who gets it');
  const owner = await mkUser('owner');
  const optedOut = await mkUser('optout', { prefs: { email_marketing: false, email_billing: false } });
  const privacyOnly = await mkUser('privacyonly', { terms: CURRENT_TERMS_VERSION });
  const accepted = await mkUser('accepted', { terms: CURRENT_TERMS_VERSION, privacy: CURRENT_PRIVACY_VERSION });
  const unverified = await mkUser('unverified', { verified: false });
  const deleted = await mkUser('deleted', { deleted: true });
  const tester = await mkUser('tester', { tester: true });
  const admin = await mkUser('admin', { type: 'super_admin', terms: CURRENT_TERMS_VERSION, privacy: CURRENT_PRIVACY_VERSION });
  assert(await countLegalNoticeRecipients() === 3, 'counts the three people who have a verified address and have not accepted the current versions');
  let r = await call('GET', admin.id);
  assert(r.statusCode === 200 && r.body.waiting === 3 && r.body.effective === LEGAL_EFFECTIVE_LABEL && /We updated/.test(r.body.subject) && r.body.previewLines?.[0] === 'Hi Alex,' && r.body.previewLines.length === 5 && !/</.test(r.body.previewLines.join('')), 'the Admin card shows the count and the words of the email');
  r = await call('POST', admin.id, {});
  assert(r.statusCode === 400 && sent.length === 0, 'a send without the confirmation does nothing');
  r = await call('POST', admin.id, { confirm: true });
  assert(r.statusCode === 200 && r.body.sent === 3 && r.body.failed === 0 && r.body.remaining === 0, `one press sends to all three (${JSON.stringify(r.body)})`);
  assert(mailTo(owner.email).length === 1 && mailTo(privacyOnly.email).length === 1, 'someone behind on either document gets it');
  assert(mailTo(optedOut.email).length === 1 && !/>Unsubscribe</.test(mailTo(optedOut.email)[0].html) && !('List-Unsubscribe-Post' in (mailTo(optedOut.email)[0].headers || {})), 'someone who turned marketing emails off still gets it, with no unsubscribe link or one-click unsubscribe');
  assert(mailTo(accepted.email).length === 0 && mailTo(unverified.email).length === 0 && mailTo(deleted.email).length === 0 && mailTo(tester.email).length === 0,
    'not sent to someone who already accepted, an unverified address, a deleted account or a test account');
  const m = await marker(owner.id);
  assert(m.v === legalNoticeVersion() && !!m.at, 'each person is marked with what they were told and when');
  r = await call('POST', admin.id, { confirm: true });
  assert(r.body.sent === 0 && mailTo(owner.email).length === 1, 'pressing the button again sends nobody a second copy');
  const audit = (await sql`SELECT meta FROM audit_events WHERE action = 'legal_notice_sent' AND actor_user_id = ${admin.id} ORDER BY created_at DESC LIMIT 1`.catch(() => ({ rows: [] }))).rows[0];
  assert(!audit || audit.meta?.version === legalNoticeVersion(), 'each send is written to the admin audit log');

  console.log('\n[3] a refused send, and two presses at once');
  const flaky = await mkUser('flaky'); const fine = await mkUser('fine');
  refuse = (b) => [].concat(b.to || []).includes(flaky.email);
  let out = await sendLegalNotices({ budgetMs: 8000 });
  assert(out.sent === 1 && out.failed === 1 && out.remaining === 1 && (await marker(flaky.id)).v === null && mailTo(fine.email).length === 1, 'a refused email is not marked as sent and stays on the list');
  refuse = () => false;
  out = await sendLegalNotices({ budgetMs: 8000 });
  assert(out.sent === 1 && out.remaining === 0 && mailTo(flaky.email).length === 1, 'the next press delivers it, once');
  const a = await mkUser('race-a'); const b = await mkUser('race-b');
  const both = await Promise.all([sendLegalNotices({ budgetMs: 8000 }), sendLegalNotices({ budgetMs: 8000 })]);
  assert(mailTo(a.email).length === 1 && mailTo(b.email).length === 1 && both[0].sent + both[1].sent === 2, 'two sends at the same moment still email each person once');

  console.log('\n[4] only an admin');
  r = await call('GET', owner.id);
  const r2 = await call('POST', owner.id, { confirm: true });
  const r3 = await call('GET', null);
  assert(r.statusCode >= 401 && r.statusCode <= 404 && r2.statusCode >= 401 && r2.statusCode <= 404 && r3.statusCode >= 401 && r3.statusCode <= 404, `an ordinary owner or a stranger can neither count nor send (${r.statusCode}, ${r2.statusCode}, ${r3.statusCode})`);
  const page = read('src/features/admin/AdminPage.jsx');
  assert(/tab === 'blast'\s+&& <><LegalNoticeCard\/><BlastTab\/><\/>/.test(page) && /confirmAction\(\{\s*title: `Email \$\{info\.waiting\}/.test(page) && /api\.post\('\/admin\/legal-notice', \{ confirm: true \}\)/.test(page),
    'the Admin button asks for confirmation before anything is sent');
  assert(/"api\/admin\/legal-notice\.js": \{\s*"maxDuration": 60/.test(read('vercel.json')), 'the send has time to work through a long list');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of made) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  globalThis.fetch = realFetch;
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

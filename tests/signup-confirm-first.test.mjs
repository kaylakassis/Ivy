// Sign-up never says whether an email already has an Ivy account.
//   [1] a new address and an address that already has an account get the same answer
//   [2] the truth goes to the inbox
//   [3] until the link is opened, the account cannot be signed in to (and looks like a wrong password)
//   [4] opening the link finishes the account; only the browser that signed up is signed straight in
//   [5] a second attempt replaces an unfinished one; mail scanners; password reset
//   [6] iPhone apps from before this still work, with the old answer capped
//   [7] the screens
//
// Run: node --import ./tests/bootstrap.mjs ./tests/signup-confirm-first.test.mjs
import { readFileSync } from 'node:fs';
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_confirm';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { issueFormToken } from '../api/_lib/humanCheck.js';
import { createToken, KIND_RESET } from '../api/_lib/tokens.js';
import { makeSignupTicket, makeDecoyTicket, readSignupTicket } from '../api/_lib/signupTicket.js';
import signupHandler from '../api/auth/signup.js';
import loginHandler from '../api/auth/login.js';
import verifyHandler from '../api/auth/verify-email.js';
import statusHandler from '../api/auth/signup-status.js';
import resetHandler from '../api/auth/reset-password.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'www.joinivy.ai';
const emailsUsed = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const sent = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  if (/api\.resend\.com/.test(String(url))) { try { sent.push(JSON.parse(String(init.body))); } catch { sent.push({}); } return json({ id: `em_${sent.length}` }); }
  return json({});
};
const mailTo = (addr) => sent.filter((m) => [].concat(m.to || []).includes(addr));
const linkToken = (m) => decodeURIComponent((/verify-email\?token=([^"&\s<]+)/.exec(m?.html || '') || [])[1] || '');

function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
let ipN = 1;
const nextIp = () => `198.51.100.${(ipN++ % 250) + 1}`;
async function call(handler, body, { ip = nextIp(), headers = {} } = {}) {
  const req = { method: 'POST', url: '/api/auth/x', query: {}, body, headers: { host: HOST, origin: `https://${HOST}`, 'x-real-ip': ip, 'content-type': 'application/json', ...headers } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}
const form = (email, password, extra = {}) => ({
  email, password, name: 'Casey Confirm', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
  acceptedAccountEmails: true, accountEmailsConsent: true, formToken: issueFormToken(Date.now() - 5000), ...extra,
});
const hasSession = (res) => [].concat(res.headers['set-cookie'] || []).some((c) => /^ivy_session=[^;]+/.test(c) && !/Max-Age=0/.test(c));
const userOf = async (email) => (await sql`SELECT id, confirm_required, email_verified_at, name FROM users WHERE email = ${email} AND deleted_at IS NULL`).rows[0] || null;
const addr = (tag) => { const e = `confirm-${tag}-${S}@example.com`; emailsUsed.push(e); return e; };
const PW = 'a-good-password-123';

async function main() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'signup%' OR key LIKE 'login:%'`;

  console.log('\n[1] the same answer either way');
  const taken = addr('taken');
  await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, signup_role) VALUES (${taken}, 'x', 'Tina Taken', NOW(), ${CURRENT_TERMS_VERSION}, 'owner')`;
  const fresh = addr('fresh');
  const rNew = await call(signupHandler, form(fresh, PW, { confirmFirst: true }));
  const rOld = await call(signupHandler, form(taken, PW, { confirmFirst: true }));
  assert(rNew.statusCode === 202 && rOld.statusCode === 202, `both answer the same status (${rNew.statusCode}, ${rOld.statusCode})`);
  assert(JSON.stringify(Object.keys(rNew.body).sort()) === JSON.stringify(Object.keys(rOld.body).sort()) && rNew.body.checkEmail === true && rOld.body.checkEmail === true,
    `with the same fields (${Object.keys(rNew.body).join(', ')})`);
  const shape = /^[0-9a-f-]{36}\.\d{13}\.[0-9a-f]{64}$/;
  assert(shape.test(rNew.body.ticket) && shape.test(rOld.body.ticket) && rNew.body.ticket.length === rOld.body.ticket.length, 'and tickets that look alike');
  assert(!hasSession(rNew) && !hasSession(rOld) && !rNew.headers['set-cookie'] && !rOld.headers['set-cookie'], 'neither sets a cookie or signs anyone in');
  assert(!JSON.stringify(rOld.body).match(/exist|taken|already/i) && !JSON.stringify(rNew.body).match(/exist|taken|already/i), 'nothing in either answer says "already exists"');
  const created = await userOf(fresh);
  assert(created?.confirm_required === true && !created.email_verified_at, 'the new address has an account waiting to be finished');
  assert((await sql`SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = ${taken}`).rows[0].n === 1, 'the existing account is untouched, and no second one was made');
  const bad = await call(signupHandler, form(addr('weak'), 'short', { confirmFirst: true }));
  assert(bad.statusCode === 400, 'a form mistake (a short password) is still pointed out');

  console.log('\n[2] the truth goes to the inbox');
  const newMail = mailTo(fresh);
  assert(newMail.length === 1 && /Finish creating your Ivy account/.test(newMail[0].subject) && linkToken(newMail[0]).length > 20, 'the new address gets one email with the link to finish (and no welcome email yet)');
  const oldMail = mailTo(taken);
  assert(oldMail.length === 1 && /You already have an Ivy account/.test(oldMail[0].subject) && /\/signin/.test(oldMail[0].html) && /Hi Tina/.test(oldMail[0].html) && !/verify-email\?token/.test(oldMail[0].html),
    'the existing account\'s owner is told someone tried, with a link to sign in');
  const words = (m) => `${m.subject} ${m.html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')}`;
  assert(!/[\u2013\u2014]/.test(words(newMail[0]) + words(oldMail[0])) && /nothing will be created/.test(words(newMail[0])) && /Your account is safe/.test(words(oldMail[0])),
    'both emails are plain words, and each says what happens if it was not you');
  for (let i = 0; i < 4; i++) await call(signupHandler, form(taken, PW, { confirmFirst: true }));
  assert(mailTo(taken).length === 3, 'at most three such emails a day, so it cannot be used to pester someone');

  console.log('\n[3] before the link is opened');
  const ip = nextIp();
  const wrong = await call(loginHandler, { email: fresh, password: 'not-the-password-9' }, { ip });
  const early = await call(loginHandler, { email: fresh, password: PW }, { ip });
  const nobody = await call(loginHandler, { email: addr('nobody'), password: PW }, { ip: nextIp() });
  const strip = (b) => String(b?.error || '').replace(/\d+ attempts? left/, 'N left');
  assert(early.statusCode === 401 && !hasSession(early), 'the right password does not sign in yet');
  assert(strip(early.body) === strip(wrong.body) && strip(early.body) === strip(nobody.body) && /Invalid email or password/.test(early.body.error),
    'and it reads exactly like a wrong password or an unknown address');
  let st = await call(statusHandler, { ticket: rNew.body.ticket });
  const stDecoy = await call(statusHandler, { ticket: rOld.body.ticket });
  const stJunk = await call(statusHandler, { ticket: 'nonsense' });
  assert(st.body.confirmed === false && stDecoy.body.confirmed === false && stJunk.body.confirmed === false && JSON.stringify(st.body) === JSON.stringify(stDecoy.body),
    '"has the link been opened?" is no for the new sign-up, for the existing address, and for junk alike');
  assert(readSignupTicket(rNew.body.ticket) === created.id && readSignupTicket(rOld.body.ticket) && !(await sql`SELECT 1 FROM users WHERE id = ${readSignupTicket(rOld.body.ticket)}`).rows.length,
    'the existing address\'s ticket points at nobody');

  console.log('\n[4] opening the link');
  const otherDevice = addr('other');
  const rOther = await call(signupHandler, form(otherDevice, PW, { confirmFirst: true, mode: 'client' }));
  let v = await call(verifyHandler, { token: linkToken(mailTo(otherDevice)[0]) });
  assert(v.statusCode === 200 && v.body.confirmed === true && v.body.signedIn === false && !hasSession(v) && JSON.stringify(Object.keys(v.body.user)) === '["email"]',
    'opened somewhere else (another phone, the mail app): confirmed, not signed in, and no account details handed over');
  st = await call(statusHandler, { ticket: rOther.body.ticket });
  assert(st.body.confirmed === true, 'the screen that is waiting sees it has been opened');
  let li = await call(loginHandler, { email: otherDevice, password: PW });
  assert(li.statusCode === 200 && hasSession(li), 'and the password they chose now signs in');
  assert(mailTo(otherDevice).some((m) => !/Finish creating/.test(m.subject)), 'the welcome email goes out once the address is confirmed');

  v = await call(verifyHandler, { token: linkToken(newMail[0]), ticket: rNew.body.ticket }, { ip });
  const done = await userOf(fresh);
  assert(v.statusCode === 200 && v.body.signedIn === true && hasSession(v) && v.body.user.email === fresh && done.confirm_required === false && done.email_verified_at,
    'opened in the browser that signed up: confirmed and signed straight in');
  li = await call(loginHandler, { email: fresh, password: PW }, { ip });
  assert(li.statusCode === 200, 'the earlier "wrong password" marks from trying too soon are forgiven');
  const thief = addr('thief');
  const rThief = await call(signupHandler, form(thief, PW, { confirmFirst: true }));
  v = await call(verifyHandler, { token: linkToken(mailTo(thief)[0]), ticket: rNew.body.ticket });
  assert(v.body.confirmed === true && v.body.signedIn === false && !hasSession(v), 'a ticket from a different sign-up does not sign anyone in');
  v = await call(verifyHandler, { token: 'made-up-token', ticket: rThief.body.ticket });
  assert(v.statusCode === 401 && !hasSession(v), 'a ticket without a real link does nothing');
  assert(readSignupTicket(makeSignupTicket(done.id, Date.now() - 25 * 3600e3)) === null && readSignupTicket(`${done.id}.9999999999999.${'0'.repeat(64)}`) === null && readSignupTicket(makeDecoyTicket()) !== null,
    'tickets expire after a day and cannot be forged');

  console.log('\n[5] second attempts, mail scanners, password reset');
  const redo = addr('redo');
  await call(signupHandler, form(redo, 'first-password-123', { confirmFirst: true }));
  const firstId = (await userOf(redo)).id;
  const firstLink = linkToken(mailTo(redo)[0]);
  const r2 = await call(signupHandler, form(redo, 'second-password-456', { confirmFirst: true, name: 'Second Try' }));
  const second = await userOf(redo);
  assert(r2.statusCode === 202 && second.id !== firstId && second.name === 'Second Try' && mailTo(redo).length === 2, '"Send it again" (or signing up again) replaces the unfinished attempt and sends a fresh link');
  v = await call(verifyHandler, { token: firstLink });
  assert(v.statusCode === 401, 'the older email\'s link stops working');
  v = await call(verifyHandler, { token: linkToken(mailTo(redo)[1]) });
  li = await call(loginHandler, { email: redo, password: 'second-password-456' });
  const liOld = await call(loginHandler, { email: redo, password: 'first-password-123' });
  assert(v.body.confirmed === true && li.statusCode === 200 && liOld.statusCode === 401, 'the newest attempt\'s password is the one that counts');
  const r3 = await call(signupHandler, form(redo, PW, { confirmFirst: true }));
  assert(r3.statusCode === 202 && (await userOf(redo)).id === second.id && /already have an Ivy account/.test(mailTo(redo).slice(-1)[0].subject), 'once finished, it is a real account like any other');

  const scan = addr('scanned');
  const rScan = await call(signupHandler, form(scan, PW, { confirmFirst: true }));
  const scanLink = linkToken(mailTo(scan)[0]);
  await call(verifyHandler, { token: scanLink });                      // the mail scanner
  v = await call(verifyHandler, { token: scanLink, ticket: rScan.body.ticket });   // then the person
  assert(v.statusCode === 200 && v.body.signedIn === true && hasSession(v), 'a mail scanner opening the link first does not strand the person: their tap still signs them in');
  v = await call(verifyHandler, { token: scanLink });
  assert(v.statusCode === 200 && !hasSession(v), 'the used link on its own signs nobody in');

  const forgot = addr('forgot');
  await call(signupHandler, form(forgot, PW, { confirmFirst: true }));
  const fu = await userOf(forgot);
  const resetToken = await createToken({ userId: fu.id, kind: KIND_RESET, ttlMinutes: 30 });
  const rs = await call(resetHandler, { token: resetToken, password: 'brand-new-password-789' });
  const fu2 = await userOf(forgot);
  li = await call(loginHandler, { email: forgot, password: 'brand-new-password-789' });
  assert(rs.statusCode === 200 && fu2.confirm_required === false && fu2.email_verified_at && li.statusCode === 200, 'resetting the password from the inbox also finishes the account (it proves the address)');
  const before = await sql`SELECT email_verified_at FROM users WHERE email = ${taken}`;
  assert(before.rows[0].email_verified_at, 'accounts that were already confirmed are unchanged by any of this');

  console.log('\n[6] iPhone apps from before this');
  const legacy = addr('legacy');
  const lg = await call(signupHandler, form(legacy, PW));
  const lu = await userOf(legacy);
  assert(lg.statusCode === 201 && lg.body.user?.email === legacy && hasSession(lg) && lu.confirm_required === false, 'an older app (no flag) still gets an account and is signed in at once');
  li = await call(loginHandler, { email: legacy, password: PW });
  assert(li.statusCode === 200, 'and can sign in without confirming first, as before');
  const oneIp = nextIp();
  await sql`DELETE FROM rate_limits WHERE key LIKE ${`signup%${oneIp}`}`;
  const codes = [];
  for (let i = 0; i < 7; i++) {
    await sql`DELETE FROM rate_limits WHERE key = ${`signup:ip:${oneIp}`}`;   // isolate the cap under test from the general sign-up cap
    codes.push((await call(signupHandler, form(taken, PW), { ip: oneIp })).statusCode);
  }
  assert(codes.slice(0, 5).every((c) => c === 400) && codes.slice(5).every((c) => c === 429), `the old "already has an account" answer is capped at five an hour per network (${codes.join(',')})`);

  console.log('\n[7] the screens');
  const auth = read('src/lib/auth.jsx'); const page = read('src/features/auth/AuthPage.jsx'); const wait = read('src/features/auth/CheckEmail.jsx'); const verify = read('src/features/auth/VerifyEmailPage.jsx');
  assert(/confirmFirst: true,/.test(auth) && /if \(r\?\.checkEmail\) \{/.test(auth) && /ivy_signup_ticket/.test(auth), 'the app asks for the confirm-first flow and keeps the ticket');
  assert(/if \(r\?\.checkEmail\) \{ setPending\(/.test(page) && /<CheckEmail/.test(page) && /Just signed up\? Open the link in the email we sent you first\./.test(page), 'the form hands over to "Check your email", and a failed sign-in reminds a new person to open the link');
  const copy = wait.replace(/\s+/g, ' ');
  assert(/Check your email/.test(copy) && /If this address already has an Ivy account, the email tells you how to sign in instead\./.test(copy) && /Send it again/.test(copy) && /Use a different email/.test(copy) && /I have opened the link/.test(copy),
    'that screen says what to do, covers the "already have an account" case honestly, and offers resend and change email');
  assert(/\/auth\/signup-status/.test(wait) && /signIn\(email, password\)/.test(wait) && !/localStorage\.setItem\([^)]*password/.test(wait + auth), 'it carries on by itself once the link is opened; the password is never stored');
  assert(!/[–—]/.test(wait.slice(wait.indexOf('return ('))), 'no dashes in what people read');
  assert(/ticket: ticket \|\| undefined/.test(verify) && /status === 'confirmed'/.test(verify) && /it will carry on by itself/.test(verify.replace(/\s+/g, ' ')), 'the link\'s page sends the ticket and has a "confirmed, go back to where you signed up" state');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const e of emailsUsed) {
    const u = (await sql`SELECT id FROM users WHERE LOWER(email) = ${e}`.catch(() => ({ rows: [] }))).rows;
    for (const row of u) { await sql`DELETE FROM workspaces WHERE owner_id = ${row.id}`.catch(() => {}); await sql`DELETE FROM users WHERE id = ${row.id}`.catch(() => {}); }
  }
  await sql`DELETE FROM rate_limits WHERE key LIKE 'signup%' OR key LIKE 'login:%'`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

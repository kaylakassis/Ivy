// 2-step verification by email code, end to end against the real handlers:
//   - turning it on needs a verified email + a setup code, and returns backup codes
//   - sign-in returns mfaRequired and emails exactly one code; no session yet
//   - 5 wrong tries burn a code; an expired code is refused; a code from
//     another account never works
//   - the right code issues a session (cookie on web; token in the body for
//     the iPhone app, which also gets mfaToken in the login body)
//   - "Send a new code": 30-second cooldown and 5 codes per hour
//   - backup codes still work; accounts with an app as well default to the app
//   - turning it off needs the password; impersonated sessions are refused
//   - client portal users and helpers can turn it on and are gated at sign-in
//   - password reset on an email-2FA account lands on the code step
//   - security emails + audit rows on every on/off; the dashboard nudge
//
// Run: node --import ./tests/bootstrap.mjs ./tests/mfa-email.test.mjs
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { hashPassword, signSession, readSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { generateSecret, base32Encode, generateTotp } from '../api/_lib/totp.js';
import { createToken, KIND_RESET } from '../api/_lib/tokens.js';
import { maskEmail } from '../api/_lib/mfaEmail.js';
import loginHandler from '../api/auth/login.js';
import challengeHandler from '../api/auth/totp/challenge.js';
import totpDisable from '../api/auth/totp/disable.js';
import sendCode from '../api/auth/mfa/send-code.js';
import emailSetup from '../api/auth/mfa/email-setup.js';
import emailEnable from '../api/auth/mfa/email-enable.js';
import mfaDisable from '../api/auth/mfa/disable.js';
import resetPassword from '../api/auth/reset-password.js';
import meHandler from '../api/auth/me.js';
import dashboardHandler from '../api/dashboard.js';
import twoStepPrompt from '../api/me/two-step-prompt.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}

// Capture outbound mail instead of calling Resend.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ id: 'captured' }), text: async () => '{}' };
  }
  return realFetch(url, init);
};
const mailTo = (email) => sent.filter((m) => (m.to || []).includes(email));
const codeMails = (email) => mailTo(email).filter((m) => /sign-in code|code to turn on/.test(m.subject));
const lastCode = (email) => {
  const m = codeMails(email).at(-1);
  return m ? m.subject.match(/^(\d{6})/)[1] : null;
};
// Security alerts are fire-and-forget; give them a beat to land.
const settle = () => new Promise((r) => setTimeout(r, 400));

const STAMP = Date.now();
let ipC = 0;
function makeReq({ body = {}, headers = {}, method = 'POST', cookie } = {}) {
  ipC++;
  return {
    method, url: '/test', query: {}, body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `203.0.113.${(STAMP + ipC) % 250}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) {
      const key = k.toLowerCase();
      // Node/Vercel semantics: a second setHeader('Set-Cookie') REPLACES the
      // first, so a handler that sets two cookies must send them together.
      if (key === 'set-cookie') this.headers[key] = Array.isArray(v) ? [...v] : [v];
      else this.headers[key] = v;
    },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const cookieVal = (res, name) => {
  const c = (res.headers['set-cookie'] || []).filter((x) => x.startsWith(name + '=')).at(-1);
  if (!c) return null;
  return c.split(';')[0].slice(name.length + 1) || null;
};
const call = async (handler, opts) => { const res = makeRes(); await handler(makeReq(opts), res); return res; };
const sess = (uid, extra) => `ivy_session=${signSession(uid, extra)}`;
const clearLimits = (uid) => sql`DELETE FROM rate_limits WHERE key LIKE ${'%' + uid + '%'}`;

const created = [];
const workspaces = [];
const PASSWORD = 'CorrectHorse9!';
async function mkUser(tag, { verified = true, createdDaysAgo = 0 } = {}) {
  const email = `mfa-email-${tag}-${STAMP}@example.com`;
  const r = await sql`
    INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at, created_at)
    VALUES (${email}, ${await hashPassword(PASSWORD)}, ${'Kay ' + tag}, ${verified ? new Date().toISOString() : null},
            '2026-05-05', NOW(), NOW() - make_interval(days => ${createdDaysAgo}))
    RETURNING id, email`;
  created.push(r.rows[0].id);
  return r.rows[0];
}
const login = (email, headers = {}) => call(loginHandler, { body: { email, password: PASSWORD }, headers });

// Turn email codes on through the real endpoints. Returns the backup codes.
async function enableEmail(u) {
  const s = await call(emailSetup, { cookie: sess(u.id) });
  if (s.statusCode !== 200) throw new Error(`setup ${s.statusCode} ${JSON.stringify(s.body)}`);
  const e = await call(emailEnable, { cookie: sess(u.id), body: { code: lastCode(u.email) } });
  if (e.statusCode !== 200) throw new Error(`enable ${e.statusCode} ${JSON.stringify(e.body)}`);
  // Let the next code go out without waiting out the 30-second cooldown.
  await sql`UPDATE mfa_email_codes SET created_at = created_at - INTERVAL '31 seconds' WHERE user_id = ${u.id}`;
  return e.body.backupCodes;
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] turning on email codes needs a verified email and a setup code');
  const unverified = await mkUser('unverified', { verified: false });
  let r = await call(emailSetup, { cookie: sess(unverified.id) });
  assert(r.statusCode === 400 && /Confirm your email/.test(r.body?.error), `unverified email → 400 (${r.statusCode})`);
  assert(codeMails(unverified.email).length === 0, 'no code emailed to an unverified address');

  const owner = await mkUser('owner');
  r = await call(emailSetup, { cookie: sess(owner.id) });
  assert(r.statusCode === 200 && r.body.sent === true, 'setup sends a code');
  assert(r.body.email === maskEmail(owner.email) && !r.body.email.includes(owner.email.split('@')[0]), 'address is masked in the reply');
  assert(codeMails(owner.email).length === 1, 'exactly one setup email');
  const setupMail = codeMails(owner.email)[0];
  assert(/code to turn on 2-step/.test(setupMail.subject), 'setup email subject names the purpose');
  assert(!/data-ivy-unsub|Unsubscribe/i.test(setupMail.html), 'code email carries no unsubscribe link');
  const stored = (await sql`SELECT code_hash FROM mfa_email_codes WHERE user_id = ${owner.id}`).rows;
  assert(stored.length === 1 && !stored[0].code_hash.includes(lastCode(owner.email)), 'code stored hashed, never in plain text');

  r = await call(emailEnable, { cookie: sess(owner.id), body: { code: lastCode(owner.email) === '000000' ? '000001' : '000000' } });
  assert(r.statusCode === 400, 'wrong setup code → 400');
  let row = (await sql`SELECT mfa_email_enabled_at FROM users WHERE id = ${owner.id}`).rows[0];
  assert(row.mfa_email_enabled_at == null, 'still off after a wrong setup code');
  r = await call(loginHandler, { body: { email: owner.email, password: PASSWORD } });
  assert(!!cookieVal(r, 'ivy_session') && !r.body?.mfaRequired, 'sign-in not gated mid-setup');

  r = await call(emailEnable, { cookie: sess(owner.id), body: { code: lastCode(owner.email) } });
  assert(r.statusCode === 200 && r.body.enabled === true, 'right setup code → on');
  assert(Array.isArray(r.body.backupCodes) && r.body.backupCodes.length === 10, '10 backup codes shown once');
  const ownerBackups = r.body.backupCodes;
  r = await call(meHandler, { method: 'GET', cookie: sess(owner.id) });
  assert(!!r.body.user.mfa_email_enabled_at, '/auth/me shows email codes on');
  await settle();
  assert(mailTo(owner.email).some((m) => /Two-factor authentication is on/.test(m.subject)), 'security email: 2-step turned on');
  const audit = (await sql`SELECT action FROM audit_events WHERE target_user_id = ${owner.id}`).rows.map((x) => x.action);
  assert(audit.includes('mfa_email.enabled'), 'audit row for turning it on');
  await sql`UPDATE mfa_email_codes SET created_at = created_at - INTERVAL '31 seconds' WHERE user_id = ${owner.id}`;

  console.log('\n[2] sign-in asks for a code and emails exactly one');
  const before = codeMails(owner.email).length;
  const l1 = await login(owner.email);
  assert(l1.statusCode === 200 && l1.body?.mfaRequired === true, 'login returns mfaRequired');
  assert(JSON.stringify(l1.body.mfaMethods) === '["email"]' && l1.body.mfaEmailSent === true, 'method email, code sent');
  assert(!l1.body.user && !cookieVal(l1, 'ivy_session'), 'no user, no session cookie yet');
  assert(!l1.body.mfaToken, 'web login does not put the mfa token in the body');
  const mfa1 = cookieVal(l1, 'ivy_mfa');
  assert(!!mfa1 && readSession({ headers: { authorization: `Bearer ${mfa1}` } }) === null, 'mfa-pending cookie set and not usable as a session');
  assert(codeMails(owner.email).length === before + 1, 'exactly one sign-in code emailed');
  const code1 = lastCode(owner.email);

  console.log('\n[3] five wrong tries burn the code');
  const wrong = code1 === '111111' ? '222222' : '111111';
  let lastWrong;
  for (let i = 0; i < 5; i++) lastWrong = await call(challengeHandler, { cookie: `ivy_mfa=${mfa1}`, body: { code: wrong } });
  assert(lastWrong.statusCode === 401 && !cookieVal(lastWrong, 'ivy_session'), 'wrong codes → 401, no session');
  await clearLimits(owner.id); // keep the per-minute limiter out of the way
  r = await call(challengeHandler, { cookie: `ivy_mfa=${mfa1}`, body: { code: code1 } });
  assert(r.statusCode === 401 && /Too many wrong tries/.test(r.body?.error), `right code after 5 misses is refused (${r.body?.error})`);
  assert(!cookieVal(r, 'ivy_session'), 'no session from a burned code');

  console.log('\n[4] "Send a new code": 30-second cooldown, then a fresh code works');
  r = await call(sendCode, { cookie: `ivy_mfa=${mfa1}` });
  assert(r.statusCode === 429 && r.body.retryAfterSeconds > 0 && r.body.retryAfterSeconds <= 30, `resend within 30s → 429 (${r.statusCode}, ${r.body?.retryAfterSeconds}s)`);
  await sql`UPDATE mfa_email_codes SET created_at = created_at - INTERVAL '31 seconds' WHERE user_id = ${owner.id}`;
  const n0 = codeMails(owner.email).length;
  r = await call(sendCode, { cookie: `ivy_mfa=${mfa1}` });
  assert(r.statusCode === 200 && r.body.sent && r.body.cooldownSeconds === 30, 'resend after cooldown → 200');
  assert(codeMails(owner.email).length === n0 + 1, 'one new email');
  const code2 = lastCode(owner.email);
  await clearLimits(owner.id);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${mfa1}`, body: { code: code2 } });
  assert(r.statusCode === 200 && r.body.user?.id === owner.id, 'new code → 200 + user');
  assert(!!cookieVal(r, 'ivy_session') && !r.body.token, 'web: session cookie, no token in body');
  r = await call(challengeHandler, { cookie: `ivy_mfa=${mfa1}`, body: { code: code2 } });
  assert(r.statusCode === 401, 'a used code cannot be used twice');
  r = await call(sendCode, { cookie: sess(owner.id) });
  assert(r.statusCode === 401, 'send-code needs the sign-in step token, not a session');

  console.log('\n[5] at most 5 codes per hour');
  await sql`UPDATE mfa_email_codes SET created_at = NOW() - INTERVAL '40 minutes' WHERE user_id = ${owner.id}`;
  const have = (await sql`SELECT COUNT(*)::int AS n FROM mfa_email_codes WHERE user_id = ${owner.id}`).rows[0].n;
  for (let i = have; i < 5; i++) {
    await sql`INSERT INTO mfa_email_codes (user_id, purpose, code_hash, expires_at, consumed_at, created_at)
              VALUES (${owner.id}, 'login', 'x', NOW(), NOW(), NOW() - INTERVAL '30 minutes')`;
  }
  const l2 = await login(owner.email);
  assert(l2.body?.mfaRequired === true && l2.body.mfaEmailSent === false && /Too many codes/.test(l2.body.mfaEmailError || ''), 'sign-in past the hourly cap: still gated, no email, says why');
  const n1 = codeMails(owner.email).length;
  r = await call(sendCode, { cookie: `ivy_mfa=${cookieVal(l2, 'ivy_mfa')}` });
  assert(r.statusCode === 429 && /Too many codes/.test(r.body.error), 'resend past the hourly cap → 429');
  assert(codeMails(owner.email).length === n1, 'nothing emailed past the cap');

  console.log('\n[6] a backup code still works');
  await clearLimits(owner.id);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(l2, 'ivy_mfa')}`, body: { code: ownerBackups[0] } });
  assert(r.statusCode === 200 && !!cookieVal(r, 'ivy_session'), 'backup code → session');
  await sql`DELETE FROM mfa_email_codes WHERE user_id = ${owner.id}`;

  console.log('\n[7] an expired code is refused');
  const l3 = await login(owner.email);
  const code3 = lastCode(owner.email);
  await sql`UPDATE mfa_email_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = ${owner.id} AND consumed_at IS NULL`;
  await clearLimits(owner.id);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(l3, 'ivy_mfa')}`, body: { code: code3 } });
  assert(r.statusCode === 401 && /expired/.test(r.body?.error), `expired code → 401 (${r.body?.error})`);
  await sql`DELETE FROM mfa_email_codes WHERE user_id = ${owner.id}`;

  console.log('\n[8] iPhone app: mfaToken in the body, session token back');
  const ios = { 'x-client-platform': 'ios' };
  const l4 = await login(owner.email, ios);
  assert(l4.body?.mfaRequired && typeof l4.body.mfaToken === 'string', 'native login returns mfaToken in the body');
  const code4 = lastCode(owner.email);
  await clearLimits(owner.id);
  r = await call(challengeHandler, { headers: ios, body: { code: code4, mfaToken: l4.body.mfaToken } });
  assert(r.statusCode === 200 && typeof r.body.token === 'string', 'native challenge returns the session token');
  assert(readSession({ headers: { authorization: `Bearer ${r.body.token}` } })?.sub === owner.id, 'Bearer token is a real session');
  await sql`UPDATE mfa_email_codes SET created_at = created_at - INTERVAL '31 seconds' WHERE user_id = ${owner.id}`;
  r = await call(sendCode, { headers: ios, body: { mfaToken: l4.body.mfaToken } });
  assert(r.statusCode === 200, 'native "Send a new code" works with the body token');
  await sql`DELETE FROM mfa_email_codes WHERE user_id = ${owner.id}`;

  console.log('\n[9] a code from another account never works');
  const other = await mkUser('other');
  await enableEmail(other);
  const la = await login(owner.email);
  const lb = await login(other.email);
  const codeA = lastCode(owner.email);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(lb, 'ivy_mfa')}`, body: { code: codeA } });
  assert(r.statusCode === 401 && !cookieVal(r, 'ivy_session'), "owner's code on the other account's step → 401");
  await clearLimits(owner.id);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(la, 'ivy_mfa')}`, body: { code: codeA } });
  assert(r.statusCode === 200 && r.body.user.id === owner.id, "and it still works for its own account");

  console.log('\n[10] password reset on an email-2FA account lands on the code step');
  await sql`DELETE FROM mfa_email_codes WHERE user_id = ${owner.id}`;
  const raw = await createToken({ userId: owner.id, kind: KIND_RESET, ttlMinutes: 30 });
  const nm = codeMails(owner.email).length;
  r = await call(resetPassword, { body: { token: raw, password: PASSWORD } });
  assert(r.statusCode === 200 && r.body.mfaRequired === true && !r.body.user, `reset → mfaRequired, no user (${r.statusCode})`);
  assert(!cookieVal(r, 'ivy_session') && !!cookieVal(r, 'ivy_mfa'), 'reset → mfa cookie, no session');
  assert(r.body.mfaEmailSent === true && codeMails(owner.email).length === nm + 1, 'reset emails the sign-in code');
  const resetMfa = cookieVal(r, 'ivy_mfa');
  await clearLimits(owner.id);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${resetMfa}`, body: { code: lastCode(owner.email) } });
  assert(r.statusCode === 200 && !!cookieVal(r, 'ivy_session'), 'code after reset → session');

  console.log('\n[11] app + email: sign-in defaults to the app, email on request');
  const both = await mkUser('both');
  await enableEmail(both);
  const secret = generateSecret();
  await sql`UPDATE users SET totp_secret_encrypted = ${encrypt(base32Encode(secret))}, totp_enrolled_at = NOW() WHERE id = ${both.id}`;
  const nb = codeMails(both.email).length;
  const l5 = await login(both.email);
  assert(JSON.stringify(l5.body.mfaMethods) === '["totp","email"]' && !l5.body.mfaEmailSent, 'methods [totp, email]; no email sent up front');
  assert(codeMails(both.email).length === nb, 'no code emailed until asked');
  r = await call(sendCode, { cookie: `ivy_mfa=${cookieVal(l5, 'ivy_mfa')}` });
  assert(r.statusCode === 200 && codeMails(both.email).length === nb + 1, '"Email me a code instead" sends one');
  r = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(l5, 'ivy_mfa')}`, body: { code: lastCode(both.email) } });
  assert(r.statusCode === 200, 'emailed code works for an app + email account');
  const l6 = await login(both.email);
  r = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(l6, 'ivy_mfa')}`, body: { code: generateTotp(secret) } });
  assert(r.statusCode === 200, 'app code still works');
  // Removing the app keeps email codes and the backup codes.
  r = await call(totpDisable, { cookie: sess(both.id), body: { password: PASSWORD } });
  row = (await sql`SELECT totp_enrolled_at, mfa_email_enabled_at, totp_backup_codes_hashed FROM users WHERE id = ${both.id}`).rows[0];
  assert(r.statusCode === 200 && !row.totp_enrolled_at && !!row.mfa_email_enabled_at && Array.isArray(row.totp_backup_codes_hashed), 'removing the app keeps email codes + backup codes');
  await settle();
  assert(mailTo(both.email).some((m) => /method was removed/.test(m.subject)), 'security email says a method was removed, 2-step still on');

  console.log('\n[12] turning it off needs the password; impersonation is refused');
  const admin = await mkUser('admin');
  const imp = sess(owner.id, { imp: admin.id });
  r = await call(mfaDisable, { cookie: imp, body: { password: PASSWORD } });
  assert(r.statusCode === 403, 'impersonated disable → 403');
  r = await call(emailSetup, { cookie: sess(other.id, { imp: admin.id }) });
  assert(r.statusCode === 403, 'impersonated setup → 403');
  r = await call(emailEnable, { cookie: sess(other.id, { imp: admin.id }), body: { code: '123456' } });
  assert(r.statusCode === 403, 'impersonated enable → 403');
  r = await call(mfaDisable, { cookie: sess(owner.id), body: {} });
  assert(r.statusCode === 400, 'no password → 400');
  r = await call(mfaDisable, { cookie: sess(owner.id), body: { password: 'nope-wrong-1' } });
  assert(r.statusCode === 401, 'wrong password → 401');
  row = (await sql`SELECT mfa_email_enabled_at FROM users WHERE id = ${owner.id}`).rows[0];
  assert(!!row.mfa_email_enabled_at, 'still on after refused attempts');
  r = await call(mfaDisable, { cookie: sess(owner.id), body: { password: PASSWORD } });
  row = (await sql`SELECT mfa_email_enabled_at, totp_backup_codes_hashed FROM users WHERE id = ${owner.id}`).rows[0];
  assert(r.statusCode === 200 && row.mfa_email_enabled_at == null && row.totp_backup_codes_hashed == null, 'right password → off, backup codes cleared');
  await settle();
  assert(mailTo(owner.email).some((m) => /Two-factor authentication was turned off/.test(m.subject)), 'security email: 2-step turned off');
  const audit2 = (await sql`SELECT action FROM audit_events WHERE target_user_id = ${owner.id}`).rows.map((x) => x.action);
  assert(audit2.includes('mfa_email.disabled') && audit2.includes('mfa.disable.failed'), 'audit rows for off + refused attempt');
  r = await login(owner.email);
  assert(!!cookieVal(r, 'ivy_session') && !r.body.mfaRequired, 'password-only sign-in works again');

  console.log('\n[13] client portal users and helpers get the same gate');
  const ws = await sql`INSERT INTO workspaces (owner_id) VALUES (${other.id}) RETURNING id`;
  workspaces.push(ws.rows[0].id);
  const client = await mkUser('client');
  await sql`INSERT INTO clients (workspace_id, name, email, user_id, stage) VALUES (${ws.rows[0].id}, 'Portal Client', ${client.email}, ${client.id}, 'active')`;
  const helper = await mkUser('helper');
  await sql`INSERT INTO staff_members (workspace_id, name, email, user_id, active, owner_managed) VALUES (${ws.rows[0].id}, 'Helper', ${helper.email}, ${helper.id}, TRUE, TRUE)`;
  for (const [label, u] of [['client portal user', client], ['helper', helper]]) {
    const codes = await enableEmail(u);
    assert(Array.isArray(codes) && codes.length === 10, `${label}: can turn on email codes`);
    const lx = await login(u.email);
    assert(lx.body?.mfaRequired === true && !cookieVal(lx, 'ivy_session'), `${label}: gated at sign-in`);
    const cx = await call(challengeHandler, { cookie: `ivy_mfa=${cookieVal(lx, 'ivy_mfa')}`, body: { code: lastCode(u.email) } });
    assert(cx.statusCode === 200 && cx.body.user.id === u.id, `${label}: emailed code signs in`);
  }
  const wsCount = (await sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE owner_id IN (${client.id}, ${helper.id})`).rows[0].n;
  assert(wsCount === 0, 'no workspace minted for client or helper by these endpoints');

  console.log('\n[14] dashboard nudge: after a few days, dismiss is remembered');
  const veteran = await mkUser('veteran', { createdDaysAgo: 5 });
  const vws = await sql`INSERT INTO workspaces (owner_id) VALUES (${veteran.id}) RETURNING id`;
  workspaces.push(vws.rows[0].id);
  r = await call(dashboardHandler, { method: 'GET', cookie: sess(veteran.id) });
  assert(r.statusCode === 200 && r.body.twoStepPrompt === true, `5-day-old owner without 2-step → prompt (${r.statusCode})`);
  const fresh = await mkUser('fresh');
  const fws = await sql`INSERT INTO workspaces (owner_id) VALUES (${fresh.id}) RETURNING id`;
  workspaces.push(fws.rows[0].id);
  r = await call(dashboardHandler, { method: 'GET', cookie: sess(fresh.id) });
  assert(r.body.twoStepPrompt === false, 'brand-new owner, no payments → no prompt');
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${fws.rows[0].id}, 'acct_test', 'complete')
            ON CONFLICT (workspace_id) DO UPDATE SET stripe_connect_user_id = 'acct_test', stripe_onboarding_status = 'complete'`;
  r = await call(dashboardHandler, { method: 'GET', cookie: sess(fresh.id) });
  assert(r.body.twoStepPrompt === true, 'new owner with Stripe connected → prompt');
  r = await call(twoStepPrompt, { cookie: sess(veteran.id), body: { dismiss: true } });
  assert(r.statusCode === 200, 'dismiss → 200');
  r = await call(dashboardHandler, { method: 'GET', cookie: sess(veteran.id) });
  assert(r.body.twoStepPrompt === false, 'dismissed → gone');
  await enableEmail(fresh);
  r = await call(dashboardHandler, { method: 'GET', cookie: sess(fresh.id) });
  assert(r.body.twoStepPrompt === false, '2-step on → no prompt');
}

run()
  .catch((e) => { console.error('Fatal:', e.message, e.stack); fail++; })
  .finally(async () => {
    await new Promise((r) => setTimeout(r, 1000)); // let fire-and-forget alerts finish
    globalThis.fetch = realFetch;
    for (const id of workspaces) await sql`DELETE FROM workspaces WHERE id = ${id}`.catch(() => {});
    for (const id of created) {
      await sql`DELETE FROM rate_limits WHERE key LIKE ${'%' + id + '%'}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });

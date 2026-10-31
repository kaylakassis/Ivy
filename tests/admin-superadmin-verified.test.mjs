// Super-admin hygiene.
//   [1] An allowlisted email with an UNVERIFIED account is a normal user:
//       403 from requireSuperAdmin, never promoted, isSuperAdminBySession false.
//   [2] Once verified the same account is a super-admin and gets promoted.
//   [3] isSuperAdminBySession honours deleted_at and password_changed_at
//       exactly like requireUser.
//   [4] Admin "set password" revokes the target's existing sessions.
//   [5] Impersonation tokens live one hour and cannot reach account delete,
//       2FA disable or payment-provider connection.
//   [6] The admin fallback password is CSPRNG-generated.
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-superadmin-verified.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
const S = Date.now();
const ALLOW_UNVERIFIED = `sa-unverified-${S}@example.com`;
const ALLOW_VERIFIED = `sa-verified-${S}@example.com`;
process.env.SUPER_ADMIN_EMAIL = `${ALLOW_UNVERIFIED},${ALLOW_VERIFIED}`;

import jwt from 'jsonwebtoken';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, hashPassword, requireUser } from '../api/_lib/auth.js';
import { requireSuperAdmin, ensureSuperAdminPromotion, isSuperAdminBySession } from '../api/_lib/admin.js';
import adminUserPatch from '../api/admin/users/[id].js';
import impersonate from '../api/admin/impersonate.js';
import accountDelete from '../api/account/delete.js';
import totpDisable from '../api/auth/totp/disable.js';
import stripeConnect from '../api/finance/stripe-connect.js';
import squareInit from '../api/finance/square-oauth-init.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
const base = () => ({ 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${(ipN++ % 200) + 10}`, 'user-agent': 'test' });
const sessReq = (token, { method = 'GET', body = {}, query = {} } = {}) => ({ method, url: '/t', query, body: JSON.stringify(body), headers: { ...base(), cookie: `ivy_session=${token}` } });
const adminReq = ({ method = 'GET', body = {}, query = {} } = {}) => ({ method, url: '/t', query, body: JSON.stringify(body), headers: { ...base(), 'x-admin-secret': process.env.ADMIN_SECRET } });

async function user(email, { verified = true, type = 'regular', pw = 'Pass-word-123!' } = {}) {
  const r = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type)
    VALUES (${email}, ${await hashPassword(pw)}, 'Test Person', ${verified ? new Date() : null}, ${type}) RETURNING id, email, user_type, email_verified_at`;
  return r.rows[0];
}
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] allowlisted email, unverified account: a normal user');
  const un = await user(ALLOW_UNVERIFIED, { verified: false });
  const unTok = signSession(un.id);
  let res = mockRes();
  const allowed = await requireSuperAdmin(sessReq(unTok), res);
  assert(allowed === false && res.statusCode === 403, `requireSuperAdmin → 403 (${res.statusCode})`);
  assert(res.body?.error === 'Super-admin only', 'plain 403 body');
  await ensureSuperAdminPromotion({ id: un.id, email: un.email, user_type: 'regular' });
  const unRow = (await sql`SELECT user_type FROM users WHERE id = ${un.id}`).rows[0];
  assert(unRow.user_type === 'regular', 'not promoted (user_type stays regular)');
  assert((await isSuperAdminBySession(sessReq(unTok))) === false, 'isSuperAdminBySession → false');
  const leak = warnings.filter((w) => w.includes('super-admin check failed'));
  assert(leak.length >= 1 && !leak.some((w) => w.includes(ALLOW_UNVERIFIED) || w.includes(ALLOW_VERIFIED)), 'the 403 log names neither the allowlist nor the probing email');
  assert(leak.some((w) => w.includes(un.id)), 'the 403 log carries the user id');

  console.log('\n[2] verified allowlisted account: super-admin, promoted');
  const ve = await user(ALLOW_VERIFIED, { verified: true });
  const veTok = signSession(ve.id);
  res = mockRes();
  assert((await requireSuperAdmin(sessReq(veTok), res)) === true, 'requireSuperAdmin → true');
  await ensureSuperAdminPromotion({ id: ve.id, email: ve.email, user_type: 'regular' });
  assert((await sql`SELECT user_type FROM users WHERE id = ${ve.id}`).rows[0].user_type === 'super_admin', 'promoted to super_admin');
  assert((await isSuperAdminBySession(sessReq(veTok))) === true, 'isSuperAdminBySession → true');
  await sql`UPDATE users SET email_verified_at = NULL WHERE id = ${un.id}`; // still unverified, sanity

  console.log('\n[3] isSuperAdminBySession revocation rules');
  const sa = await user(`sa-plain-${S}@example.com`, { type: 'super_admin' });
  const saTok = signSession(sa.id);
  assert((await isSuperAdminBySession(sessReq(saTok))) === true, 'DB super_admin → true');
  await sql`UPDATE users SET password_changed_at = NOW() + INTERVAL '2 minutes' WHERE id = ${sa.id}`;
  assert((await isSuperAdminBySession(sessReq(saTok))) === false, 'session older than password_changed_at → false');
  await sql`UPDATE users SET password_changed_at = NULL, deleted_at = NOW() WHERE id = ${sa.id}`;
  assert((await isSuperAdminBySession(sessReq(saTok))) === false, 'deleted account → false');
  await sql`UPDATE users SET deleted_at = NULL WHERE id = ${sa.id}`;

  console.log('\n[4] admin set-password revokes the target\'s sessions');
  const victim = await user(`sa-victim-${S}@example.com`);
  const vTok = signSession(victim.id);
  res = mockRes();
  assert(!!(await requireUser(sessReq(vTok), res)), 'session valid before the change');
  await sleep(1100); // iat is whole seconds; the stamp is NOW() - 1s
  res = mockRes();
  await adminUserPatch(adminReq({ method: 'PATCH', query: { id: victim.id }, body: { password: 'Brand-new-pass-1!' } }), res);
  assert(res.statusCode === 200, `PATCH password → 200 (${res.statusCode})`);
  const vRow = (await sql`SELECT password_changed_at FROM users WHERE id = ${victim.id}`).rows[0];
  assert(!!vRow.password_changed_at, 'password_changed_at stamped');
  res = mockRes();
  assert((await requireUser(sessReq(vTok), res)) === null && res.statusCode === 401, `old session refused (${res.statusCode})`);

  console.log('\n[5] impersonation: 1-hour token, sensitive endpoints refuse it');
  const target = await user(`sa-target-${S}@example.com`);
  res = mockRes();
  await impersonate(sessReq(veTok, { method: 'POST', body: { userId: target.id } }), res);
  assert(res.statusCode === 200, `impersonate → 200 (${res.statusCode}) ${JSON.stringify(res.body)}`);
  const cookies = [].concat(res.getHeader('set-cookie') || []);
  const impCookie = cookies.find((c) => c.startsWith('ivy_session='));
  const impTok = decodeURIComponent(impCookie.split(';')[0].slice('ivy_session='.length));
  const claims = jwt.decode(impTok);
  assert(claims.sub === target.id && claims.imp === ve.id, 'token carries sub + imp');
  assert(claims.exp - claims.iat === 3600, `token expires in 1 hour (${claims.exp - claims.iat}s)`);
  res = mockRes();
  assert(!!(await requireUser(sessReq(impTok), res)), 'impersonation session authenticates ordinary reads');
  for (const [name, h, body] of [
    ['account/delete', accountDelete, { confirmEmail: target.email }],
    ['auth/totp/disable', totpDisable, { password: 'Pass-word-123!' }],
    ['finance/stripe-connect', stripeConnect, { secretKey: 'sk_test_x' }],
  ]) {
    res = mockRes();
    // eslint-disable-next-line no-await-in-loop
    await h(sessReq(impTok, { method: 'POST', body }), res);
    assert(res.statusCode === 403 && res.body?.error === 'Not available while impersonating', `${name} → 403 while impersonating (${res.statusCode})`);
  }
  res = mockRes();
  await squareInit({ ...sessReq(impTok), method: 'GET', headers: { ...base(), cookie: `ivy_session=${impTok}`, accept: 'application/json' } }, res);
  assert(res.statusCode === 403, `finance/square-oauth-init → 403 while impersonating (${res.statusCode})`);
  const still = (await sql`SELECT deleted_at FROM users WHERE id = ${target.id}`).rows[0];
  assert(!still.deleted_at, 'target account was not deleted');
  res = mockRes();
  await accountDelete(sessReq(signSession(target.id), { method: 'POST', body: { confirmEmail: 'wrong@example.com' } }), res);
  assert(res.statusCode === 400, `the owner's own session still reaches the handler (${res.statusCode})`);

  console.log('\n[6] admin createUser fallback password is CSPRNG');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/admin/users.js', import.meta.url), 'utf8'));
  assert(/randomBytes\(16\)\.toString\('base64url'\)/.test(src) && !/Math\.random\(\)\.toString\(36\)/.test(src), 'randomBytes-based fallback, Math.random gone');

  console.warn = origWarn;
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.warn = origWarn; console.error('crashed:', e); process.exit(1); });

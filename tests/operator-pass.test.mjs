// The Admin screen's code is only handed to a signed-in operator.
//   [1] the pass: who gets one
//   [2] the gate in front of /assets/op/*
//   [3] the build puts the Admin screen there, and the iPhone app leaves it out
//
// Run: node --import ./tests/bootstrap.mjs ./tests/operator-pass.test.mjs
import { readFileSync } from 'node:fs';
process.env.SUPER_ADMIN_EMAIL = `op-admin-${Date.now()}@example.com`;

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { operatorPassValue, OP_COOKIE, OP_PATH, OP_TTL_SECONDS } from '../api/_lib/operatorPass.js';
import passHandler from '../api/auth/operator-pass.js';
import logoutHandler from '../api/auth/logout.js';
import middleware, { hasOperatorPass, config } from '../middleware.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'www.joinivy.ai';
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(handler, { method = 'GET', userId } = {}) {
  const req = { method, url: '/api/auth/operator-pass', query: {}, headers: { host: HOST, origin: `https://${HOST}`, ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}) } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}
const asset = (cookie) => new Request(`https://${HOST}/assets/op/AdminPage-abc123.js`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res) => [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(`${OP_COOKIE}=`)) || '';

async function main() {
  await ensureSchemaApplied();
  const mk = async (email, type = 'regular') => {
    const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type) VALUES (${email}, 'x', 'Op Test', NOW(), ${type}) RETURNING id`).rows[0];
    users.push(u.id); return u;
  };
  const admin = await mk(process.env.SUPER_ADMIN_EMAIL);
  const typed = await mk(`op-typed-${S}@example.com`, 'super_admin');
  const owner = await mk(`op-owner-${S}@example.com`);

  console.log('\n[1] who gets a pass');
  let r = await call(passHandler, { userId: admin.id });
  const set = cookieOf(r);
  assert(r.statusCode === 204 && set, 'the operator (by sign-in email) gets one');
  assert(/HttpOnly/i.test(set) && /Secure/i.test(set) && /SameSite=Lax/i.test(set) && new RegExp(`Path=${OP_PATH}`).test(set) && new RegExp(`Max-Age=${OP_TTL_SECONDS}`).test(set),
    'it is not readable by page scripts, only travels over a secure connection, only to the Admin files, and expires in hours');
  r = await call(passHandler, { userId: typed.id });
  assert(r.statusCode === 204 && cookieOf(r), 'an operator by account type gets one too');
  r = await call(passHandler, { userId: owner.id });
  assert(r.statusCode === 404 && !cookieOf(r), 'a normal business account gets "not found" and no cookie');
  r = await call(passHandler, {});
  assert(r.statusCode === 401 && !cookieOf(r), 'a signed-out visitor gets nothing');
  r = await call(passHandler, { method: 'POST', userId: admin.id });
  assert(r.statusCode === 405, 'only a read is accepted');
  r = await call(logoutHandler, { method: 'POST', userId: admin.id });
  assert(/Max-Age=0/.test(cookieOf(r)), 'signing out throws the pass away');

  console.log('\n[2] the gate');
  assert(config.matcher.includes('/assets/op/:path*'), 'the gate stands in front of the Admin files');
  const good = `${OP_COOKIE}=${encodeURIComponent(operatorPassValue(admin.id))}`;
  let res = await middleware(asset(good));
  assert(res.headers.get('x-middleware-next') === '1' && res.headers.get('cache-control') === 'private, no-store', 'a valid pass is let through, and the file is never kept by a shared cache');
  assert(await hasOperatorPass(asset(good)) === true, 'and reads as valid');
  res = await middleware(asset(''));
  assert(res.status === 404 && (await res.text()) === 'Not found' && /no-store/.test(res.headers.get('cache-control')), 'no pass: "not found", never cached');
  res = await middleware(asset(`ivy_session=${signSession(owner.id)}`));
  assert(res.status === 404, 'being signed in is not enough');
  const [uid, exp, sig] = operatorPassValue(admin.id).split('.');
  const forged = [
    ['another account id', `${owner.id}.${exp}.${sig}`],
    ['a later expiry', `${uid}.${Number(exp) + 86400000}.${sig}`],
    ['a changed signature', `${uid}.${exp}.${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`],
    ['no signature', `${uid}.${exp}.`],
    ['junk', 'true'],
  ];
  for (const [what, value] of forged) {
    assert(await hasOperatorPass(asset(`${OP_COOKIE}=${encodeURIComponent(value)}`)) === false, `a pass with ${what} is refused`);
  }
  const old = operatorPassValue(admin.id, Date.now() - (OP_TTL_SECONDS + 60) * 1000);
  assert(await hasOperatorPass(asset(`${OP_COOKIE}=${encodeURIComponent(old)}`)) === false, 'an expired pass is refused');
  const keep = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-different-secret-entirely';
  const otherSecret = await hasOperatorPass(asset(good));
  delete process.env.JWT_SECRET;
  const noSecret = await hasOperatorPass(asset(good));
  process.env.JWT_SECRET = keep;
  assert(otherSecret === false && noSecret === false && operatorPassValue(admin.id) && true, 'a pass signed with any other secret is refused; with no secret set, nobody gets in');
  res = await middleware(new Request(`https://${HOST}/api/auth/me`));
  assert(res.headers.get('x-middleware-next') === '1', 'ordinary requests are untouched');

  console.log('\n[3] the build');
  const vite = read('vite.config.js'); const app = read('src/App.jsx');
  assert(/chunk\.moduleIds\.some\(\(id\) => \/\[\\\\\/\]src\[\\\\\/\]features\[\\\\\/\]admin\[\\\\\/\]\/\.test\(id\)\)\s*\? 'assets\/op\/\[name\]-\[hash\]\.js'/.test(vite), 'any file carrying part of the Admin screen is written under /assets/op/');
  assert(!/return 'op-admin'/.test(vite), 'without bundling shared code in with it (which would make every page need the protected file)');
  assert(/__IVY_NATIVE_BUILD__: JSON\.stringify\(NATIVE_BUILD\)/.test(vite) && /VITE_API_BASE_URL/.test(vite), 'the build knows when it is the iPhone app');
  assert(/__IVY_NATIVE_BUILD__\s*\? import\('\.\/features\/more\/AdminOnWeb\.jsx'\)\s*: api\.get\('\/auth\/operator-pass'\)\.then\(\s*\(\) => import\('\.\/features\/admin\/AdminPage\.jsx'\)/.test(app),
    'the website asks for the pass before loading Admin; the iPhone app loads a link to the website instead');
  assert((app.match(/features\/admin\//g) || []).length === 1, 'nothing else in the app loads the Admin screen');
  const stub = read('src/features/more/AdminOnWeb.jsx');
  assert(/https:\/\/www\.joinivy\.ai\/admin/.test(stub) && /isSuperAdmin/.test(stub) && !/api\.(get|post)\(/.test(stub), 'the app\'s Admin page is a link for the operator and nothing else');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

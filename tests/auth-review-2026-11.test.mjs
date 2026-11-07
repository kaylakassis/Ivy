// Auth / tenant-isolation review regressions.
//
//   [1] An authenticator app can only be turned on for an account whose
//       email is confirmed (same rule as email codes). Otherwise anyone
//       could sign up with someone else's address, add their own app, and
//       lock the real owner out even after a password reset.
//   [3] A backup code is single-use even when two sign-ins race.
//   [2] The Discover business card (/api/businesses/:slug) carries the
//       signed-in caller's own review eligibility and client id, so it must
//       never be stored in the shared CDN cache and handed to other people.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/auth-review-2026-11.test.mjs
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { hashPassword, signSession, signMfaToken } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { generateSecret, base32Encode, hashBackupCode } from '../api/_lib/totp.js';
import challengeHandler from '../api/auth/totp/challenge.js';
import enrollHandler from '../api/auth/totp/enroll.js';
import verifyHandler from '../api/auth/totp/verify.js';
import businessHandler from '../api/businesses/[slug]/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

let ipC = 0;
function makeReq({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  ipC++;
  return {
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `203.0.113.${10 + (ipC % 200)}`,
      ...headers,
    },
  };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}

const users = [];
async function mkUser(tag, { verified }) {
  const { rows: [u] } = await sql`
    INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`authrev-${tag}-${S}@example.com`}, ${await hashPassword('correct horse battery')}, ${tag},
            ${verified ? new Date().toISOString() : null}, '2026-05-05', NOW())
    RETURNING id, email`;
  users.push(u.id);
  return u;
}

// Minimal emulation of Vercel's `source` matching for the patterns used in
// vercel.json: path-to-regexp named params (:x) and raw regex groups.
function sourceMatches(source, pathname) {
  const re = '^' + source.replace(/:([a-zA-Z]+)/g, '[^/]+') + '$';
  return new RegExp(re).test(pathname);
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] authenticator app needs a confirmed email');
  const unverified = await mkUser('unverified', { verified: false });
  const cookieU = `ivy_session=${signSession(unverified.id)}`;
  let r = makeRes();
  await enrollHandler(makeReq({ headers: { cookie: cookieU } }), r);
  assert(r.statusCode === 400, `enroll refused for an unconfirmed email (${r.statusCode})`);
  assert(/confirm your email/i.test(r.body?.error || ''), 'tells them to confirm their email first');
  assert(!r.body?.secret, 'no secret handed out');
  // Even with a secret somehow on file, verify must not switch it on.
  await sql`UPDATE users SET totp_secret_encrypted = 'x' WHERE id = ${unverified.id}`;
  r = makeRes();
  await verifyHandler(makeReq({ headers: { cookie: cookieU }, body: { code: '123456' } }), r);
  assert(r.statusCode === 400 && /confirm your email/i.test(r.body?.error || ''), `verify refused for an unconfirmed email (${r.statusCode})`);
  const after = (await sql`SELECT totp_enrolled_at FROM users WHERE id = ${unverified.id}`).rows[0];
  assert(after.totp_enrolled_at == null, '2-step stays off');

  const verified = await mkUser('verified', { verified: true });
  r = makeRes();
  await enrollHandler(makeReq({ headers: { cookie: `ivy_session=${signSession(verified.id)}` } }), r);
  assert(r.statusCode === 200 && !!r.body?.secret, 'confirmed email can still set up an app');

  console.log('\n[2] Discover business card is never shared through the CDN');
  const owner = await mkUser('owner', { verified: true });
  const { rows: [ws] } = await sql`INSERT INTO workspaces (owner_id) VALUES (${owner.id}) RETURNING id`;
  const slug = `authrev-${S}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, discoverable) VALUES (${ws.id}, 'Auth Review Spa', ${slug}, TRUE)`;
  const client = await mkUser('client', { verified: true });
  await sql`INSERT INTO clients (workspace_id, name, email, user_id) VALUES (${ws.id}, 'Cara', ${client.email}, ${client.id})`;

  r = makeRes();
  await businessHandler(makeReq({ method: 'GET', query: { slug }, headers: { cookie: `ivy_session=${signSession(client.id)}` } }), r);
  assert(r.statusCode === 200 && r.body?.eligibility?.clientId, 'signed-in client gets their own eligibility + client id');
  const cc = String(r.headers['cache-control'] || '');
  assert(/no-store/.test(cc) && /private/.test(cc), `personal answer is marked private, no-store (got "${cc}")`);

  r = makeRes();
  await businessHandler(makeReq({ method: 'GET', query: { slug } }), r);
  assert(r.statusCode === 200 && r.body?.eligibility === null, 'anonymous caller gets no eligibility');
  assert(/no-store/.test(String(r.headers['cache-control'] || '')), 'anonymous answer is not cached either (same URL)');

  const vercel = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vercel.json'), 'utf8'));
  const publicRules = (vercel.headers || []).filter((h) => (h.headers || []).some((x) => x.key.toLowerCase() === 'cache-control' && /public|s-maxage/i.test(x.value)));
  const hitsDetail = publicRules.filter((h) => sourceMatches(h.source, `/api/businesses/${slug}`));
  assert(hitsDetail.length === 0, `no vercel.json rule makes /api/businesses/:slug publicly cacheable (${hitsDetail.map((h) => h.source).join(', ')})`);
  const hitsReviews = publicRules.filter((h) => sourceMatches(h.source, `/api/businesses/${slug}/reviews`));
  assert(hitsReviews.length > 0, 'the public reviews list stays CDN-cacheable');

  console.log('\n[3] a backup code signs in once, even when sent twice at the same moment');
  const bu = await mkUser('backup', { verified: true });
  const backupPlain = 'WXYZ-2345';
  await sql`
    UPDATE users SET totp_secret_encrypted = ${encrypt(base32Encode(generateSecret()))}, totp_enrolled_at = NOW(),
           totp_backup_codes_hashed = ${JSON.stringify([
             { hash: hashBackupCode('AAAA-BBBB'), used_at: null },
             { hash: hashBackupCode(backupPlain), used_at: null },
           ])}::jsonb
     WHERE id = ${bu.id}`;
  const tries = await Promise.all([0, 1, 2].map(async () => {
    const out = makeRes();
    await challengeHandler(makeReq({ body: { code: backupPlain }, headers: { cookie: `ivy_mfa=${signMfaToken(bu.id)}` } }), out);
    return out.statusCode;
  }));
  assert(tries.filter((c) => c === 200).length === 1, `exactly one of three simultaneous uses signs in (${tries.join(', ')})`);
  const codes = (await sql`SELECT totp_backup_codes_hashed AS b FROM users WHERE id = ${bu.id}`).rows[0].b;
  assert(codes[1].used_at && !codes[0].used_at, 'only that code is marked used; the other stays usable');
  const again = makeRes();
  await challengeHandler(makeReq({ body: { code: backupPlain }, headers: { cookie: `ivy_mfa=${signMfaToken(bu.id)}` } }), again);
  assert(again.statusCode === 401, 'a used backup code is refused afterwards');
  const other = makeRes();
  await challengeHandler(makeReq({ body: { code: 'AAAA-BBBB' }, headers: { cookie: `ivy_mfa=${signMfaToken(bu.id)}` } }), other);
  assert(other.statusCode === 200, 'the remaining backup code still works');

  // Cleanup (cascades from users/workspaces).
  await sql`DELETE FROM calendar_settings WHERE workspace_id = ${ws.id}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${ws.id}`;
  await sql`DELETE FROM workspaces WHERE id = ${ws.id}`;
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

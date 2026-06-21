// Soft-delete → one-click recovery round-trip.
//
// Confirms the deletion email's "Keep my account" CTA actually works:
//   • delete.js mints a KIND_RECOVER token and mangles the email.
//   • restore.js consumes the token, clears deleted_at, demangles the email,
//     issues a session cookie, and burns the token.
//   • Second use of the same token (duplicate click / scanner prefetch) is
//     handled gracefully (200 alreadyRestored, never resurrects a row).
//   • Garbage / unknown tokens 401.
//   • If another account claimed the original email in the meantime, the
//     restore still succeeds with the mangled email preserved.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/account-restore.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import deleteHandler  from '../api/account/delete.js';
import restoreHandler from '../api/account/restore.js';
import { createToken, KIND_RECOVER } from '../api/_lib/tokens.js';
import { signSession } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
  };
}

let ipN = 0;
function req({ body = {}, headers = {} } = {}) {
  ipN++;
  return {
    method: 'POST', url: '/test', query: {}, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${(ipN % 200) + 10}`, ...headers },
  };
}

async function newOwner(email) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${email}, 'x', 'Owner', NOW()) RETURNING id`;
  const id = u.rows[0].id;
  await sql`INSERT INTO workspaces (owner_id, name) VALUES (${id}, 'WS')`;
  return id;
}

async function softDelete(userId, email) {
  // Drive the real handler so we exercise its token-mint path too.
  const cookie = `ivy_session=${signSession(userId)}`;
  const r = mockRes();
  await deleteHandler(req({ body: { confirmEmail: email }, headers: { cookie } }), r);
  return r;
}

async function getRow(userId) {
  const r = await sql`SELECT id, email, deleted_at FROM users WHERE id = ${userId}`;
  return r.rows[0];
}

async function run() {
  try {
    await ensureSchemaApplied();
    await sql.query(`DELETE FROM users WHERE email LIKE 'restore-test-%@example.com' OR email LIKE 'restore-test-%+deleted%'`);

    console.log('\n[1] delete.js soft-deletes AND mints a recovery token');
    const email1 = `restore-test-${Date.now()}-a@example.com`;
    const userId1 = await newOwner(email1);
    const delRes = await softDelete(userId1, email1);
    assert(delRes.statusCode === 200 && delRes.body?.deleted === true, 'delete handler returns ok');
    const after = await getRow(userId1);
    assert(after && after.deleted_at !== null, 'deleted_at stamped');
    assert(after.email !== email1 && after.email.includes('+deleted-'), 'email is mangled');
    const tok = await sql`SELECT id, used_at, expires_at FROM auth_tokens WHERE user_id = ${userId1} AND kind = ${KIND_RECOVER}`;
    assert(tok.rows.length === 1, 'one KIND_RECOVER token created');
    assert(tok.rows[0].used_at === null, 'token not used yet');
    const ttlDays = (new Date(tok.rows[0].expires_at).getTime() - Date.now()) / 86400000;
    assert(ttlDays > 29 && ttlDays <= 30, `token expires ~30 days out (${ttlDays.toFixed(1)})`);

    console.log('\n[2] restore.js with garbage token → 401');
    let r = mockRes();
    await restoreHandler(req({ body: { token: 'not-a-real-token-1234567890' } }), r);
    assert(r.statusCode === 401, '401 on unknown token');

    console.log('\n[3] restore.js with a fresh token: undeletes + demangles + signs in');
    const rawTok = await createToken({ userId: userId1, kind: KIND_RECOVER, ttlMinutes: 30 * 24 * 60 });
    r = mockRes();
    await restoreHandler(req({ body: { token: rawTok } }), r);
    assert(r.statusCode === 200, 'restore returns 200');
    assert(r.body?.restored === true, 'body.restored = true');
    assert(r.body?.user?.email === email1, 'email is demangled to the original');
    const cookie = (r.getHeader('set-cookie') || [])[0] || '';
    assert(/^ivy_session=/.test(cookie), 'session cookie is set (user is signed in)');
    const after2 = await getRow(userId1);
    assert(after2.deleted_at === null, 'deleted_at cleared');
    assert(after2.email === email1, 'email restored in the DB');

    console.log('\n[4] duplicate click on the same token → 200 alreadyRestored');
    r = mockRes();
    await restoreHandler(req({ body: { token: rawTok } }), r);
    assert(r.statusCode === 200, 'second click returns 200 (not 401)');
    assert(r.body?.alreadyRestored === true, 'flagged alreadyRestored');

    console.log('\n[5] if the original email is claimed by another account, restore keeps the mangled form');
    const email2 = `restore-test-${Date.now()}-b@example.com`;
    const userId2 = await newOwner(email2);
    await softDelete(userId2, email2);
    // Someone else grabs the address during the window.
    await sql`INSERT INTO users (email, password_hash, name) VALUES (${email2}, 'x', 'Squatter')`;
    const rawTok2 = await createToken({ userId: userId2, kind: KIND_RECOVER, ttlMinutes: 30 * 24 * 60 });
    r = mockRes();
    await restoreHandler(req({ body: { token: rawTok2 } }), r);
    assert(r.statusCode === 200, 'restore still succeeds');
    const after3 = await getRow(userId2);
    assert(after3.deleted_at === null, 'deleted_at cleared');
    assert(after3.email !== email2, 'mangled email kept (original taken)');
    assert(after3.email.includes('+deleted-'), 'still in mangled form');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await sql.query(`DELETE FROM users WHERE email LIKE 'restore-test-%@example.com' OR email LIKE 'restore-test-%+deleted%@example.com'`).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

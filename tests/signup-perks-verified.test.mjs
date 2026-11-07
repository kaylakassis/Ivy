// Comp invites and the waitlist discount are granted only once the email
// is confirmed (api/_lib/signupPerks.js), never at sign-up.
//
//   [1] someone signs up with an invitee's address: no comp, no discount,
//       invite stays unclaimed; /api/me tells ONLY that signed-in owner an
//       invite is waiting (pendingCompInvite), nobody else
//   [2] confirming the email grants both, once; a repeat click and a
//       second concurrent claim change nothing
//   [3] admin invites an EXISTING but unconfirmed account: not comped now,
//       claimed on confirmation; a confirmed account is comped at once
//   [4] admin-created accounts are verified on creation and get the perk
//
// Run: node --import ./tests/bootstrap.mjs ./tests/signup-perks-verified.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { createToken, KIND_VERIFY } from '../api/_lib/tokens.js';
import { claimSignupPerks } from '../api/_lib/signupPerks.js';
import { setLaunchMode, getLaunchMode } from '../api/_lib/earlyAccess.js';
import signupHandler from '../api/auth/signup.js';
import verifyEmailHandler from '../api/auth/verify-email.js';
import meHandler from '../api/me/index.js';
import compHandler from '../api/admin/comp-invites.js';
import adminUsersHandler from '../api/admin/users.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const realFetch = globalThis.fetch;
const mails = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    try { mails.push(JSON.parse(opts.body)); } catch { /* ignore */ }
    return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
  }
  return realFetch(url, opts);
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `203.0.113.${(ipN % 200) + 20}`, ...(cookie ? { cookie } : {}) } };
}
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const em = (t) => `perk-${t}-${STAMP}@example.com`;
const cleanupUsers = [];

async function signup(email) {
  const r = mockRes();
  await signupHandler(req({ method: 'POST', body: {
    email, name: 'Perk Person', password: 'sufficiently-long-pass-123',
    acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
  } }), r);
  const id = r.body?.user?.id;
  if (id) cleanupUsers.push(id);
  return { status: r.statusCode, id };
}
async function verify(userId) {
  const tok = await createToken({ userId, kind: KIND_VERIFY, ttlMinutes: 60 });
  const r = mockRes();
  await verifyEmailHandler(req({ method: 'POST', body: { token: tok } }), r);
  return { r, tok };
}
async function me(userId) {
  const r = mockRes();
  await meHandler(req({ cookie: `ivy_session=${signSession(userId)}` }), r);
  return r.body || {};
}
const wsOf = async (userId) => (await sql`SELECT id, comp_until, waitlist_discount_at FROM workspaces WHERE owner_id = ${userId}`).rows[0];
const invite = async (email) => (await sql`SELECT claimed_at, claimed_workspace_id FROM comp_invites WHERE LOWER(email) = ${email}`).rows[0];

let priorMode = 'open';
async function run() {
  try {
    await ensureSchemaApplied();
    priorMode = await getLaunchMode();
    if (priorMode !== 'open') await setLaunchMode('open');
    const a = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type)
      VALUES (${em('admin')}, 'x', 'Admin', NOW(), 'super_admin') RETURNING id`;
    cleanupUsers.push(a.rows[0].id);
    const adminCookie = `ivy_session=${signSession(a.rows[0].id)}`;

    console.log('\n[1] sign-up with an invited + waitlisted address grants nothing yet');
    const invitee = em('invitee');
    await sql`INSERT INTO comp_invites (email, note, comp_months) VALUES (${invitee}, 'perk test', 3)`;
    await sql`INSERT INTO waitlist_signups (email, name, source) VALUES (${invitee}, 'Perk Person', 'test')`;
    const s1 = await signup(invitee);
    assert(s1.status === 201 && s1.id, `sign-up succeeds (got ${s1.status})`);
    let ws = await wsOf(s1.id);
    assert(ws && !ws.comp_until, 'no comp access before the email is confirmed');
    assert(ws && !ws.waitlist_discount_at, 'no waitlist discount before the email is confirmed');
    assert((await invite(invitee)).claimed_at === null, 'invite stays unclaimed');
    const wl0 = (await sql`SELECT status, converted_user_id FROM waitlist_signups WHERE LOWER(email) = ${invitee}`).rows[0];
    assert(!wl0.converted_user_id, 'waitlist row not converted yet');
    let ctx = await me(s1.id);
    assert(ctx.pendingCompInvite === true, 'the signed-in owner of that address sees the "confirm to unlock" note');
    assert(ctx.subscription?.isActive === false, 'still behind the wall until confirmed');

    // Someone else, signed in, with no invite: nothing revealed.
    const other = await signup(em('other'));
    ctx = await me(other.id);
    assert(ctx.pendingCompInvite === false, 'an owner with no invite gets pendingCompInvite=false');
    // The sign-up response itself reveals nothing about invites.
    assert(!('pendingCompInvite' in (await (async () => { const r = mockRes(); await signupHandler(req({ method: 'POST', body: { email: em('probe'), name: 'P', password: 'sufficiently-long-pass-123', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION } }), r); if (r.body?.user?.id) cleanupUsers.push(r.body.user.id); return r.body || {}; })())), 'sign-up response carries no invite signal');

    console.log('\n[2] confirming the email grants both, exactly once');
    const { r: v1, tok } = await verify(s1.id);
    assert(v1.statusCode === 200, `verify 200 (got ${v1.statusCode})`);
    ws = await wsOf(s1.id);
    const until1 = ws.comp_until && new Date(ws.comp_until).getTime();
    assert(until1 > Date.now() + 80 * 864e5 && until1 < Date.now() + 100 * 864e5, '3-month comp applied on confirmation');
    assert(!!ws.waitlist_discount_at, 'waitlist discount stamped on confirmation');
    const inv1 = await invite(invitee);
    assert(inv1.claimed_at && inv1.claimed_workspace_id === ws.id, 'invite claimed by this workspace');
    const wl1 = (await sql`SELECT status, converted_user_id FROM waitlist_signups WHERE LOWER(email) = ${invitee}`).rows[0];
    assert(wl1.status === 'converted' && wl1.converted_user_id === s1.id, 'waitlist row converted to this user');
    ctx = await me(s1.id);
    assert(ctx.pendingCompInvite === false && ctx.subscription?.isActive === true, 'after confirming: no note, wall gone');
    // Repeat click (token already used) and a direct second claim: no change.
    const discount1 = new Date(ws.waitlist_discount_at).getTime();
    let r = mockRes();
    await verifyEmailHandler(req({ method: 'POST', body: { token: tok } }), r);
    assert(r.statusCode === 200 && r.body?.alreadyVerified === true, 'second click is a friendly no-op');
    const again = await claimSignupPerks(s1.id);
    assert(again.comp === false && again.waitlist === false, 'a second claim grants nothing new');
    ws = await wsOf(s1.id);
    assert(new Date(ws.comp_until).getTime() === until1, 'comp end date unchanged by repeats');
    assert(new Date(ws.waitlist_discount_at).getTime() === discount1, 'discount stamp keeps its first date');

    console.log('\n[2b] two concurrent claims: the invite is applied once');
    const race = em('race');
    const sr = await signup(race);
    await sql`INSERT INTO comp_invites (email, note, comp_months) VALUES (${race}, 'race', NULL)`;
    await sql`UPDATE users SET email_verified_at = NOW() WHERE id = ${sr.id}`;
    const results = await Promise.all([claimSignupPerks(sr.id), claimSignupPerks(sr.id), claimSignupPerks(sr.id)]);
    assert(results.filter((x) => x.comp).length === 1, 'exactly one concurrent claim wins');
    assert(!!(await wsOf(sr.id)).comp_until, 'and the workspace is comped');

    console.log('\n[2c] an unverified account cannot claim directly');
    const unv = em('unverified');
    const su = await signup(unv);
    await sql`INSERT INTO comp_invites (email, note, comp_months) VALUES (${unv}, 'x', 1)`;
    const res0 = await claimSignupPerks(su.id);
    assert(res0.comp === false && !(await wsOf(su.id)).comp_until, 'claimSignupPerks refuses an unconfirmed address');

    console.log('\n[3] admin invites an existing account');
    const lateU = em('late-unverified');
    const sl = await signup(lateU);
    r = mockRes();
    await compHandler(req({ method: 'POST', cookie: adminCookie, body: { email: lateU, months: 2 } }), r);
    assert(r.statusCode === 201 && r.body.compedNow === false && r.body.awaitingEmailConfirmation === true,
      `unconfirmed existing account is not comped now (got ${JSON.stringify(r.body)})`);
    assert(!(await wsOf(sl.id)).comp_until, 'no comp yet');
    const inviteMail = mails.filter((m) => [].concat(m.to).includes(lateU)).pop();
    assert(inviteMail && /Confirm your email address/.test(inviteMail.html) && !/[\u2013\u2014]/.test(inviteMail.html),
      'invite email asks them to confirm their email (no dashes)');
    await verify(sl.id);
    assert(!!(await wsOf(sl.id)).comp_until, 'comped as soon as the email is confirmed');

    const lateV = em('late-verified');
    const sv = await signup(lateV);
    await sql`UPDATE users SET email_verified_at = NOW() WHERE id = ${sv.id}`;
    r = mockRes();
    await compHandler(req({ method: 'POST', cookie: adminCookie, body: { email: lateV } }), r);
    assert(r.statusCode === 201 && r.body.compedNow === true && r.body.awaitingEmailConfirmation === false, 'confirmed existing account comped at once');
    assert(!!(await wsOf(sv.id)).comp_until, 'workspace comped');

    console.log('\n[4] admin-created account (verified on creation) gets its invite');
    const made = em('admin-made');
    await sql`INSERT INTO comp_invites (email, note, comp_months) VALUES (${made}, 'made', NULL)`;
    r = mockRes();
    await adminUsersHandler(req({ method: 'POST', cookie: adminCookie, body: { email: made, name: 'Made', userType: 'business-trial', sendInvite: false } }), r);
    assert(r.statusCode === 201, `admin create 201 (got ${r.statusCode})`);
    const madeId = r.body?.user?.id;
    cleanupUsers.push(madeId);
    assert(!!(await wsOf(madeId))?.comp_until, 'comp applied to the admin-created account');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    if (priorMode !== 'open') await setLaunchMode(priorMode).catch(() => {});
    await sql`DELETE FROM comp_invites WHERE email LIKE ${`perk-%-${STAMP}@example.com`}`.catch(() => {});
    await sql`DELETE FROM waitlist_signups WHERE email LIKE ${`perk-%-${STAMP}@example.com`}`.catch(() => {});
    for (const id of cleanupUsers.filter(Boolean)) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

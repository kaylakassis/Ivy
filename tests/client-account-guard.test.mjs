// A client account must never be turned into a business account by
// accident, and someone who created a business by mistake can switch back.
//
// The bug this guards: a client whose email was not confirmed yet (or whose
// business had not added them) reported isClient=false, so the app opened
// the business screens, and the first owner request created a business for
// them. From then on they saw business onboarding and the paywall.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-account-guard.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, ensureWorkspace } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import signupHandler from '../api/auth/signup.js';
import meHandler from '../api/me/index.js';
import dashboardHandler from '../api/dashboard.js';
import clientsHandler from '../api/clients/index.js';
import startBusiness from '../api/helper/start-business.js';
import clientBookings from '../api/me/bookings.js';
import clientPackages from '../api/me/packages.js';
import clientProfile from '../api/me/profile.js';
import becomeClient from '../api/account/become-client.js';
import adminWorkspaces from '../api/admin/users/[id]/workspaces.js';
import { clientSwitchCheck } from '../api/_lib/accountKind.js';
import { evictWorkspaceGateCache } from '../api/_lib/workspaceGate.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const made = [];
let ipN = 0;

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; },
  };
}
async function call(handler, { method = 'GET', body, userId, query = {}, native = false } = {}) {
  const headers = {
    'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
    'x-forwarded-for': `203.0.113.${20 + (++ipN % 200)}`,
  };
  if (userId) headers.cookie = `ivy_session=${signSession(userId)}`;
  if (native) headers['x-client-platform'] = 'ios';
  const req = { method, url: '/test', query, body, headers };
  const res = makeRes(); res.req = req;
  await handler(req, res);
  return res;
}
const signup = (email, extra = {}) => call(signupHandler, {
  method: 'POST',
  body: { email, name: 'Casey Test', password: 'sufficiently-long-pass-123', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION, ...extra },
});
const userByEmail = async (email) => (await sql`SELECT id, signup_role, user_type FROM users WHERE LOWER(email) = ${email.toLowerCase()}`).rows[0];
const workspacesOf = async (id) => (await sql`SELECT id, subscription_status FROM workspaces WHERE owner_id = ${id}`).rows;
// What every shipped app build does with /api/me (src/lib/landing.js).
const landing = (r) => (r?.isOwner && !r.onboardedAt ? 'onboarding' : r?.isOwner ? 'business' : r?.isClient ? 'client' : (r?.isHelper || r?.helps?.length) ? 'helper' : 'business');

async function main() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits`;

  console.log('\n[1] sign-up remembers what the account is');
  const clientEmail = `cag-client-${S}@example.com`;
  let r = await signup(clientEmail, { mode: 'client' });
  assert(r.statusCode === 201, `client sign-up accepted (got ${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
  const client = await userByEmail(clientEmail); made.push(client.id);
  assert(client.signup_role === 'client', 'a client sign-up is stored as a client account');
  assert((await workspacesOf(client.id)).length === 0, 'and has no business');
  const ownerEmail = `cag-owner-${S}@example.com`;
  r = await signup(ownerEmail);
  const owner = await userByEmail(ownerEmail); made.push(owner.id);
  assert(r.statusCode === 201 && owner.signup_role === 'owner' && (await workspacesOf(owner.id)).length === 1, 'a business sign-up is stored as a business account, with its business');

  console.log('\n[1b] a business account meets the paywall; a client account never does');
  let ownerMe = await call(meHandler, { userId: owner.id });
  assert(ownerMe.body.isOwner === true && ownerMe.body.subscription && ownerMe.body.subscription.isActive === false,
    `a new business has no plan yet, so the app shows the paywall (status ${ownerMe.body.subscription?.status})`);
  // During set-up the server lets the new business save its details; the
  // moment set-up is finished it locks until a plan starts.
  await sql`UPDATE workspaces SET onboarded_at = NOW() WHERE owner_id = ${owner.id}`;
  evictWorkspaceGateCache((await workspacesOf(owner.id))[0].id);
  let gated = await call(clientsHandler, { userId: owner.id });
  assert(gated.statusCode === 402 && gated.body?.error === 'subscription-required', `once set-up is finished the business screens are locked on the server until a plan starts (got ${gated.statusCode} ${gated.body?.error})`);
  await sql`UPDATE workspaces SET onboarded_at = NULL WHERE owner_id = ${owner.id}`;
  evictWorkspaceGateCache((await workspacesOf(owner.id))[0].id);
  let clientMe = await call(meHandler, { userId: client.id });
  assert(clientMe.statusCode === 200 && !clientMe.body.subscription, 'a client account has no plan to buy: nothing for a paywall to show');
  for (const [name, handler] of [['bookings', clientBookings], ['packages', clientPackages], ['profile', clientProfile]]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(handler, { userId: client.id });
    assert(res.statusCode === 200, `client ${name}: open, no payment asked (got ${res.statusCode})`);
  }

  console.log('\n[2] a client account nobody has linked yet (email not confirmed, no business has added them)');
  let me = await call(meHandler, { userId: client.id });
  assert(me.statusCode === 200 && me.body.isOwner === false && me.body.isClient === true && me.body.clientAccount === true, 'reports as a client');
  assert(Array.isArray(me.body.memberships) && me.body.memberships.length === 0 && me.body.summary, 'with no businesses yet and an empty summary (no crash)');
  assert(landing(me.body) === 'client', 'every app build, old or new, opens the client portal for it');

  console.log('\n[3] it cannot be turned into a business by touching the business screens');
  for (const [name, handler] of [['dashboard', dashboardHandler], ['clients list', clientsHandler]]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(handler, { userId: client.id });
    assert(res.statusCode === 403 && res.body?.error === 'client-only', `${name}: refused as a client account (got ${res.statusCode} ${res.body?.error})`);
  }
  let threw = null; try { await ensureWorkspace(client.id); } catch (e) { threw = e; }
  assert(threw?.code === 'client-only', 'the "make sure there is a business" helper refuses too');
  assert((await workspacesOf(client.id)).length === 0, 'still no business');
  me = await call(meHandler, { userId: client.id });
  assert(landing(me.body) === 'client', 'and it still opens the client portal');

  console.log('\n[4] an account from before this rule that owns nothing is treated the same way');
  const legacy = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`cag-legacy-${S}@example.com`}, 'x', 'Lee Legacy', ${CURRENT_TERMS_VERSION}, NOW()) RETURNING id`).rows[0];
  made.push(legacy.id);
  // The one-time backfill from api/_lib/schema.js.
  await sql`UPDATE users u SET signup_role = 'client'
             WHERE u.signup_role IS NULL AND COALESCE(u.user_type, 'regular') = 'regular'
               AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
               AND NOT EXISTS (SELECT 1 FROM staff_members sm WHERE sm.user_id = u.id OR sm.revoked_user_id = u.id)`;
  assert((await sql`SELECT signup_role FROM users WHERE id = ${legacy.id}`).rows[0].signup_role === 'client', 'the backfill marks it as a client account');
  assert((await sql`SELECT signup_role FROM users WHERE id = ${owner.id}`).rows[0].signup_role === 'owner', 'and leaves a business account alone');
  const d = await call(dashboardHandler, { userId: legacy.id });
  assert(d.statusCode === 403 && (await workspacesOf(legacy.id)).length === 0, 'no business is created for it');

  console.log('\n[5] a client can still start a business on purpose');
  r = await call(startBusiness, { method: 'POST', userId: legacy.id, body: {} });
  assert(r.statusCode === 201 && r.body?.created === true, `start-business creates one (got ${r.statusCode})`);
  const legacyNow = (await sql`SELECT signup_role FROM users WHERE id = ${legacy.id}`).rows[0];
  const lw = await workspacesOf(legacy.id);
  assert(legacyNow.signup_role === 'owner' && lw.length === 1 && lw[0].subscription_status === 'incomplete', 'it is now a business account with no plan yet (the paywall starts the trial)');
  me = await call(meHandler, { userId: legacy.id });
  assert(me.body.isOwner === true && me.body.clientAccount === false && landing(me.body) === 'onboarding', 'and the app takes it to business set-up');

  console.log('\n[6] "I am a client, not a business": switching back');
  const oops = (await userByEmail(ownerEmail));
  r = await call(becomeClient, { userId: oops.id });
  assert(r.statusCode === 200 && r.body?.eligible === true, 'an unused business with no plan can be switched');
  r = await call(becomeClient, { method: 'POST', userId: oops.id, body: {} });
  assert(r.statusCode === 400 && (await workspacesOf(oops.id)).length === 1, 'not without confirming');
  r = await call(becomeClient, { method: 'POST', userId: oops.id, body: { confirm: true } });
  assert(r.statusCode === 200 && r.body?.landing === 'client', `the switch goes through (got ${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
  assert((await workspacesOf(oops.id)).length === 0 && (await userByEmail(ownerEmail)).signup_role === 'client', 'the unused business is gone and the account is a client account');
  me = await call(meHandler, { userId: oops.id });
  assert(me.body.isOwner === false && landing(me.body) === 'client', 'the app now opens the client portal');
  const audit = (await sql`SELECT action FROM audit_events WHERE target_user_id = ${oops.id} AND action = 'user.became_client_account'`).rows;
  assert(audit.length === 1, 'the switch is recorded');

  console.log('\n[7] the switch is refused when there is something to lose');
  const mk = async (tag, ws = {}) => {
    const u = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, signup_role)
      VALUES (${`cag-${tag}-${S}@example.com`}, 'x', 'Pat Owner', ${CURRENT_TERMS_VERSION}, NOW(), 'owner') RETURNING id`).rows[0];
    made.push(u.id);
    const w = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, stripe_subscription_id)
      VALUES (${u.id}, ${ws.status || 'incomplete'}, ${ws.trialEndsAt || null}, ${ws.sub || null}) RETURNING id`).rows[0];
    return { id: u.id, ws: w.id };
  };
  const paying = await mk('paying', { status: 'active', sub: 'sub_test_1' });
  r = await call(becomeClient, { method: 'POST', userId: paying.id, body: { confirm: true } });
  assert(r.statusCode === 400 && r.body?.details?.code === 'switch-plan' && (await workspacesOf(paying.id)).length === 1, 'a business with a live plan is never removed');
  const trialing = await mk('trial', { status: 'trialing', trialEndsAt: new Date(Date.now() + 5 * 86400e3).toISOString(), sub: 'sub_test_2' });
  assert((await clientSwitchCheck(trialing.id)).reason === 'plan', 'nor one in a trial');
  const lapsed = await mk('lapsed', { status: 'canceled' });
  assert((await clientSwitchCheck(lapsed.id)).reason === 'plan', 'nor one that had a plan and cancelled');
  const used = await mk('used');
  await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${used.ws}, 'Real Client', 'real@example.com', 'active')`;
  r = await call(becomeClient, { method: 'POST', userId: used.id, body: { confirm: true } });
  assert(r.statusCode === 400 && r.body?.details?.code === 'switch-data' && (await workspacesOf(used.id)).length === 1, 'a business that holds client records is not removed by its owner');
  assert(!/[–—]/.test(r.body?.error || '') && /support/i.test(r.body?.error || ''), 'the refusal says to contact support, in plain words');
  r = await call(becomeClient, { method: 'POST', userId: client.id, body: { confirm: true } });
  assert(r.statusCode === 400 && r.body?.details?.code === 'switch-no-business', 'a client account has nothing to switch');

  console.log('\n[8] Admin can do it for someone, including when there are records');
  const adminEmail = process.env.SUPER_ADMIN_EMAIL || `cag-admin-${S}@example.com`;
  process.env.SUPER_ADMIN_EMAIL = adminEmail;
  let admin = await userByEmail(adminEmail);
  if (!admin) {
    admin = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, user_type, email_verified_at, signup_role)
      VALUES (${adminEmail}, 'x', 'Admin', ${CURRENT_TERMS_VERSION}, NOW(), 'super_admin', NOW(), 'owner') RETURNING id`).rows[0];
    made.push(admin.id);
  }
  r = await call(adminWorkspaces, { userId: admin.id, query: { id: used.id } });
  if (r.statusCode === 200) {
    assert(r.body?.clientSwitch?.eligible === true && r.body.clientSwitch.needsConfirm === true && r.body.clientSwitch.dataRows === 1, 'Admin sees that it can be switched, and that it holds 1 record');
    r = await call(adminWorkspaces, { method: 'POST', userId: admin.id, query: { id: used.id }, body: { makeClientAccount: true } });
    assert(r.statusCode === 400 && (await workspacesOf(used.id)).length === 1, 'not without confirming the records');
    r = await call(adminWorkspaces, { method: 'POST', userId: admin.id, query: { id: used.id }, body: { makeClientAccount: true, allowData: true } });
    assert(r.statusCode === 200 && (await workspacesOf(used.id)).length === 0, 'with confirmation it goes through');
    r = await call(adminWorkspaces, { method: 'POST', userId: admin.id, query: { id: paying.id }, body: { makeClientAccount: true, allowData: true } });
    assert(r.statusCode === 400 && (await workspacesOf(paying.id)).length === 1, 'Admin cannot remove a business with a live plan either');
    r = await call(adminWorkspaces, { method: 'POST', userId: used.id, query: { id: paying.id }, body: { makeClientAccount: true } });
    assert(r.statusCode === 401 || r.statusCode === 403 || r.statusCode === 404, 'and nobody but a super-admin can use the Admin action');
  } else {
    assert(false, `Admin endpoint not reachable in this test set-up (got ${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
  }
}

// What the screens must keep doing (read from the source; the flows
// themselves are walked in a browser before each release).
function screens() {
  console.log('\n[9] the screens make the choice obvious');
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const welcome = src('src/features/auth/WelcomePage.jsx');
  assert(/navigate\('\/signup'\)/.test(welcome) && /navigate\('\/signup\?mode=client'\)/.test(welcome) && /<b>I run a business<\/b>\n\s*<\/button>/.test(welcome) && /<b>I&apos;m a client<\/b>\n\s*<\/button>/.test(welcome),
    'the app welcome screen offers "I run a business" and "I\'m a client" as separate buttons');
  const auth = src('src/features/auth/AuthPage.jsx');
  assert(/role="radiogroup"/.test(auth) && /data-role-choice=\{k\}/.test(auth) && /params\.get\('mode'\) === 'client' \? 'client' : 'owner'/.test(auth),
    'the sign-up form has the business or client choice at the top, and invite links preselect client');
  assert(/<NotABusiness\/>/.test(src('src/features/onboarding/OnboardingPage.jsx')) && (src('src/features/billing/Paywall.jsx').match(/<NotABusiness variant="link"\/>/g) || []).length === 2,
    'business set-up and the paywall (its first card and its plan screen) offer "I\'m a client"');
  const nab = src('src/components/NotABusiness.jsx');
  assert(/confirmAction\(/.test(nab) && /\/account\/become-client/.test(nab) && /\/helper\/start-business/.test(nab), 'switching either way asks first');
  assert(!/[\u2013\u2014]/.test(nab.replace(/\/\/.*$/gm, '')) && !/[\u2013\u2014]/.test(welcome.replace(/\/\/.*$/gm, '')), 'no dashes in what people read');
  assert(/const isClient = \(data\?\.memberships\?\.length \|\| 0\) > 0;/.test(src('src/features/client/ClientHome.jsx')), 'a client account with no business linked yet still gets the "No businesses here yet" help');
  assert(/Run your own business\?/.test(src('src/features/client/ClientShell.jsx')), 'the client view offers a way to start a business on purpose');
  assert(/Make this a client account/.test(src('src/features/admin/DuplicateBusinesses.jsx')) && /profile-account-type/.test(src('src/features/admin/UserProfileSheet.jsx')), 'Admin can switch someone to a client account');
}

main().then(screens).catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of made) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

// Admin user profile + required onboarding answers.
//
//   • GET /api/admin/users/:id/profile is super-admin only (owners get 403,
//     no session is refused), returns account / devices / subscription /
//     business / usage / acquisition / health, and NEVER any client name,
//     email, phone, message or invoice text.
//   • Sign-ins in the last 30 days come from auth.login audit rows; the
//     last sign-in device is a short label (iPhone app vs a browser); the
//     platform of the last activity is stamped by requireUser.
//   • Subscription reads in plain states; the "trial ends soon with no
//     payment method" and "hasn't added a service" hints fire.
//   • ?include=stripe without Stripe configured degrades, never 500s.
//   • GET /api/admin/users: "Missing onboarding answers" filter, per-row
//     onboardingAnswersMissing, last login / last active sorts; non-admin 403.
//   • GET /api/admin/users/:id/onboarding reports the required questions.
//   • GET /api/me sends onboardingAnswersMissing (owners only).
//   • PATCH /api/onboarding/profile never lets an empty answer (an older app
//     build) erase a stored required answer, and reports what is missing.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-user-profile.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, invalidateUserCache } from '../api/_lib/auth.js';
import profileEndpoint, { describeDevice } from '../api/admin/users/[id]/profile.js';
import usersList from '../api/admin/users.js';
import adminOnboarding from '../api/admin/users/[id]/onboarding.js';
import meHandler from '../api/me/index.js';
import onboardingProfile from '../api/onboarding/profile.js';
import { missingRequiredAnswers } from '../api/_lib/onboardingAnswers.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const mockRes = () => ({
  statusCode: 200, headers: {}, body: null,
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
  json(o) { this.body = o; return this; }, end() { return this; },
});
let ipN = 0;
const req = ({ method = 'GET', body = {}, query = {}, headers = {} } = {}) => ({
  method, url: '/test', query, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 20}`, ...headers },
});
const call = async (h, o) => { const r = mockRes(); await h(req(o), r); return r; };
const ADMIN = { 'x-admin-secret': process.env.ADMIN_SECRET };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TAG = `aup${S}`;
const userIds = [];
async function user(tag, extra = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, created_at)
    VALUES (${`${TAG}-${tag}@example.com`}, 'x', ${`Owner ${tag}`}, ${extra.verified === false ? null : new Date()}, ${extra.createdAt || new Date()})
    RETURNING id`).rows[0].id;
  userIds.push(u);
  return { u, cookie: `ivy_session=${signSession(u)}` };
}
async function owner(tag, ws = {}) {
  const o = await user(tag, ws);
  const w = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
    VALUES (${o.u}, ${ws.status || 'trialing'}, ${ws.trialEndsAt || new Date(Date.now() + 10 * 86400000)}) RETURNING id`).rows[0].id;
  return { ...o, w };
}
const FULL = {
  goalIds: ['grow_revenue'], challengeIds: ['leads'], stageIds: ['starting'],
  heardFromIds: ['google'], locationState: 'GA',
};

const IPHONE_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const SAFARI_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] super-admin only');
    const a = await owner('a', { trialEndsAt: new Date(Date.now() + 2 * 86400000 - 60_000) });
    const b = await owner('b');
    let r = await call(profileEndpoint, { query: { id: a.u }, headers: { cookie: b.cookie } });
    assert(r.statusCode === 403, 'another owner gets 403');
    r = await call(profileEndpoint, { query: { id: a.u }, headers: { cookie: a.cookie } });
    assert(r.statusCode === 403, 'the owner themself (not a super admin) gets 403');
    r = await call(profileEndpoint, { query: { id: a.u } });
    assert(r.statusCode === 401 || r.statusCode === 403, 'no session is refused');
    r = await call(profileEndpoint, { method: 'POST', query: { id: a.u }, headers: ADMIN });
    assert(r.statusCode === 405, 'GET only');
    r = await call(profileEndpoint, { query: { id: "1' OR '1'='1" }, headers: ADMIN });
    assert(r.statusCode === 404, 'non-uuid id is a 404, never SQL');
    r = await call(profileEndpoint, { query: { id: '00000000-0000-0000-0000-000000000000' }, headers: ADMIN });
    assert(r.statusCode === 404, 'unknown user is a 404');
    r = await call(usersList, { query: { q: TAG }, headers: { cookie: b.cookie } });
    assert(r.statusCode === 403, 'Users list: non-admin gets 403');
    r = await call(adminOnboarding, { query: { id: a.u }, headers: { cookie: b.cookie } });
    assert(r.statusCode === 403, 'onboarding answers: non-admin gets 403');

    console.log('\n[2] counts only, no client PII');
    const SECRET = `Zebulon${S}`;
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, phone, stage, notes)
      VALUES (${a.w}, ${`${SECRET} Client`}, ${`${SECRET.toLowerCase()}@clients.example`}, '+15550001234', 'active', ${`${SECRET} note`}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${a.w}, ${`${SECRET} Two`}, ${`two-${S}@clients.example`}, 'active')`;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, notes)
      VALUES (${a.w}, ${cid}, ${`${SECRET} Client`}, ${`${SECRET.toLowerCase()}@clients.example`}, CURRENT_DATE + 3, 540, 600, ${`${SECRET} booking note`})`;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, date, start_min, end_min, created_at)
      VALUES (${a.w}, ${cid}, ${`${SECRET} Client`}, CURRENT_DATE - 60, 540, 600, NOW() - INTERVAL '60 days')`;
    await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, total, paid_amount, paid_at)
      VALUES (${a.w}, ${cid}, ${`${SECRET} Client`}, ${`INV-${S}`}, 'paid', ${JSON.stringify([{ description: `${SECRET} line`, quantity: 1, rate: 120 }])}::jsonb, 0, 0, 120, 120, NOW())`;
    const th = (await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${a.w}, ${cid}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${th}, 'client', ${`${SECRET} private message`})`;

    // Sign-ins: two in the last 30 days (latest from the iPhone app), one older.
    await sql`INSERT INTO audit_events (actor_user_id, action, meta, user_agent, ip, created_at)
      VALUES (${a.u}, 'auth.login', '{}'::jsonb, ${SAFARI_MAC_UA}, '203.0.113.9', NOW() - INTERVAL '45 days'),
             (${a.u}, 'auth.login', '{"platform":"web"}'::jsonb, ${SAFARI_MAC_UA}, '203.0.113.9', NOW() - INTERVAL '3 days'),
             (${a.u}, 'auth.login', '{}'::jsonb, ${IPHONE_APP_UA}, '203.0.113.9', NOW() - INTERVAL '1 hour'),
             (${a.u}, 'auth.login_fail', '{}'::jsonb, ${SAFARI_MAC_UA}, '203.0.113.9', NOW())`;
    await sql`UPDATE users SET last_login_at = NOW() - INTERVAL '1 hour', mfa_email_enabled_at = NOW() WHERE id = ${a.u}`;

    r = await call(profileEndpoint, { query: { id: a.u }, headers: ADMIN });
    assert(r.statusCode === 200, 'super-admin gets 200');
    const P = r.body || {};
    const text = JSON.stringify(P);
    assert(!text.includes(SECRET) && !text.toLowerCase().includes(SECRET.toLowerCase()), 'no client name, email, note, line item or message text anywhere');
    assert(!text.includes('+15550001234') && !text.includes('203.0.113.9'), 'no client phone and no IP address');
    assert(P.usage?.clients === 2, 'client count');
    assert(P.usage?.bookings?.all === 2 && P.usage?.bookings?.last30d === 1 && P.usage?.bookings?.upcoming === 1, 'bookings all / added in 30 days / upcoming');
    assert(P.usage?.invoices?.paid === 1 && P.usage?.invoices?.sent === 1, 'invoices sent and paid');
    assert(typeof P.usage?.revenueThroughIvy === 'number', 'revenue through Ivy is a number');
    assert(P.usage?.ivy && 'messagesThisMonth' in P.usage.ivy && 'allowance' in P.usage.ivy, 'Ivy messages vs allowance');
    assert(P.usage?.services === 0, 'services counted');

    console.log('\n[3] account and devices');
    assert(P.account?.logins30d === 2, 'sign-ins in the last 30 days from auth.login rows only');
    assert(P.account?.twoStep?.email === true && P.account?.twoStep?.app === false, '2-step: email codes on, app off');
    assert(P.account?.roles?.owner === true && P.account?.roles?.client === false, 'account type: owner');
    assert(P.account?.lastLoginAt && P.account?.createdAt, 'last login and signup dates');
    assert(P.account?.deletedAt === null, 'no deletion scheduled');
    assert(P.devices?.lastSignIn?.device === 'iPhone app (iOS 18.1)', 'last sign-in device: iPhone app from the web view user agent');
    assert(P.devices?.appVersion === null, 'app version honestly not recorded');
    assert(P.devices?.iphonePush?.devices === 0, 'push: no iPhone devices');
    assert(describeDevice(SAFARI_MAC_UA) === 'Safari on Mac', 'Safari on Mac label');
    assert(describeDevice('x', 'ios') === 'iPhone app', 'platform marker wins');
    const t0 = Date.now();
    describeDevice('Mozilla/5.0 ' + '('.repeat(5000) + 'iPhone OS 1'.repeat(3000));
    assert(Date.now() - t0 < 200, 'hostile user agent is handled quickly');

    // requireUser stamps the platform of the latest activity.
    await sql`UPDATE users SET last_active_at = NULL WHERE id = ${b.u}`;
    invalidateUserCache(b.u);
    r = await call(meHandler, { headers: { authorization: `Bearer ${signSession(b.u)}`, 'x-client-platform': 'ios' } });
    assert(r.statusCode === 200, '/api/me from the iPhone app works');
    let plat = null;
    for (let i = 0; i < 20 && !plat; i++) { await sleep(50); plat = (await sql`SELECT last_active_platform FROM users WHERE id = ${b.u}`).rows[0].last_active_platform; }
    assert(plat === 'ios', 'last_active_platform stamped as ios');
    r = await call(profileEndpoint, { query: { id: b.u }, headers: ADMIN });
    assert(r.body?.devices?.lastUsedOn === 'iPhone app', 'profile shows last used on the iPhone app');

    console.log('\n[4] subscription and health hints');
    assert(P.subscription?.state === 'trial' && P.subscription?.date, 'trial state with its end date');
    assert(P.subscription?.paymentMethodOnFile === false && P.subscription?.source === null, 'no payment method, no source yet');
    const hints = (P.health || []).map((h) => h.text);
    assert(hints.some((h) => /^Trial ends in 2 days and no payment method$/.test(h)), 'hint: trial ends in 2 days and no payment method');
    assert(hints.includes("Hasn't added a service"), "hint: hasn't added a service");
    assert(hints.some((h) => /Missing 5 required onboarding answers/.test(h)), 'hint: missing onboarding answers');
    await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '20 days', cancel_at_period_end = TRUE, stripe_customer_id = ${`cus_${S}`} WHERE id = ${b.w}`;
    r = await call(profileEndpoint, { query: { id: b.u }, headers: ADMIN });
    assert(r.body?.subscription?.state === 'cancelling' && r.body?.subscription?.source === 'stripe', 'cancel at period end reads as cancelling, Stripe source');
    await sql`UPDATE workspaces SET subscription_status = 'past_due', subscription_past_due_since = NOW() - INTERVAL '2 days', subscription_failed_attempts = 2 WHERE id = ${b.w}`;
    r = await call(profileEndpoint, { query: { id: b.u }, headers: ADMIN });
    assert(r.body?.subscription?.state === 'past_due' && r.body?.subscription?.failedAttempts === 2, 'past due with failed attempts');
    const prevKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY; delete process.env.IVY_STRIPE_SECRET; delete process.env.STRIPE_PLATFORM_SECRET;
    r = await call(profileEndpoint, { query: { id: b.u, include: 'stripe' }, headers: ADMIN });
    assert(r.statusCode === 200 && r.body?.stripe?.available === false, 'Stripe part degrades when Stripe is not configured');
    if (prevKey) process.env.STRIPE_SECRET_KEY = prevKey;
    r = await call(profileEndpoint, { query: { id: b.u, include: 'stripe' }, headers: { cookie: a.cookie } });
    assert(r.statusCode === 403, 'Stripe part is super-admin only too');

    console.log('\n[5] /api/me and the profile endpoint report missing answers');
    r = await call(meHandler, { headers: { cookie: a.cookie } });
    assert(JSON.stringify(r.body?.onboardingAnswersMissing) === JSON.stringify(['heardFrom', 'location', 'stage', 'goals', 'challenges']), 'owner with no answers: all five missing');
    for (const k of ['isOwner', 'owns', 'subscription', 'summary']) assert(k in (r.body || {}), `/api/me still sends ${k}`);
    const client = await user('client');
    await sql`UPDATE clients SET user_id = ${client.u} WHERE id = ${cid}`;
    r = await call(meHandler, { headers: { cookie: client.cookie } });
    assert(Array.isArray(r.body?.onboardingAnswersMissing) && r.body.onboardingAnswersMissing.length === 0, 'client: nothing missing (never asked)');
    r = await call(onboardingProfile, { headers: { cookie: a.cookie } });
    assert(r.body?.missing?.length === 5, 'GET /onboarding/profile reports what is missing');
    r = await call(onboardingProfile, { method: 'PATCH', headers: { cookie: a.cookie }, body: { ...FULL, heardFromIds: [], heardFromOther: 'A podcast' } });
    assert(r.statusCode === 200 && r.body?.missing?.length === 0, 'answers saved; typed Other counts as answered');
    r = await call(meHandler, { headers: { cookie: a.cookie } });
    assert(r.body?.onboardingAnswersMissing?.length === 0, '/api/me: nothing missing after answering');

    console.log('\n[6] an older app build never erases a required answer');
    r = await call(onboardingProfile, { method: 'PATCH', headers: { cookie: a.cookie }, body: {
      goalIds: [], goalOther: '', challengeIds: ['no_shows'], challengeOther: '', idealClient: '',
      heardFromIds: [], heardFromOther: '', stageIds: [], locationState: '', locationCountry: '',
    } });
    assert(r.statusCode === 200, 'old payload with empty answers still 200');
    const row = (await sql`SELECT * FROM workspace_profile WHERE workspace_id = ${a.w}`).rows[0];
    assert(JSON.stringify(row.goal_ids) === '["grow_revenue"]' && row.goal === 'grow_revenue', 'goals kept');
    assert(JSON.stringify(row.challenge_ids) === '["no_shows"]', 'a real new answer still replaces the old one');
    assert(JSON.stringify(row.stage_ids) === '["starting"]', 'stage kept');
    assert(row.heard_from_other === 'A podcast', 'heard-from kept');
    assert(row.location_state === 'GA', 'location kept');
    assert(missingRequiredAnswers(row).length === 0, 'still complete');
    assert(JSON.stringify(missingRequiredAnswers({ goal: 'save_time', challenge: 'leads', stage: 'starting', heard_from: 'google', location_country: 'Canada' })) === '[]', 'legacy single columns count as answered');

    console.log('\n[7] admin onboarding panel: required questions');
    r = await call(adminOnboarding, { query: { id: a.u }, headers: ADMIN });
    assert(r.body?.required?.answered === true && r.body.required.missing.length === 0 && r.body.required.total === 5, 'answered owner: answered');
    r = await call(adminOnboarding, { query: { id: b.u }, headers: ADMIN });
    assert(r.body?.required?.answered === false && r.body.required.missing.length === 5, 'owner who never answered: missing (5)');
    for (const k of ['workspace', 'answers', 'progress', 'signupReferral', 'switchFrom']) assert(k in (r.body || {}), `existing field ${k} kept`);

    console.log('\n[8] Users list: filter and sorts');
    r = await call(usersList, { query: { q: TAG, type: 'missing-answers' }, headers: ADMIN });
    let emails = (r.body?.users || []).map((x) => x.email);
    assert(r.statusCode === 200, 'filter returns 200');
    assert(emails.includes(`${TAG}-b@example.com`), 'owner missing answers is listed');
    assert(!emails.includes(`${TAG}-a@example.com`), 'owner with every answer is not listed');
    assert(!emails.includes(`${TAG}-client@example.com`), 'client-only account is not listed');
    r = await call(usersList, { query: { q: TAG }, headers: ADMIN });
    const rows = r.body?.users || [];
    assert(rows.find((x) => x.email === `${TAG}-b@example.com`)?.onboardingAnswersMissing === 5, 'row: 5 missing');
    assert(rows.find((x) => x.email === `${TAG}-a@example.com`)?.onboardingAnswersMissing === 0, 'row: 0 missing');
    assert(rows.find((x) => x.email === `${TAG}-client@example.com`)?.onboardingAnswersMissing === null, 'row: null without a business');
    await sql`UPDATE users SET last_login_at = NOW() - INTERVAL '5 days' WHERE id = ${b.u}`;
    await sql`UPDATE users SET last_login_at = NULL, last_active_at = NULL WHERE id = ${client.u}`;
    r = await call(usersList, { query: { q: TAG, sort: 'last_login' }, headers: ADMIN });
    emails = (r.body?.users || []).map((x) => x.email);
    assert(emails[0] === `${TAG}-a@example.com` && emails[1] === `${TAG}-b@example.com` && emails[emails.length - 1] === `${TAG}-client@example.com`, 'last login: newest first, never last');
    r = await call(usersList, { query: { q: TAG, sort: 'last_login_asc' }, headers: ADMIN });
    emails = (r.body?.users || []).map((x) => x.email);
    assert(emails[0] === `${TAG}-client@example.com`, 'last login ascending: never first');
    r = await call(usersList, { query: { q: TAG, sort: 'last_active' }, headers: ADMIN });
    assert(r.statusCode === 200 && (r.body?.users || []).length === emails.length, 'last active sort works');
    r = await call(usersList, { query: { q: TAG, sort: "u.email; DROP TABLE users" }, headers: ADMIN });
    assert(r.statusCode === 200, 'unknown sort falls back, never SQL');
    assert('lastLoginAt' in (rows[0] || {}) && 'lastActiveAt' in (rows[0] || {}) && 'workspaceCount' in (rows[0] || {}), 'existing row fields kept');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of userIds) {
      await sql`DELETE FROM audit_events WHERE actor_user_id = ${id}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

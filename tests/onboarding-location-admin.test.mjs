// Onboarding "About you" answers: where the business is based, who referred
// the owner, typed "Other" kept alongside presets, older app builds still
// saving, and the super-admin views of the answers.
//
//   • PATCH /api/onboarding/profile stores location (US state or country),
//     the referrer's name, and typed Other text next to picked presets.
//   • An old-client payload (no location / referral keys, iPhone 1.0.4)
//     still succeeds and does not wipe what a newer build stored.
//   • Allowlists: junk state codes, junk preset ids, non-string text and
//     over-long text are dropped or capped; referral name only with
//     "Friend / referral".
//   • GET /api/admin/users/:id/onboarding is super-admin only and returns
//     the answers + wizard progress; other owners get 403.
//   • /api/admin/analytics onboarding.location breaks the cohort down by
//     state ('intl' for outside the US) with countries listed separately.
//   • /api/me/setup-status keeps "Set your weekly availability" open after
//     the Hours step was skipped, until hours are saved via PATCH /calendar.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/onboarding-location-admin.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import profileHandler from '../api/onboarding/profile.js';
import adminOnboarding from '../api/admin/users/[id]/onboarding.js';
import analytics from '../api/admin/analytics.js';
import setupStatus from '../api/me/setup-status.js';
import calendarHandler from '../api/calendar/index.js';

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
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 30}`, ...headers },
});
const call = async (h, o) => { const r = mockRes(); await h(req(o), r); return r; };

const S = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const userIds = [];
async function owner(tag, { createdAt } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`onbloc-${tag}-${S}@example.com`}, 'x', ${tag}, NOW()) RETURNING id`).rows[0].id;
  userIds.push(u);
  const w = createdAt
    ? (await sql`INSERT INTO workspaces (owner_id, created_at) VALUES (${u}, ${createdAt}) RETURNING id`).rows[0].id
    : (await sql`INSERT INTO workspaces (owner_id) VALUES (${u}) RETURNING id`).rows[0].id;
  return { u, w, cookie: `ivy_session=${signSession(u)}` };
}
const profileRow = async (w) => (await sql`SELECT * FROM workspace_profile WHERE workspace_id = ${w}`).rows[0];

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] location, referrer name and typed Other next to presets are all stored');
    const a = await owner('a');
    let r = await call(profileHandler, { method: 'PATCH', headers: { cookie: a.cookie }, body: {
      goalIds: ['grow_revenue'], goalOther: 'Open a second studio',
      challengeIds: ['leads'], challengeOther: 'Scheduling across two jobs',
      heardFromIds: ['instagram', 'referral'], heardFromOther: "My cousin's podcast",
      referralName: '  Dana from Glow Studio ',
      stageIds: ['side_hustle'],
      locationState: 'tx', locationCountry: 'Ignored when a state is picked',
      idealClient: 'Busy moms',
    } });
    assert(r.statusCode === 200, 'PATCH returns 200');
    let row = await profileRow(a.w);
    assert(row.location_state === 'TX', 'state code stored (normalised to upper case)');
    assert(row.location_country === 'United States', 'a US state implies the country');
    assert(row.referral_name === 'Dana from Glow Studio', 'referrer name stored, trimmed');
    assert(row.heard_from === 'instagram' && row.heard_from_other === "My cousin's podcast", 'typed Other kept even though a preset was picked');
    assert(row.goal === 'grow_revenue' && row.goal_other === 'Open a second studio', 'goal Other kept alongside preset');
    assert(row.challenge_other === 'Scheduling across two jobs', 'challenge Other kept alongside preset');
    assert(r.body?.profile?.locationState === 'TX' && r.body?.profile?.referralName === 'Dana from Glow Studio', 'response carries the new fields');
    for (const k of ['goal', 'goalOther', 'goalIds', 'challenge', 'challengeOther', 'challengeIds', 'idealClient', 'heardFrom', 'heardFromOther', 'heardFromIds', 'stage', 'stageIds']) {
      if (!(k in r.body.profile)) assert(false, `existing response field ${k} kept`);
    }
    assert(true, 'every existing response field kept');

    console.log('\n[2] outside the US: country stored, no state');
    r = await call(profileHandler, { method: 'PATCH', headers: { cookie: a.cookie }, body: {
      goalIds: ['grow_revenue'], challengeIds: ['leads'], heardFromIds: ['google'], stageIds: ['starting'],
      locationState: null, locationCountry: 'Canada',
    } });
    row = await profileRow(a.w);
    assert(row.location_state === null && row.location_country === 'Canada', 'country stored for a business outside the US');
    assert(row.referral_name === null, 'referrer name cleared once Friend / referral is no longer picked');

    console.log('\n[3] old-client payload (iPhone 1.0.4) still saves and keeps the newer answers');
    await call(profileHandler, { method: 'PATCH', headers: { cookie: a.cookie }, body: {
      goalIds: ['save_time'], challengeIds: ['leads'], heardFromIds: ['referral'], referralName: 'Dana', stageIds: ['starting'],
      locationState: 'NY',
    } });
    r = await call(profileHandler, { method: 'PATCH', headers: { cookie: a.cookie }, body: {
      // Exactly what the old About step sends: no location, no referral name.
      goalIds: ['look_pro'], goalOther: '', challengeIds: ['organized'], challengeOther: '',
      idealClient: '', heardFromIds: ['referral'], heardFromOther: '', stageIds: [],
    } });
    assert(r.statusCode === 200, 'old payload returns 200');
    row = await profileRow(a.w);
    assert(row.goal === 'look_pro', 'old payload answers recorded');
    assert(row.location_state === 'NY' && row.location_country === 'United States', 'stored location untouched by an old client');
    assert(row.referral_name === 'Dana', 'stored referrer name untouched by an old client');
    const legacy = await owner('legacy');
    r = await call(profileHandler, { method: 'PATCH', headers: { cookie: legacy.cookie }, body: { goal: 'grow_revenue' } });
    assert(r.statusCode === 200 && (await profileRow(legacy.w)).goal === 'grow_revenue', 'a minimal legacy single-field payload with no heard-from still saves');

    console.log('\n[4] allowlists and caps');
    const b = await owner('b');
    r = await call(profileHandler, { method: 'PATCH', headers: { cookie: b.cookie }, body: {
      goalIds: ['grow_revenue', '<script>', 'nope'], heardFromIds: ['myspace', 'tiktok'],
      locationState: 'ZZ', locationCountry: 'x'.repeat(300),
      referralName: 'Should be dropped',
    } });
    assert(r.statusCode === 200, 'junk does not 400');
    row = await profileRow(b.w);
    assert(JSON.stringify(row.goal_ids) === JSON.stringify(['grow_revenue']), 'junk goal ids dropped');
    assert(JSON.stringify(row.heard_from_ids) === JSON.stringify(['tiktok']), 'junk heard-from ids dropped');
    assert(row.location_state === null, 'unknown state code rejected');
    assert(row.location_country.length === 80, 'country capped at 80 characters');
    assert(row.referral_name === null, 'referrer name ignored without Friend / referral');
    r = await call(profileHandler, { method: 'PATCH', headers: { cookie: b.cookie }, body: {
      locationState: { $ne: 1 }, locationCountry: ['Canada'], heardFromOther: { a: 1 }, heardFromIds: ['referral'], referralName: 'Line\none\u0000two',
    } });
    assert(r.statusCode === 200, 'wrong types do not 400');
    row = await profileRow(b.w);
    assert(row.location_state === null && row.location_country === null, 'non-string location values dropped');
    assert(row.heard_from_other === null, 'non-string Other text dropped');
    assert(row.referral_name === 'Line one two', 'control characters stripped from the referrer name');

    console.log('\n[5] admin onboarding answers: super-admin only');
    await sql`UPDATE users SET onboarding_state = ${JSON.stringify({
      currentStep: 'done', completedSteps: ['welcome', 'business', 'about', 'done'], skippedSteps: ['services', 'availability'],
      stepTimestamps: { welcome: '2026-11-01T10:00:00.000Z', about: '2026-11-01T10:02:00.000Z', services: '2026-11-01T10:03:00.000Z' },
      switchFrom: 'vagaro',
    })}::jsonb WHERE id = ${a.u}`;
    await sql`UPDATE workspaces SET onboarded_at = NOW() WHERE id = ${a.w}`;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, category) VALUES (${a.w}, 'Glow Lab', ${`glow-lab-${S}`.slice(0, 40)}, 'Beauty')
      ON CONFLICT (workspace_id) DO UPDATE SET biz_name = 'Glow Lab', category = 'Beauty'`;
    r = await call(adminOnboarding, { query: { id: a.u }, headers: { cookie: b.cookie } });
    assert(r.statusCode === 403, 'another owner gets 403');
    r = await call(adminOnboarding, { query: { id: a.u } });
    assert(r.statusCode === 401 || r.statusCode === 403, 'no session gets refused');
    r = await call(adminOnboarding, { query: { id: a.u }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 200, 'super-admin gets 200');
    const d = r.body || {};
    assert(d.answers?.locationState === 'NY', 'answers include location');
    assert(JSON.stringify(d.answers?.heardFrom) === JSON.stringify(['referral']) && d.answers?.referralName === 'Dana', 'answers include heard-from picks and referrer');
    assert(JSON.stringify(d.answers?.goals) === JSON.stringify(['look_pro']), 'answers include goals');
    assert(d.switchFrom === 'vagaro', 'answers include the app they switched from');
    assert(d.workspace?.businessName === 'Glow Lab' && d.workspace?.category === 'Beauty', 'business name and category');
    assert(d.progress?.skippedSteps?.includes('services') && d.progress?.stepTimestamps?.about === '2026-11-01T10:02:00.000Z', 'progress: skipped steps and first-seen times');
    assert(!!d.progress?.finishedAt, 'progress: finished time');
    assert(!('email' in d) && !('clients' in d), 'no other account data in the response');
    r = await call(adminOnboarding, { query: { id: '00000000-0000-0000-0000-000000000000' }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 404, 'unknown user is 404');
    r = await call(adminOnboarding, { query: { id: "1' OR '1'='1" }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 404, 'malformed id is 404');
    const c = await owner('c');
    r = await call(adminOnboarding, { query: { id: c.u }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 200 && r.body.answers === null, 'an older account with no answers returns answers: null');
    const clientOnly = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`onbloc-client-${S}@example.com`}, 'x', 'Client') RETURNING id`).rows[0].id;
    userIds.push(clientOnly);
    r = await call(adminOnboarding, { query: { id: clientOnly }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 200 && r.body.workspace === null, 'a client-only account has no onboarding');
    r = await call(adminOnboarding, { method: 'POST', query: { id: a.u }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 405, 'read only');

    console.log('\n[6] admin analytics: location breakdown by state');
    // A one-second window in 1999 nobody else uses, so other suites' rows
    // can't change these counts.
    const base = Date.UTC(1999, 0, 1) + Math.floor(Math.random() * 300 * 86400) * 1000;
    const from = new Date(base).toISOString();
    const to = new Date(base + 1000).toISOString();
    const inWin = new Date(base + 500).toISOString();
    const tags = [['tx1', { locationState: 'TX' }], ['tx2', { locationState: 'TX' }], ['ca', { locationState: 'CA' }], ['intl', { locationCountry: 'canada' }], ['none', {}]];
    for (const [tag, loc] of tags) {
      const o = await owner(`an-${tag}`, { createdAt: inWin });
      await call(profileHandler, { method: 'PATCH', headers: { cookie: o.cookie }, body: { goalIds: ['save_time'], ...loc } });
    }
    r = await call(analytics, { query: { from, to }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
    assert(r.statusCode === 200, 'analytics 200');
    const loc = r.body?.onboarding?.location || [];
    const n = (k) => loc.find((x) => x.k === k)?.n || 0;
    assert(n('TX') === 2 && n('CA') === 1, 'counts per state');
    assert(n('intl') === 1, 'outside the US bucketed as intl');
    assert(loc[0]?.k === 'TX', 'sorted by count');
    const countries = r.body?.onboarding?.locationCountry || [];
    assert(countries.length === 1 && countries[0].k === 'Canada' && countries[0].n === 1, 'countries listed separately, tidied');
    assert(Array.isArray(r.body?.onboarding?.goal) && Array.isArray(r.body?.onboarding?.switchFrom), 'existing onboarding fields kept');

    console.log('\n[7] skipped Hours stays on the dashboard checklist until hours are saved');
    await sql`UPDATE users SET onboarding_state = ${JSON.stringify({ currentStep: 'done', completedSteps: ['about'], skippedSteps: ['services', 'availability'] })}::jsonb WHERE id = ${b.u}`;
    await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days', onboarded_at = NOW() WHERE id = ${b.w}`;
    await sql`INSERT INTO calendar_settings (workspace_id) VALUES (${b.w}) ON CONFLICT (workspace_id) DO NOTHING`;
    r = await call(setupStatus, { headers: { cookie: b.cookie } });
    let item = (r.body?.items || []).find((i) => i.id === 'availability');
    const svc = (r.body?.items || []).find((i) => i.id === 'service');
    assert(item && item.done === false, 'availability open after skipping (even with default hours)');
    assert(/standard weekday hours/.test(item?.why || ''), 'explains the standard hours honestly');
    assert(item?.href === '/calendar?availability=1', 'links straight to the hours drawer');
    assert(svc && svc.done === false, 'skipped services shows as not done');
    r = await call(calendarHandler, { method: 'PATCH', headers: { cookie: b.cookie }, body: { availability: { 2: [{ start: 600, end: 960 }] } } });
    assert(r.statusCode === 200, 'saving hours works');
    r = await call(setupStatus, { headers: { cookie: b.cookie } });
    item = (r.body?.items || []).find((i) => i.id === 'availability');
    assert(item?.done === true, 'availability done once hours are saved');
    const st = (await sql`SELECT onboarding_state FROM users WHERE id = ${b.u}`).rows[0].onboarding_state;
    assert(JSON.stringify(st.skippedSteps) === JSON.stringify(['services']), 'only the availability skip was cleared');
    const other = (await sql`SELECT onboarding_state FROM users WHERE id = ${a.u}`).rows[0].onboarding_state;
    assert(other.skippedSteps.includes('availability'), "another owner's skip is untouched");
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of userIds) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

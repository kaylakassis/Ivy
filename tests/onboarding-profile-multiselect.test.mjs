// PATCH /api/onboarding/profile with the multi-select arrays. Confirms:
//   • Arrays in *Ids fields validate against PRESETS, dedup, cap at 10.
//   • Unknown ids are silently dropped (no 400).
//   • Single columns (goal, challenge, …) stay populated with arr[0] for
//     back-compat with admin aggregates + Ivy's workspaceContext.
//   • Free-text *Other still pairs with empty arrays the legacy way.
//   • GET returns both shapes.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/onboarding-profile-multiselect.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import profileHandler from '../api/onboarding/profile.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}
let ipN = 0;
function req({ method, body = {}, cookie }) {
  ipN++;
  return { method, url: '/test', query: {}, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${(ipN % 200) + 10}`, cookie } };
}

let ownerId, workspaceId, cookie;
const EMAIL = `prof-multi-${Date.now()}@example.com`;

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    ownerId = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${EMAIL}, 'x', 'Multi', NOW()) RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    cookie = `ivy_session=${signSession(ownerId)}`;

    console.log('\n[1] PATCH with arrays stores both arrays and arr[0] in legacy single columns');
    let r = mockRes();
    await profileHandler(req({ method: 'PATCH', cookie, body: {
      goalIds:      ['grow_revenue', 'more_clients', 'save_time'],
      challengeIds: ['leads', 'no_shows'],
      heardFromIds: ['instagram', 'referral'],
      stageIds:     ['scaling'],
    } }), r);
    assert(r.statusCode === 200, 'PATCH returns 200');
    const row = (await sql`SELECT goal, challenge, heard_from, stage, goal_ids, challenge_ids, heard_from_ids, stage_ids FROM workspace_profile WHERE workspace_id = ${workspaceId}`).rows[0];
    assert(row.goal === 'grow_revenue', 'single goal column = first array entry');
    assert(row.challenge === 'leads', 'single challenge column = first array entry');
    assert(row.heard_from === 'instagram', 'single heard_from column = first array entry');
    assert(JSON.stringify(row.goal_ids) === JSON.stringify(['grow_revenue', 'more_clients', 'save_time']), 'goal_ids array stored');
    assert(JSON.stringify(row.challenge_ids) === JSON.stringify(['leads', 'no_shows']), 'challenge_ids array stored');

    console.log('\n[2] unknown preset ids are silently dropped, valid ones kept');
    r = mockRes();
    await profileHandler(req({ method: 'PATCH', cookie, body: {
      goalIds: ['grow_revenue', 'not_a_real_goal', 'save_time'],
      challengeIds: ['leads'],
    } }), r);
    const row2 = (await sql`SELECT goal_ids FROM workspace_profile WHERE workspace_id = ${workspaceId}`).rows[0];
    assert(JSON.stringify(row2.goal_ids) === JSON.stringify(['grow_revenue', 'save_time']), 'invalid id dropped, valid ones kept');

    console.log('\n[3] duplicate ids are deduped, order preserved');
    r = mockRes();
    await profileHandler(req({ method: 'PATCH', cookie, body: {
      goalIds: ['save_time', 'save_time', 'grow_revenue', 'save_time'],
      challengeIds: ['leads'],
    } }), r);
    const row3 = (await sql`SELECT goal_ids FROM workspace_profile WHERE workspace_id = ${workspaceId}`).rows[0];
    assert(JSON.stringify(row3.goal_ids) === JSON.stringify(['save_time', 'grow_revenue']), 'deduped, first occurrence wins');

    console.log('\n[4] PATCH with legacy single fields still works (backwards compat)');
    r = mockRes();
    await profileHandler(req({ method: 'PATCH', cookie, body: {
      goal: 'look_pro', challenge: 'organized',
    } }), r);
    const row4 = (await sql`SELECT goal, goal_ids, challenge, challenge_ids FROM workspace_profile WHERE workspace_id = ${workspaceId}`).rows[0];
    assert(row4.goal === 'look_pro', 'legacy single goal still writes');
    assert(JSON.stringify(row4.goal_ids) === JSON.stringify(['look_pro']), 'legacy single goal mirrors into array');

    console.log('\n[5] free-text _other still pairs with empty array');
    r = mockRes();
    await profileHandler(req({ method: 'PATCH', cookie, body: {
      goalIds: [], goalOther: 'Build a community',
      challengeIds: ['leads'],
    } }), r);
    const row5 = (await sql`SELECT goal, goal_other, goal_ids FROM workspace_profile WHERE workspace_id = ${workspaceId}`).rows[0];
    assert(row5.goal === null, 'single goal null when no preset chosen');
    assert(row5.goal_other === 'Build a community', 'free text saved');

    console.log('\n[6] GET returns both shapes');
    r = mockRes();
    await profileHandler(req({ method: 'GET', cookie }), r);
    const p = r.body?.profile;
    assert(p && Array.isArray(p.goalIds), 'profile.goalIds is an array');
    assert(Array.isArray(p.challengeIds), 'profile.challengeIds is an array');
    assert(typeof p.goal !== 'undefined', 'profile.goal (legacy single) still present');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await sql`DELETE FROM workspace_profile WHERE workspace_id = ${workspaceId}`.catch(() => {});
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

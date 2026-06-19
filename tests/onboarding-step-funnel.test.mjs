// Per-onboarding-step funnel: the server stamps onboarding_state.stepTimestamps
// the FIRST time each step is reached, and api/admin/analytics surfaces a
// per-step "reached" count + the new trial_started funnel step. Confirms:
//   • Patching currentStep=A stamps A; patching again to A is a no-op (no
//     overwrite).
//   • completedSteps in the PATCH also stamp first-seen for those steps.
//   • Invalid step ids are filtered (can't pollute the map).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/onboarding-step-funnel.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import stateHandler from '../api/onboarding/state.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}

const createdUsers = [];
async function run() {
  try {
    await ensureSchemaApplied();
    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`stp-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    await sql`INSERT INTO workspaces (owner_id) VALUES (${uid})`;
    const cookie = `ivy_session=${signSession(uid)}`;
    const patch = (body) => ({ method: 'PATCH', headers: { cookie }, url: '/api/onboarding/state', query: {}, body });

    console.log('\n[1] first PATCH stamps the current step');
    let r = mockRes();
    await stateHandler(patch({ currentStep: 'business' }), r);
    assert(r.statusCode === 200, 'PATCH → 200');
    let ts = r.body?.state?.stepTimestamps || {};
    assert(typeof ts.business === 'string', 'business is stamped');
    // welcome should ALSO be stamped (currentStep default), no - we stamp the
    // currentStep we receive, not 'welcome'; first PATCH only stamps business.
    assert(!ts.welcome, 'welcome NOT stamped if not the currentStep');
    const firstStamp = ts.business;

    console.log('\n[2] re-patching the same step does NOT overwrite the timestamp');
    await new Promise((res) => setTimeout(res, 25)); // ensure clock would tick
    r = mockRes();
    await stateHandler(patch({ currentStep: 'business' }), r);
    ts = r.body?.state?.stepTimestamps || {};
    assert(ts.business === firstStamp, 'business timestamp is FIRST-seen, not last-seen');

    console.log('\n[3] completedSteps array stamps any new step in it');
    r = mockRes();
    await stateHandler(patch({ currentStep: 'services', completedSteps: ['welcome', 'business', 'about'] }), r);
    ts = r.body?.state?.stepTimestamps || {};
    assert(typeof ts.welcome === 'string',  'welcome stamped (via completedSteps)');
    assert(typeof ts.about === 'string',    'about stamped (via completedSteps)');
    assert(typeof ts.services === 'string', 'services stamped (via currentStep)');
    assert(ts.business === firstStamp,      'business timestamp still unchanged');

    console.log('\n[4] invalid step ids are filtered (no pollution)');
    r = mockRes();
    await stateHandler(patch({ currentStep: 'totally-fake-step' }), r);
    ts = r.body?.state?.stepTimestamps || {};
    assert(!('totally-fake-step' in ts), 'fake step is not in the map');
    assert(typeof ts.business === 'string', 'valid stamps are preserved across fake-step PATCH');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

// "Switching to Ivy?" onboarding step: the state endpoint accepts the new
// 'switch' step id and stores the owner's answer (switchFrom) only from a
// whitelist, keeps it across PATCHes that do not mention it, and clears it
// on null. Each owner only ever sees their own answer.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/onboarding-switch-state.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import stateHandler, { VALID_SWITCH_FROM } from '../api/onboarding/state.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}

const tag = `sw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdUsers = [];

async function mkOwner(label) {
  const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}-${label}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
  const uid = u.rows[0].id;
  createdUsers.push(uid);
  await sql`INSERT INTO workspaces (owner_id) VALUES (${uid})`;
  const cookie = `ivy_session=${signSession(uid)}`;
  const call = async (method, body) => {
    const r = mockRes();
    await stateHandler({ method, headers: { cookie }, url: '/api/onboarding/state', query: {}, body }, r);
    return r;
  };
  return { uid, call };
}

async function run() {
  try {
    await ensureSchemaApplied();
    const a = await mkOwner('a');
    const b = await mkOwner('b');

    console.log('\n[1] the switch step is a valid step id');
    let r = await a.call('PATCH', { currentStep: 'switch', completedSteps: ['welcome', 'availability'] });
    assert(r.statusCode === 200, 'PATCH → 200');
    assert(r.body?.state?.currentStep === 'switch', 'currentStep=switch is kept (not reset to welcome)');
    assert(typeof r.body?.state?.stepTimestamps?.switch === 'string', 'switch step is stamped for the funnel');
    r = await a.call('PATCH', { completedSteps: ['welcome', 'switch', 'first_client'], skippedSteps: ['switch'] });
    assert(r.body.state.completedSteps.includes('switch') && r.body.state.completedSteps.includes('first_client'),
      'switch + first_client can be marked completed together');
    assert(r.body.state.skippedSteps.includes('switch'), 'switch can be skipped');

    console.log('\n[2] switchFrom accepts whitelisted app ids only');
    r = await a.call('PATCH', { switchFrom: 'vagaro' });
    assert(r.body?.state?.switchFrom === 'vagaro', 'vagaro stored');
    for (const bad of ['<script>alert(1)</script>', 'Square', 'myspace', 42, { x: 1 }, ['square']]) {
      // eslint-disable-next-line no-await-in-loop
      r = await a.call('PATCH', { switchFrom: bad });
      assert(r.statusCode === 200 && r.body.state.switchFrom === null, `rejects ${JSON.stringify(bad)} (stored as null)`);
    }
    const raw = await sql`SELECT onboarding_state FROM users WHERE id = ${a.uid}`;
    assert(!JSON.stringify(raw.rows[0].onboarding_state).includes('script'), 'nothing unlisted reaches the stored JSON');
    assert(VALID_SWITCH_FROM.has('square') && VALID_SWITCH_FROM.has('new') && VALID_SWITCH_FROM.size === 17 && VALID_SWITCH_FROM.has('ptminder'), 'whitelist has the 17 choices (incl. PTminder, FutureForm, Momence)');

    console.log('\n[3] other PATCHes keep the answer; null clears it');
    await a.call('PATCH', { switchFrom: 'acuity' });
    r = await a.call('PATCH', { currentStep: 'payments' });
    assert(r.body.state.switchFrom === 'acuity', 'a nav-only PATCH leaves switchFrom alone');
    r = await a.call('GET');
    assert(r.body.state.switchFrom === 'acuity', 'GET returns the stored answer');
    r = await a.call('PATCH', { switchFrom: null });
    assert(r.body.state.switchFrom === null, 'null clears it');

    console.log('\n[4] isolation between owners');
    await a.call('PATCH', { switchFrom: 'paper' });
    r = await b.call('GET');
    assert(r.body.state.switchFrom === null, "owner B does not see owner A's answer");
    await b.call('PATCH', { switchFrom: 'booksy' });
    r = await a.call('GET');
    assert(r.body.state.switchFrom === 'paper', "owner B's PATCH does not touch owner A");

    console.log('\n[5] legacy stored state without the key normalises to null');
    await sql`UPDATE users SET onboarding_state = ${JSON.stringify({ currentStep: 'services' })}::jsonb WHERE id = ${b.uid}`;
    r = await b.call('GET');
    assert(r.body.state.switchFrom === null && r.body.state.currentStep === 'services', 'old rows still load');
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

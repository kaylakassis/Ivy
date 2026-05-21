// Tests for the post-audit fixes:
//   1. Trial-aware subscription gate (requireActiveSubscription) — an
//      expired trial must be blocked, not allowed forever.
//   2. Destructive crons (db-prune, blob-prune, discover-refresh) must
//      reject unauthenticated requests.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-fixes.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { requireActiveSubscription } from '../api/_lib/subscriptionGate.js';
import { signSession } from '../api/_lib/auth.js';
import { markProcessed, releaseProcessed } from '../api/_lib/webhookDedup.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

// Ensure the cron auth check sees NO ambient secrets/session.
delete process.env.CRON_SECRET;
delete process.env.ADMIN_SECRET;

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader() {}, getHeader() {},
  };
  res.req = { method: 'POST', url: '/test' };
  return res;
}

const createdUsers = [];
async function mkWorkspaceUser({ status, trialEndsAt }) {
  const u = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`gate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id`;
  createdUsers.push(u.rows[0].id);
  const w = await sql`
    INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
    VALUES (${u.rows[0].id}, ${status}, ${trialEndsAt})
    RETURNING id`;
  return { workspaceId: w.rows[0].id, ownerId: u.rows[0].id };
}
async function mkWorkspace(opts) { return (await mkWorkspaceUser(opts)).workspaceId; }

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] trial-aware subscription gate');
    const future = new Date(Date.now() + 86400_000).toISOString();
    const past   = new Date(Date.now() - 86400_000).toISOString();

    const wTrialActive = await mkWorkspace({ status: 'trialing', trialEndsAt: future });
    let res = mockRes();
    assert((await requireActiveSubscription(wTrialActive, {}, res)) === true && res.statusCode === 200,
      'trialing within the trial window is allowed');

    const wTrialExpired = await mkWorkspace({ status: 'trialing', trialEndsAt: past });
    res = mockRes();
    const expiredAllowed = await requireActiveSubscription(wTrialExpired, {}, res);
    assert(expiredAllowed === false && res.statusCode === 402, 'EXPIRED trial is blocked with 402');
    assert(res.body?.status === 'trial-expired', 'expired trial surfaces status "trial-expired"');

    const wActive = await mkWorkspace({ status: 'active', trialEndsAt: past });
    res = mockRes();
    assert((await requireActiveSubscription(wActive, {}, res)) === true, 'active subscription is allowed (trial date irrelevant)');

    const wSuspended = await mkWorkspace({ status: 'suspended', trialEndsAt: future });
    res = mockRes();
    assert((await requireActiveSubscription(wSuspended, {}, res)) === false && res.statusCode === 402, 'suspended is blocked with 402');

    const wCancelled = await mkWorkspace({ status: 'cancelled', trialEndsAt: future });
    res = mockRes();
    assert((await requireActiveSubscription(wCancelled, {}, res)) === false && res.statusCode === 402, 'cancelled is blocked with 402');

    const wPastDue = await mkWorkspace({ status: 'past_due', trialEndsAt: past });
    res = mockRes();
    assert((await requireActiveSubscription(wPastDue, {}, res)) === true, 'past_due is allowed (grace period)');

    console.log('\n[1b] gate is actually WIRED into newly-gated endpoints (end-to-end)');
    // Suspended owner hitting a gated write endpoint must get 402 — proves
    // the one-liner is in place, not just the helper.
    const suspended = await mkWorkspaceUser({ status: 'suspended', trialEndsAt: future });
    for (const [name, mod] of [
      ['clients/index', await import('../api/clients/index.js')],
      ['quotes/index', await import('../api/quotes/index.js')],
      ['expenses/index', await import('../api/expenses/index.js')],
    ]) {
      const r = mockRes();
      const req = {
        method: 'POST',
        headers: { cookie: `thryve_session=${signSession(suspended.ownerId)}`, 'content-type': 'application/json' },
        url: `/api/${name}`, query: {}, body: {},
      };
      r.req = req;
      // eslint-disable-next-line no-await-in-loop
      await mod.default(req, r);
      assert(r.statusCode === 402, `POST ${name} blocked with 402 for a suspended workspace`);
    }
    // A within-trial owner is NOT blocked by the gate (may fail later for
    // other reasons, but must not be 402).
    const okOwner = await mkWorkspaceUser({ status: 'trialing', trialEndsAt: future });
    {
      const r = mockRes();
      const req = {
        method: 'POST',
        headers: { cookie: `thryve_session=${signSession(okOwner.ownerId)}`, 'content-type': 'application/json' },
        url: '/api/clients', query: {}, body: { name: 'Gate Test', email: `gt-${Date.now()}@example.com` },
      };
      r.req = req;
      await (await import('../api/clients/index.js')).default(req, r);
      assert(r.statusCode !== 402, 'within-trial owner is NOT blocked by the gate (got ' + r.statusCode + ')');
    }

    console.log('\n[2] destructive crons reject unauthenticated requests');
    for (const name of ['db-prune', 'discover-refresh', 'blob-prune']) {
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(`../api/cron/${name}.js`);
      const handler = mod.default;
      const r = mockRes();
      const req = { method: 'POST', headers: {}, url: `/api/cron/${name}`, query: {} };
      r.req = req;
      // eslint-disable-next-line no-await-in-loop
      await handler(req, r);
      assert(r.statusCode === 401, `${name} returns 401 without auth`);
    }

    console.log('\n[3] webhook dedup releases a claim on failure (no lost event)');
    const evt = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    assert((await markProcessed('test', evt, null)) === true, 'first delivery claims the event');
    assert((await markProcessed('test', evt, null)) === false, 'duplicate delivery is deduped');
    await releaseProcessed('test', evt);
    assert((await markProcessed('test', evt, null)) === true, 'after release, a retry can re-claim and re-process');
    await sql`DELETE FROM webhook_event_dedup WHERE provider = 'test' AND event_id = ${evt}`.catch(() => {});
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

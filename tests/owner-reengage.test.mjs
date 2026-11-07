// Tests the owner-reengage cron: only a subscribed/onboarded owner who has
// gone dormant (last_active_at old, no prior nudge) is selected + stamped;
// active owners and already-nudged owners are skipped; a second run doesn't
// re-fire (one-shot per episode).
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/owner-reengage.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
const { default: ownerReengage } = await import('../api/cron/owner-reengage.js');

// The mail provider accepts every send (a send that fails now hands the
// cron's claim back for the next run, so these runs must deliver to stamp).
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend')) {
    return new Response(JSON.stringify({ id: `stub-${Date.now()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const cronReq = () => ({ method: 'POST', url: '/api/cron/owner-reengage', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

// Subscribed + onboarded owner with a given activity age + nudge state.
// Since 1.0.6 this cron only serves owners who turned the accountability
// partner off (partner-on owners get its own away check-ins), so owners
// here have it off unless `partner` is set.
async function mkOwner(tag, { activeAgo, nudged = false, status = 'active', partner = false }) {
  const prefs = partner ? {} : { accountability: false };
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, last_active_at, dormant_nudge_sent_at, notification_prefs)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW(),
            NOW() - ${activeAgo}::interval, ${nudged ? new Date().toISOString() : null}, ${JSON.stringify(prefs)}::jsonb)
    RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, onboarded_at)
    VALUES (${uid}, ${status}, NOW()) RETURNING id`).rows[0].id;
  // Give them something worth returning to (an upcoming booking).
  await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min)
    VALUES (${ws}, 'C', 'c@example.com', CURRENT_DATE + 1, 600, 660)`;
  return { uid, ws };
}
const nudgeAt = async (uid) =>
  (await sql`SELECT dormant_nudge_sent_at FROM users WHERE id = ${uid}`).rows[0].dormant_nudge_sent_at;

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `reeng-${Date.now()}`;

    console.log('\n[1] auth gate');
    const noAuth = mkRes();
    await ownerReengage({ method: 'POST', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no cron secret → 401 (got ${noAuth.statusCode})`);

    console.log('\n[2] selection + one-shot stamp');
    const dormant = await mkOwner(`${tag}-dormant`, { activeAgo: '15 days' });
    const active  = await mkOwner(`${tag}-active`,  { activeAgo: '1 day' });
    const already = await mkOwner(`${tag}-already`, { activeAgo: '20 days', nudged: true });
    const partnerOn = await mkOwner(`${tag}-partner`, { activeAgo: '15 days', partner: true });

    const res1 = mkRes();
    await ownerReengage(cronReq(), res1);
    assert(res1.statusCode === 200, `cron ok (got ${res1.statusCode})`);
    assert(await nudgeAt(dormant.uid) !== null, 'dormant owner gets stamped');
    assert(await nudgeAt(active.uid) === null, 'active owner is NOT selected');
    // already-nudged: stamp stays (not re-fired), value unchanged.
    assert(await nudgeAt(already.uid) !== null, 'already-nudged owner stays stamped (skipped)');
    assert(await nudgeAt(partnerOn.uid) === null, 'owner with the accountability partner on is left to the partner (no day-10 email)');

    console.log('\n[3] second run does not re-fire');
    const before = await nudgeAt(dormant.uid);
    const res2 = mkRes();
    await ownerReengage(cronReq(), res2);
    const afterStamp = await nudgeAt(dormant.uid);
    assert(String(before) === String(afterStamp), 'dormant owner not re-stamped on a second run');

    console.log('\n[4] returning clears the flag → eligible again (simulated)');
    // requireUser clears dormant_nudge_sent_at on return; simulate that, then
    // the owner is eligible on the next dormancy episode.
    await sql`UPDATE users SET dormant_nudge_sent_at = NULL, last_active_at = NOW() - INTERVAL '15 days' WHERE id = ${dormant.uid}`;
    const res3 = mkRes();
    await ownerReengage(cronReq(), res3);
    assert(await nudgeAt(dormant.uid) !== null, 'a fresh dormancy episode re-fires after the flag was cleared');

    // Cleanup
    for (const o of [dormant, active, already, partnerOn]) {
      await sql`DELETE FROM bookings WHERE workspace_id = ${o.ws}`;
      await sql`DELETE FROM workspaces WHERE id = ${o.ws}`;
      await sql`DELETE FROM users WHERE id = ${o.uid}`;
    }
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

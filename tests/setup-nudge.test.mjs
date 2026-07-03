// Tests the setup-nudge cron: an onboarded owner (2–30 days ago) with a
// required setup gap gets exactly one nudge; a fully-set-up owner, a too-fresh
// owner, and an already-nudged owner are skipped.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/setup-nudge.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
const { default: setupNudge } = await import('../api/cron/setup-nudge.js');

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
const cronReq = () => ({ method: 'POST', url: '/api/cron/setup-nudge', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

// Onboarded owner. opts: onboardedDaysAgo, verified, complete (full setup), nudged.
async function mkOwner(tag, { onboardedDaysAgo = 3, verified = false, complete = false, nudged = false }) {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, email_verified_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW(), ${verified ? new Date().toISOString() : null})
    RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, onboarded_at, setup_nudge_sent_at)
    VALUES (${uid}, 'trialing', NOW() - ${`${onboardedDaysAgo} days`}::interval, ${nudged ? new Date().toISOString() : null})
    RETURNING id`).rows[0].id;
  if (complete) {
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, availability)
      VALUES (${ws}, 'Biz', ${`${tag}-slug`}, ${JSON.stringify({ 1: [{ start: 540, end: 1020 }] })}::jsonb)`;
    await sql`INSERT INTO services (workspace_id, name, duration_minutes, price)
      VALUES (${ws}, 'Svc', 60, 100)`;
  } else {
    // biz_name + slug present but NO service and NO availability → required gap.
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug)
      VALUES (${ws}, 'Biz', ${`${tag}-slug`})`;
  }
  return { uid, ws };
}
const nudgeAt = async (ws) =>
  (await sql`SELECT setup_nudge_sent_at FROM workspaces WHERE id = ${ws}`).rows[0].setup_nudge_sent_at;

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `setup-${Date.now()}`;

    console.log('\n[1] auth gate');
    const noAuth = mkRes();
    await setupNudge({ method: 'POST', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no cron secret → 401 (got ${noAuth.statusCode})`);

    console.log('\n[2] selection');
    const gap    = await mkOwner(`${tag}-gap`,    { onboardedDaysAgo: 3, verified: true, complete: false });
    const done   = await mkOwner(`${tag}-done`,   { onboardedDaysAgo: 3, verified: true, complete: true });
    const fresh  = await mkOwner(`${tag}-fresh`,  { onboardedDaysAgo: 1, verified: true, complete: false });
    const already = await mkOwner(`${tag}-already`, { onboardedDaysAgo: 3, verified: true, complete: false, nudged: true });

    const res1 = mkRes();
    await setupNudge(cronReq(), res1);
    assert(res1.statusCode === 200, `cron ok (got ${res1.statusCode})`);
    assert(await nudgeAt(gap.ws) !== null, 'owner with a required gap gets nudged');
    assert(await nudgeAt(done.ws) === null, 'fully-set-up owner is NOT nudged');
    assert(await nudgeAt(fresh.ws) === null, 'too-fresh owner (<2 days) is NOT selected');
    assert(await nudgeAt(already.ws) !== null, 'already-nudged owner stays stamped (skipped)');

    console.log('\n[3] second run does not re-fire');
    const before = await nudgeAt(gap.ws);
    await setupNudge(cronReq(), mkRes());
    assert(String(before) === String(await nudgeAt(gap.ws)), 'gap owner not re-stamped on a second run');

    // Cleanup
    for (const o of [gap, done, fresh, already]) {
      await sql`DELETE FROM services WHERE workspace_id = ${o.ws}`;
      await sql`DELETE FROM calendar_settings WHERE workspace_id = ${o.ws}`;
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

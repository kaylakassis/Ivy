// Tier 0 retention foundation: the throttled last_active_at stamp (the exact
// guarded UPDATE requireUser fires) and the owner DAU/WAU/MAU recency queries.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/retention-activity.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const mkOwner = async (tag, activeAgo /* interval string | null */) => {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO workspaces (owner_id) VALUES (${uid})`;
  if (activeAgo) await sql`UPDATE users SET last_active_at = NOW() - ${activeAgo}::interval WHERE id = ${uid}`;
  return uid;
};

// Owner-recency count for a window (mirrors admin analytics).
const activeOwners = async (days) =>
  Number((await sql.query(
    `SELECT COUNT(*)::int AS n FROM users u
       WHERE u.last_active_at >= NOW() - ($1::int || ' days')::interval
         AND EXISTS (SELECT 1 FROM workspaces ws WHERE ws.owner_id = u.id)`,
    [days],
  )).rows[0].n);

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `ret-${Date.now()}`;

    console.log('\n[1] throttled stamp — the guarded UPDATE requireUser fires');
    const uid = await mkOwner(`${tag}-stamp`, '20 minutes');
    await sql`UPDATE users SET dormant_nudge_sent_at = NOW() WHERE id = ${uid}`;
    // First fire: last_active_at is 20 min old (> 10 min) → updates + clears the nudge flag.
    const first = await sql`
      UPDATE users SET last_active_at = NOW(), dormant_nudge_sent_at = NULL
       WHERE id = ${uid}
         AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '10 minutes')`;
    assert(first.rowCount === 1, 'stale (20m) owner → stamp updates 1 row');
    const after = (await sql`SELECT last_active_at, dormant_nudge_sent_at FROM users WHERE id = ${uid}`).rows[0];
    assert(after.dormant_nudge_sent_at === null, 'returning owner clears dormant_nudge_sent_at');
    assert(Date.now() - new Date(after.last_active_at).getTime() < 5000, 'last_active_at is ~now');
    // Second fire immediately: within the 10-min window → no-op.
    const second = await sql`
      UPDATE users SET last_active_at = NOW(), dormant_nudge_sent_at = NULL
       WHERE id = ${uid}
         AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '10 minutes')`;
    assert(second.rowCount === 0, 'fresh owner → stamp is a no-op (throttled)');

    console.log('\n[2] owner DAU / WAU / MAU from last_active_at');
    const base = { day: await activeOwners(1), week: await activeOwners(7), month: await activeOwners(30) };
    await mkOwner(`${tag}-now`, '1 hour');    // DAU + WAU + MAU
    await mkOwner(`${tag}-3d`, '3 days');      // WAU + MAU
    await mkOwner(`${tag}-20d`, '20 days');    // MAU only
    // A client-only user (no workspace), active now, must NOT count as an owner.
    const clientUid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, last_active_at)
      VALUES (${`${tag}-client@example.com`}, 'x', '2026-05-05', NOW(), NOW()) RETURNING id`).rows[0].id;

    assert(await activeOwners(1)  === base.day + 1,   'DAU counts only the last-24h owner');
    assert(await activeOwners(7)  === base.week + 2,  'WAU counts the 1h + 3d owners');
    assert(await activeOwners(30) === base.month + 3, 'MAU counts 1h + 3d + 20d owners');

    // Cleanup
    await sql`DELETE FROM workspaces WHERE owner_id IN (SELECT id FROM users WHERE email LIKE ${`${tag}-%`})`;
    await sql`DELETE FROM users WHERE email LIKE ${`${tag}-%`} OR id = ${clientUid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

// Tests the added milestones: celebrateFirstClient (ignores demo clients) and
// celebrateFirstReview — each fires exactly once into the owner's feed.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/milestones-more.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { celebrateFirstClient, celebrateFirstReview } from '../api/_lib/milestones.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const countNotif = async (uid, tag) =>
  Number((await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${uid} AND tag = ${tag}`).rows[0].n);

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `msx-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;

    console.log('\n[1] first client (ignores demo)');
    await sql`INSERT INTO clients (workspace_id, name, source, stage) VALUES (${ws}, 'Demo', 'demo', 'active')`;
    await celebrateFirstClient(ws);
    assert(await countNotif(uid, 'milestone-first-client') === 0, 'demo client does not trigger');
    const cid = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${ws}, 'Real', 'active') RETURNING id`).rows[0].id;
    await celebrateFirstClient(ws);
    assert(await countNotif(uid, 'milestone-first-client') === 1, 'first real client fires once');
    await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${ws}, 'Second', 'active')`;
    await celebrateFirstClient(ws);
    assert(await countNotif(uid, 'milestone-first-client') === 1, 'second client does not re-fire');

    console.log('\n[2] first review');
    await celebrateFirstReview(ws);
    assert(await countNotif(uid, 'milestone-first-review') === 0, 'no review, no milestone');
    await sql`INSERT INTO reviews (workspace_id, client_id, reviewer_name, rating, status)
      VALUES (${ws}, ${cid}, 'Real', 5, 'visible')`;
    await celebrateFirstReview(ws);
    assert(await countNotif(uid, 'milestone-first-review') === 1, 'first review fires once');
    await sql`INSERT INTO reviews (workspace_id, client_id, reviewer_name, rating, status)
      VALUES (${ws}, ${cid}, 'Real', 4, 'visible')`;
    await celebrateFirstReview(ws);
    assert(await countNotif(uid, 'milestone-first-review') === 1, 'second review does not re-fire');

    await sql`DELETE FROM reviews WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM notifications WHERE user_id = ${uid}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    await sql`DELETE FROM users WHERE id = ${uid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

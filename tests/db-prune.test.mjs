// db-prune retention sweep: old notifications (>60d) and ivy_usage (>90d) rows
// are deleted while recent rows survive. (Guards the unbounded-growth fix.)
//
// Run: node --import ./tests/bootstrap.mjs ./tests/db-prune.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
const { default: dbPrune } = await import('../api/cron/db-prune.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return { statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader() {}, json(o) { this.body = o; return this; }, end() { return this; } };
}
const cronReq = () => ({ method: 'POST', url: '/api/cron/db-prune', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
const exists = async (table, id) => Number((await sql.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE id = $1`, [id])).rows[0].n) > 0;

async function run() {
  let uid, ws;
  try {
    await ensureSchemaApplied();
    const tag = `prune-${Date.now()}`;
    uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;

    // Notifications: one 70 days old (doomed), one now (kept).
    const oldNote = (await sql`INSERT INTO notifications (user_id, title, created_at)
      VALUES (${uid}, 'old', NOW() - INTERVAL '70 days') RETURNING id`).rows[0].id;
    const newNote = (await sql`INSERT INTO notifications (user_id, title, created_at)
      VALUES (${uid}, 'new', NOW()) RETURNING id`).rows[0].id;

    // ivy_usage: one 100 days old (doomed), one today (kept). PK is
    // (workspace_id, day, model) so distinct days are distinct rows.
    await sql`INSERT INTO ivy_usage (workspace_id, day, model, output_tokens)
      VALUES (${ws}, CURRENT_DATE - 100, 'm', 1)`;
    await sql`INSERT INTO ivy_usage (workspace_id, day, model, output_tokens)
      VALUES (${ws}, CURRENT_DATE, 'm', 1)`;

    console.log('\n[1] cron runs (auth ok)');
    const res = mkRes();
    await dbPrune(cronReq(), res);
    assert(res.statusCode === 200, `db-prune ok (got ${res.statusCode})`);
    assert(res.body?.results?.notifications && res.body.results.ivyUsage, 'reports notifications + ivyUsage results');

    console.log('\n[2] old rows pruned, recent rows kept');
    assert(!(await exists('notifications', oldNote)), '70-day-old notification is pruned');
    assert(await exists('notifications', newNote), 'a fresh notification survives');
    const oldUsage = Number((await sql`SELECT COUNT(*)::int AS n FROM ivy_usage WHERE workspace_id = ${ws} AND day = CURRENT_DATE - 100`).rows[0].n);
    const newUsage = Number((await sql`SELECT COUNT(*)::int AS n FROM ivy_usage WHERE workspace_id = ${ws} AND day = CURRENT_DATE`).rows[0].n);
    assert(oldUsage === 0, '100-day-old ivy_usage row is pruned');
    assert(newUsage === 1, "today's ivy_usage row survives");

    console.log('\n[3] auth gate');
    const noAuth = mkRes();
    await dbPrune({ method: 'POST', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no cron secret → 401 (got ${noAuth.statusCode})`);
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (uid) await sql`DELETE FROM notifications WHERE user_id = ${uid}`;
    if (ws) await sql`DELETE FROM ivy_usage WHERE workspace_id = ${ws}`;
    if (ws) await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    if (uid) await sql`DELETE FROM users WHERE id = ${uid}`;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

// Behavior tests for the subscription dunning cron: past_due
// timestamping, dunning email cadence, suspension after grace.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/subscription-dunning.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import dunningHandler from '../api/cron/subscription-dunning.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

function mkReq() {
  return {
    method: 'POST',
    url: '/api/cron/subscription-dunning',
    query: {}, body: {},
    headers: {
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-admin-secret': process.env.ADMIN_SECRET || 'test-admin-secret',
      'x-forwarded-for': '198.51.100.50',
    },
  };
}
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}

async function mkWorkspace(label, daysAgo, dunnedHoursAgo = null) {
  const u = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`dunn-${label}-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id
  `;
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${u.rows[0].id}) RETURNING id`;
  const ws = w.rows[0].id;
  await sql.query(
    `UPDATE workspaces SET
       subscription_status = 'past_due',
       subscription_past_due_since = NOW() - INTERVAL '${daysAgo} days',
       subscription_failed_attempts = 1,
       subscription_last_dunning_at = ${dunnedHoursAgo != null ? `NOW() - INTERVAL '${dunnedHoursAgo} hours'` : 'NULL'}
     WHERE id = $1`,
    [ws],
  );
  return { ws, userId: u.rows[0].id };
}

async function run() {
  try {
    await ensureSchemaApplied();
    process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret';

    console.log('\n[1] Dunning cron classifies workspaces correctly');
    const a = await mkWorkspace('A', 20, null);   // suspend
    const b = await mkWorkspace('B', 3, null);    // dun (fresh)
    const c = await mkWorkspace('C', 3, 4);       // skip (dunned 4h ago)
    const d = await mkWorkspace('D', 30, null);   // suspend (well past grace)

    const res = mkRes();
    await dunningHandler(mkReq(), res);
    assert(res.statusCode === 200, 'cron returns 200');
    assert(res.body.suspended >= 2, `suspended ≥ 2 (got ${res.body.suspended})`);
    assert(res.body.dunned >= 1, `dunned ≥ 1 (got ${res.body.dunned})`);

    const states = await sql`
      SELECT id, subscription_status, subscription_suspended_at, subscription_last_dunning_at
      FROM workspaces WHERE id = ANY(ARRAY[${a.ws}::uuid, ${b.ws}::uuid, ${c.ws}::uuid, ${d.ws}::uuid])
    `;
    const byId = new Map(states.rows.map((r) => [r.id, r]));

    assert(byId.get(a.ws).subscription_status === 'suspended', 'A (20d past_due) → suspended');
    assert(byId.get(a.ws).subscription_suspended_at != null,    'A has suspended_at stamp');
    assert(byId.get(d.ws).subscription_status === 'suspended', 'D (30d past_due) → suspended');

    assert(byId.get(b.ws).subscription_status === 'past_due',   'B (3d, never dunned) → still past_due');
    assert(byId.get(b.ws).subscription_suspended_at == null,    'B not suspended');
    assert(byId.get(b.ws).subscription_last_dunning_at != null, 'B got a fresh dunning timestamp');

    assert(byId.get(c.ws).subscription_status === 'past_due',   'C (3d, dunned 4h ago) → still past_due');
    // C's last_dunning_at was set by mkWorkspace 4h ago and shouldn't
    // have been refreshed; we check that the existing value is >3.5h
    // old (i.e. the cron didn't update it).
    const cAgeHrs = (Date.now() - new Date(byId.get(c.ws).subscription_last_dunning_at).getTime()) / 3600000;
    assert(cAgeHrs > 3.5, `C's dunning timestamp unchanged (age ${cAgeHrs.toFixed(2)}h)`);

    console.log('\n[2] Cron is idempotent across runs');
    const res2 = mkRes();
    await dunningHandler(mkReq(), res2);
    assert(res2.statusCode === 200, 'second run returns 200');
    // After the first run, A + D are already suspended → second run
    // shouldn't suspend them again. B is now also dunned → shouldn't
    // re-dun within 24h.
    assert(res2.body.suspended === 0, 'second run suspends 0');
    assert(res2.body.dunned === 0, 'second run dunns 0');

    // Cleanup
    for (const x of [a, b, c, d]) {
      await sql`DELETE FROM workspaces WHERE id = ${x.ws}`;
      await sql`DELETE FROM users WHERE id = ${x.userId}`;
    }
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

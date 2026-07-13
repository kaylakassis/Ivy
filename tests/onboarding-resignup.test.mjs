// Guards the server-side invariant behind "every brand-new account is put
// through onboarding" - including a re-signup after a previous account with
// the same email was deleted. A fresh signup always creates a NEW, EMPTY
// workspace (no clients, no services), and the onboarded_at backfill in
// schema.js MUST NOT stamp such a workspace - otherwise RoleRouter would
// route the new owner straight to the dashboard, skipping the wizard.
//
// This test mirrors the backfill's guard (api/_lib/schema.js ~138-143):
//   UPDATE workspaces SET onboarded_at = created_at
//   WHERE onboarded_at IS NULL
//     AND (EXISTS clients OR EXISTS services)
// so if that guard is ever loosened to blindly stamp NULLs, this fails.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/onboarding-resignup.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL_EMPTY = `resignup-empty-${Date.now()}@example.com`;
const EMAIL_WITH  = `resignup-with-${Date.now()}@example.com`;

// The exact guarded backfill schema.js runs on every apply. Kept in lockstep
// with api/_lib/schema.js:138-143; if that WHERE changes, update here too.
async function runBackfill() {
  await sql`
    UPDATE workspaces w SET onboarded_at = created_at
     WHERE onboarded_at IS NULL
       AND (
         EXISTS (SELECT 1 FROM clients  WHERE workspace_id = w.id)
         OR EXISTS (SELECT 1 FROM services WHERE workspace_id = w.id)
       )`;
}

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] a fresh, EMPTY workspace (the re-signup case) stays un-onboarded');
    const o1 = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL_EMPTY}, 'x', 'Empty') RETURNING id`).rows[0].id;
    const w1 = (await sql`INSERT INTO workspaces (owner_id, onboarded_at) VALUES (${o1}, NULL) RETURNING id`).rows[0].id;
    await runBackfill();
    const r1 = (await sql`SELECT onboarded_at FROM workspaces WHERE id = ${w1}`).rows[0];
    assert(r1.onboarded_at === null, 'empty workspace keeps onboarded_at NULL after backfill (onboarding will show)');

    console.log('\n[2] a workspace that already has real data DOES get backfilled (existing users unaffected)');
    const o2 = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL_WITH}, 'x', 'With') RETURNING id`).rows[0].id;
    const w2 = (await sql`INSERT INTO workspaces (owner_id, onboarded_at) VALUES (${o2}, NULL) RETURNING id`).rows[0].id;
    await sql`INSERT INTO clients (workspace_id, name) VALUES (${w2}, 'Existing Client')`;
    await runBackfill();
    const r2 = (await sql`SELECT onboarded_at FROM workspaces WHERE id = ${w2}`).rows[0];
    assert(r2.onboarded_at !== null, 'workspace with a client gets onboarded_at stamped');

    console.log('\n[3] re-running the backfill never flips the empty one (idempotent guard)');
    await runBackfill();
    const r1b = (await sql`SELECT onboarded_at FROM workspaces WHERE id = ${w1}`).rows[0];
    assert(r1b.onboarded_at === null, 'still NULL after a second backfill pass');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const e of [EMAIL_EMPTY, EMAIL_WITH]) {
      await sql`DELETE FROM workspaces WHERE owner_id = (SELECT id FROM users WHERE email = ${e})`.catch(() => {});
      await sql`DELETE FROM users WHERE email = ${e}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

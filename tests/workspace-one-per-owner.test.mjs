// One workspace per owner: parallel first requests after signup must not
// create two (the Admin > Users list showed such people twice), and every
// owner lookup picks the same (oldest) workspace.
import { sql } from '../api/_lib/db.js';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { ensureWorkspace } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

await ensureSchemaApplied();
const tag = `wsone-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const u = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`${tag}@example.com`}, 'x', 'Irene Test') RETURNING id`).rows[0];
try {
  console.log('\n[1] ten parallel first requests create one workspace');
  const ids = await Promise.all(Array.from({ length: 10 }, () => ensureWorkspace(u.id)));
  const rows = (await sql`SELECT id FROM workspaces WHERE owner_id = ${u.id}`).rows;
  assert(rows.length === 1, `exactly one workspace (got ${rows.length})`);
  assert(new Set(ids).size === 1 && ids[0] === rows[0].id, 'every caller got that same workspace');

  console.log('\n[2] later calls return it');
  assert(await ensureWorkspace(u.id) === rows[0].id, 'stable on repeat');

  console.log('\n[3] the unique index exists on a clean database');
  const idx = await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_workspaces_owner'`;
  assert(idx.rows.length === 1, 'uq_workspaces_owner present');
} finally {
  await sql`DELETE FROM users WHERE id = ${u.id}`;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

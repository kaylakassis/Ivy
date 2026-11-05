// Ivy's add_client follows the same one-person-one-record rule as the Add
// client form: an existing email (or phone when no email) is not added again.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-add-client-dupe.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

await ensureSchemaApplied();
const tag = `ivydupe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const mk = async (n) => {
  const u = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`${tag}-${n}@example.com`}, 'x', 'O') RETURNING id`).rows[0].id;
  const w = (await sql`INSERT INTO workspaces (owner_id) VALUES (${u}) RETURNING id`).rows[0].id;
  return { u, w };
};
const A = await mk('a'); const B = await mk('b');
const count = async (w) => (await sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${w}`).rows[0].n;
try {
  let r = await executeIvyTool('add_client', { name: 'Jane Doe', email: 'Jane@Example.com', phone: '(555) 201-0101' }, { workspaceId: A.w });
  assert(!r.error && (await count(A.w)) === 1, 'first add creates the client');
  r = await executeIvyTool('add_client', { name: 'Jane D.', email: 'jane@example.com' }, { workspaceId: A.w });
  assert(r.error && /already a client/.test(r.error) && (await count(A.w)) === 1, 'same email (any case) is refused, nothing added');
  r = await executeIvyTool('add_client', { name: 'Janie', phone: '555-201-0101' }, { workspaceId: A.w });
  assert(r.error && /phone number/.test(r.error) && (await count(A.w)) === 1, 'same phone in another format (no email) is refused');
  r = await executeIvyTool('add_client', { name: 'Jane Doe', email: 'jane@example.com' }, { workspaceId: B.w });
  assert(!r.error && (await count(B.w)) === 1, 'another business can have the same person');
  r = await executeIvyTool('add_client', { name: 'Sam', email: 'sam@example.com' }, { workspaceId: A.w });
  assert(!r.error && (await count(A.w)) === 2, 'a different person is added');
} finally {
  await sql`DELETE FROM users WHERE id IN (${A.u}, ${B.u})`;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

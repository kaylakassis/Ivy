// /api/me must carry ctx.owns with every field the app reads from it.
// Before this existed, the iPhone purchase identity (identifyIapUser) and
// the notifications prompt read ctx.owns.* and always got undefined, so no
// iPhone user could subscribe and the push prompt never appeared.
// Run: node --import ./tests/bootstrap.mjs ./tests/me-owns.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { userContext } from '../api/_lib/clientPortal.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`owns-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING *`;
  const owner = u.rows[0];
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at, business_type) VALUES (${owner.id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW(), 'service') RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${w.rows[0].id}, 'Glow Studio', ${`glow-${S}`}) ON CONFLICT (workspace_id) DO UPDATE SET biz_name = 'Glow Studio'`;

  console.log('\n[1] owner context carries owns with the workspace id');
  const ctx = await userContext(owner);
  assert(ctx.isOwner === true, 'isOwner');
  assert(!!ctx.owns && ctx.owns.id === w.rows[0].id, `owns.id is the workspace id (${ctx.owns?.id})`);
  assert(ctx.owns.id === ctx.workspaceId, 'owns.id matches workspaceId');
  assert(ctx.owns.businessType === 'service', `owns.businessType (${ctx.owns.businessType})`);
  assert(ctx.owns.bizName === 'Glow Studio' && ctx.owns.name === 'Glow Studio', 'owns.bizName / name');
  assert(!!ctx.owns.onboardedAt, 'owns.onboardedAt');
  assert(typeof ctx.owns.hasBillingRecord === 'boolean', 'owns.hasBillingRecord');

  console.log('\n[2] a client-only user has no owns');
  const c = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`client-${S}@example.com`}, 'x', 'Client', NOW()) RETURNING *`;
  const cctx = await userContext(c.rows[0]);
  assert(cctx.owns === null && cctx.isOwner === false, 'owns is null');

  console.log('\n[3] every ctx.owns.<field> the app reads exists in the payload');
  const fields = new Set();
  for (const f of walk('src')) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bowns\??\.([A-Za-z_]+)/g)) fields.add(m[1]);
  }
  assert(fields.size > 0, `app reads ${[...fields].sort().join(', ')}`);
  const missing = [...fields].filter((k) => !(k in ctx.owns));
  assert(missing.length === 0, `all present${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });

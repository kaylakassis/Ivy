// The whole schema must build on a brand-new, empty database.
//
// The shared test database already has every table, so a schema statement
// that is broken (for example two CREATE TABLE blocks tangled together by a
// merge) can pass every other suite and still fail for a fresh install or a
// restored backup. This suite creates a throwaway database, runs the real
// bootstrap against it in a separate process, and checks that every
// statement applied and the key tables and views exist.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/fresh-schema.test.mjs
import { execFileSync } from 'node:child_process';
import { sql } from '../api/_lib/db.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const base = process.env.DATABASE_URL || 'postgres://ivy_test:test@localhost:5432/ivy_test';
const name = `ivy_fresh_${process.pid}_${Date.now()}`;
const freshUrl = base.replace(/\/[^/?]+(\?.*)?$/, (_m, q) => `/${name}${q || ''}`);

const probe = `
  const { ensureSchemaApplied } = await import('./api/_lib/ensureSchema.js');
  const { sql } = await import('./api/_lib/db.js');
  await ensureSchemaApplied();
  const t = await sql\`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'\`;
  const missing = await sql\`SELECT COUNT(*)::int AS n FROM schema_migrations WHERE applied IS NOT TRUE\`;
  console.log('RESULT ' + JSON.stringify({ tables: t.rows.map((r) => r.table_name), unapplied: missing.rows[0].n }));
  process.exit(0);
`;

async function run() {
  let created = false;
  try {
    await sql.query(`CREATE DATABASE ${name}`);
    created = true;
    const out = execFileSync(process.execPath, ['--import', './tests/bootstrap.mjs', '--input-type=module', '-e', probe], {
      env: { ...process.env, DATABASE_URL: freshUrl },
      encoding: 'utf8',
      timeout: 240_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    assert(!!line, 'bootstrap ran to completion on an empty database');
    const res = line ? JSON.parse(line.slice(7)) : { tables: [], unapplied: -1 };
    assert(res.unapplied === 0, `every schema statement applied (unapplied: ${res.unapplied})`);
    for (const t of ['users', 'workspaces', 'invoices', 'programs', 'program_modules', 'program_events',
      'program_progress', 'program_cohorts', 'program_coupons', 'program_checkin_forms', 'ivy_pending_actions', 'helper_invites']) {
      assert(res.tables.includes(t), `table ${t} exists`);
    }
    for (const v of ['workspace_revenue', 'admin_real_users']) {
      assert(res.tables.includes(v), `view ${v} exists`);
    }
  } catch (err) {
    console.error('Fatal:', err.message, err.stdout || '', err.stderr ? String(err.stderr).slice(-2000) : '');
    fail++;
  } finally {
    if (created) {
      try {
        await sql.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
        await sql.query(`DROP DATABASE IF EXISTS ${name}`);
      } catch (e) { console.error('cleanup:', e.message); }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

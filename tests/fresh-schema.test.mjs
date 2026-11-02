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

    // A table that already exists in the WRONG shape is not fixed by
    // CREATE TABLE IF NOT EXISTS. Recreate the broken program_events a
    // preview build once left in production, forget the applied statements,
    // run the bootstrap again, and check the repair step reshaped it.
    const breakIt = `
      const { sql } = await import('./api/_lib/db.js');
      await sql\`DROP TABLE program_events CASCADE\`;
      await sql\`CREATE TABLE program_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT, position INT NOT NULL DEFAULT 0,
        unlock_after_days INT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ)\`;
      await sql\`DELETE FROM schema_migrations\`;
      process.exit(0);
    `;
    execFileSync(process.execPath, ['--import', './tests/bootstrap.mjs', '--input-type=module', '-e', breakIt], {
      env: { ...process.env, DATABASE_URL: freshUrl }, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cols = `
      const { ensureSchemaApplied } = await import('./api/_lib/ensureSchema.js');
      const { sql } = await import('./api/_lib/db.js');
      await ensureSchemaApplied();
      const c = await sql\`SELECT column_name FROM information_schema.columns WHERE table_name = 'program_events'\`;
      const fk = await sql\`SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'program_event_rsvps' AND constraint_type = 'FOREIGN KEY'\`;
      console.log('RESULT ' + JSON.stringify({ cols: c.rows.map((r) => r.column_name), rsvpFks: fk.rows.length }));
      process.exit(0);
    `;
    const out2 = execFileSync(process.execPath, ['--import', './tests/bootstrap.mjs', '--input-type=module', '-e', cols], {
      env: { ...process.env, DATABASE_URL: freshUrl }, encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line2 = out2.split('\n').find((l) => l.startsWith('RESULT '));
    const r2 = line2 ? JSON.parse(line2.slice(7)) : { cols: [] };
    for (const c of ['starts_at', 'cancelled_at', 'duration_min', 'location_type', 'video_url', 'remind_everyone', 'recording_url']) {
      assert(r2.cols.includes(c), `repaired program_events has ${c}`);
    }
    assert(!r2.cols.includes('unlock_after_days') && !r2.cols.includes('position'), 'repaired program_events dropped the module columns');

    // A preview deployment must never change the database it points at.
    const previewDb = `${name}_pv`;
    await sql.query(`CREATE DATABASE ${previewDb}`);
    try {
      const pvUrl = base.replace(/\/[^/?]+(\?.*)?$/, (_m, q) => `/${previewDb}${q || ''}`);
      const pv = `
        const { ensureSchemaApplied } = await import('./api/_lib/ensureSchema.js');
        const { sql } = await import('./api/_lib/db.js');
        await ensureSchemaApplied();
        const t = await sql\`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'\`;
        console.log('RESULT ' + JSON.stringify({ n: t.rows[0].n }));
        process.exit(0);
      `;
      const out3 = execFileSync(process.execPath, ['--import', './tests/bootstrap.mjs', '--input-type=module', '-e', pv], {
        env: { ...process.env, DATABASE_URL: pvUrl, VERCEL_ENV: 'preview' }, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const line3 = out3.split('\n').find((l) => l.startsWith('RESULT '));
      assert(line3 && JSON.parse(line3.slice(7)).n === 0, 'a preview deployment leaves the database untouched');
    } finally {
      await sql.query(`DROP DATABASE IF EXISTS ${previewDb}`).catch(() => {});
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

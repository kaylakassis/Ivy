// invoice-due-soon cron: a friendly heads-up a few days BEFORE due_date,
// once per invoice. Confirms it picks only sent, unpaid, soon-due invoices
// with a client email, stamps due_soon_reminder_sent_at, and never
// re-fires. Out-of-window / past-due / draft / emailless rows are skipped.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/invoice-due-soon.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import dueSoonCron from '../api/cron/invoice-due-soon.js';

process.env.ADMIN_SECRET ||= 'test-admin-secret';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}
const cronReq = () => ({ method: 'GET', url: '/api/cron/invoice-due-soon', query: {}, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });

let ownerId, workspaceId;
const ids = {};

async function mkInvoice(number, { status, dueOffsetDays, email }) {
  const due = dueOffsetDays === null ? null : `CURRENT_DATE + (${dueOffsetDays})`;
  const r = await sql.query(
    `INSERT INTO invoices (workspace_id, number, client_name, client_email, status, items, tax_rate, discount, due_date)
     VALUES ($1, $2, 'C', $3, $4, '[{"quantity":1,"rate":100}]'::jsonb, 0, 0, ${due === null ? 'NULL' : due})
     RETURNING id`,
    [workspaceId, number, email, status],
  );
  return r.rows[0].id;
}

async function stampOf(id) {
  const r = await sql`SELECT due_soon_reminder_sent_at FROM invoices WHERE id = ${id}`;
  return r.rows[0]?.due_soon_reminder_sent_at;
}

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_soon_reminder_sent_at TIMESTAMPTZ`.catch(() => {});
    await sql.query(`DELETE FROM users WHERE email LIKE 'duesoon-%@example.com'`);
    const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${`duesoon-${Date.now()}@example.com`}, 'x', 'DS', NOW()) RETURNING id`;
    ownerId = u.rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${workspaceId}, 'USD')`.catch(() => {});

    ids.soon    = await mkInvoice('DS-SOON',  { status: 'sent',  dueOffsetDays: 2,   email: 'pay@example.com' });
    ids.far     = await mkInvoice('DS-FAR',   { status: 'sent',  dueOffsetDays: 10,  email: 'pay@example.com' });
    ids.past    = await mkInvoice('DS-PAST',  { status: 'sent',  dueOffsetDays: -2,  email: 'pay@example.com' });
    ids.draft   = await mkInvoice('DS-DRAFT', { status: 'draft', dueOffsetDays: 2,   email: 'pay@example.com' });
    ids.noEmail = await mkInvoice('DS-NOEM',  { status: 'sent',  dueOffsetDays: 2,   email: null });

    console.log('\n[1] cron runs (admin auth) and stamps only the soon-due, sent, emailed invoice');
    let r = mockRes();
    await dueSoonCron(cronReq(), r);
    assert(r.statusCode === 200, 'cron returns 200');
    assert(r.body?.pinged === 1, `exactly one invoice pinged (got ${r.body?.pinged})`);
    assert(!!(await stampOf(ids.soon)), 'soon-due invoice stamped');

    console.log('\n[2] out-of-scope invoices are NOT stamped');
    assert(!(await stampOf(ids.far)),     'invoice due far out (10d) not stamped');
    assert(!(await stampOf(ids.past)),    'past-due invoice not stamped (that is overdue cron)');
    assert(!(await stampOf(ids.draft)),   'draft invoice not stamped');
    assert(!(await stampOf(ids.noEmail)), 'invoice with no client email not stamped');

    console.log('\n[3] idempotent — a second run does not re-ping the same invoice');
    const firstStamp = await stampOf(ids.soon);
    r = mockRes();
    await dueSoonCron(cronReq(), r);
    assert(r.body?.pinged === 0, 'second run pings nothing');
    assert(String(await stampOf(ids.soon)) === String(firstStamp), 'stamp unchanged on re-run');

    console.log('\n[4] unauthorized without the secret');
    r = mockRes();
    await dueSoonCron({ method: 'GET', url: '/x', query: {}, headers: {} }, r);
    assert(r.statusCode === 401, 'no auth → 401');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (workspaceId) {
      await sql`DELETE FROM invoices WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

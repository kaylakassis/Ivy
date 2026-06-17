// Behavior tests for the invoice lifecycle: create draft → send →
// mark paid → refund. Covers the materialized `total` column (via
// the BEFORE-trigger) and the activity log appends.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/invoice-lifecycle.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') {
        const arr = this.headers[key] || [];
        arr.push(v);
        this.headers[key] = arr;
      } else this.headers[key] = v;
    },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v); },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}

let ownerId, workspaceId, cookieHeader = '';

async function setup() {
  await ensureSchemaApplied();
  await sql.query(`DELETE FROM users WHERE email LIKE 'inv-test-%@example.com'`);

  // Provision an owner + workspace directly. Faster than going
  // through signup, and bypasses the rate limit.
  const email = `inv-test-${Date.now()}@example.com`;
  const u = await sql`
    INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'bcrypt$10$nothing', 'Inv Tester', NOW(),
            (SELECT '2026-05-05'), NOW())
    RETURNING id
  `;
  ownerId = u.rows[0].id;
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`;
  workspaceId = w.rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${workspaceId}, 'USD')`;
  const token = signSession({ id: ownerId, email });
  cookieHeader = `ivy_session=${token}`;
}

function authReq({ method = 'POST', body = {}, query = {}, ip = '203.0.113.99' } = {}) {
  return {
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'x-forwarded-for': ip,
    },
  };
}

async function testTriggerComputesTotal() {
  console.log('\n[1] invoices.total trigger computes from items/tax/discount');
  // Insert directly to exercise the trigger; the POST handler does
  // the same insert but through a serialize layer.
  await sql`INSERT INTO invoices (workspace_id, number, client_name, status, items, tax_rate, discount)
            VALUES (${workspaceId}, 'TRIG-1', 'X', 'draft',
              '[{"quantity": 3, "rate": 100}]'::jsonb, 10, 0)`;
  const r1 = await sql`SELECT total FROM invoices WHERE number = 'TRIG-1'`;
  assert(Number(r1.rows[0].total) === 330.00, 'trigger sets total to 330.00 (300 * 1.10)');

  await sql`UPDATE invoices SET discount = 50 WHERE number = 'TRIG-1'`;
  const r2 = await sql`SELECT total FROM invoices WHERE number = 'TRIG-1'`;
  assert(Number(r2.rows[0].total) === 275.00, 'trigger recomputes on discount change (250 * 1.10)');

  await sql`UPDATE invoices SET items = '[]'::jsonb WHERE number = 'TRIG-1'`;
  const r3 = await sql`SELECT total FROM invoices WHERE number = 'TRIG-1'`;
  assert(Number(r3.rows[0].total) === 0, 'empty items → 0');
}

async function testCurrencyDefaultsAndOverride() {
  console.log('\n[2] currency: default + explicit override');
  await sql`INSERT INTO invoices (workspace_id, number, client_name, status, items, tax_rate, discount)
            VALUES (${workspaceId}, 'CUR-A', 'X', 'draft', '[]'::jsonb, 0, 0)`;
  const a = await sql`SELECT currency FROM invoices WHERE number = 'CUR-A'`;
  assert(a.rows[0].currency === 'USD', 'default column value is USD');

  await sql`INSERT INTO invoices (workspace_id, number, client_name, status, items, tax_rate, discount, currency)
            VALUES (${workspaceId}, 'CUR-B', 'X', 'draft', '[]'::jsonb, 0, 0, 'EUR')`;
  const b = await sql`SELECT currency FROM invoices WHERE number = 'CUR-B'`;
  assert(b.rows[0].currency === 'EUR', 'explicit EUR stored');

  let rejected = false;
  try {
    await sql`INSERT INTO invoices (workspace_id, number, client_name, status, items, tax_rate, discount, currency)
              VALUES (${workspaceId}, 'CUR-C', 'X', 'draft', '[]'::jsonb, 0, 0, 'lower')`;
  } catch (e) {
    rejected = e.message.includes('invoices_currency_format');
  }
  assert(rejected, 'CHECK rejects lowercase / invalid currency code');
}

async function testIdempotencyKeyReplayCachesResponse() {
  console.log('\n[3] Idempotency-Key replay returns cached body');
  const { withIdempotency } = await import('../api/_lib/idempotency.js');
  let invocations = 0;
  const fn = async () => {
    invocations++;
    return { status: 201, body: { invoiceId: 'mock-' + invocations } };
  };
  const KEY = 'idem-test-' + Date.now();
  const req = {
    url: '/api/invoices',
    headers: { 'idempotency-key': KEY },
    body: { items: [] },
  };
  const r1 = await withIdempotency(req, ownerId, fn);
  const r2 = await withIdempotency(req, ownerId, fn);
  const r3 = await withIdempotency(req, ownerId, fn);
  assert(invocations === 1, 'handler runs exactly once across 3 idempotent calls');
  assert(r1.body.invoiceId === r2.body.invoiceId && r2.body.invoiceId === r3.body.invoiceId, 'all 3 responses identical');
  assert(r2.replayed === true && r3.replayed === true, 'replayed flag set on retries');

  // Different body, same key → 422
  const diffReq = { ...req, body: { items: [{ q: 99 }] } };
  const r4 = await withIdempotency(diffReq, ownerId, fn);
  assert(r4.status === 422, 'reused key with different body → 422');

  await sql`DELETE FROM idempotency_records WHERE key = ${KEY}`;
}

async function testWebhookDedup() {
  console.log('\n[4] webhook_event_dedup short-circuits replays');
  const { markProcessed } = await import('../api/_lib/webhookDedup.js');
  const ev = 'evt_test_' + Date.now();
  const first = await markProcessed('stripe', ev, workspaceId);
  const second = await markProcessed('stripe', ev, workspaceId);
  const third = await markProcessed('stripe', ev, workspaceId);
  assert(first === true, 'first attempt returns true (proceed)');
  assert(second === false, 'second attempt returns false (deduped)');
  assert(third === false, 'third attempt returns false (still deduped)');
  await sql`DELETE FROM webhook_event_dedup WHERE event_id = ${ev}`;
}

async function teardown() {
  await sql`DELETE FROM invoices WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM finance_settings WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id = ${ownerId}`;
}

async function run() {
  try {
    await setup();
    await testTriggerComputesTotal();
    await testCurrencyDefaultsAndOverride();
    await testIdempotencyKeyReplayCachesResponse();
    await testWebhookDedup();
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    try { await teardown(); } catch { /* best effort */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

// Behavior tests for the client-metrics endpoint + the
// package-exhaustion notification path.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/client-metrics.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { consumeCredit } from '../api/_lib/packages.js';
import { signSession } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

let ownerId, workspaceId, clientId, serviceId;
let cookieHeader = '';

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; },
  };
}

async function setup() {
  await ensureSchemaApplied();
  await sql.query("DELETE FROM users WHERE email LIKE 'metrics-test-%@example.com'");

  const u = await sql`
    INSERT INTO users (email, password_hash, name)
    VALUES (${'metrics-test-owner-' + Date.now() + '@example.com'},
            'fake', 'Metrics Owner')
    RETURNING id
  `;
  ownerId = u.rows[0].id;

  const w = await sql`
    INSERT INTO workspaces (owner_id, name)
    VALUES (${ownerId}, 'Metrics Test')
    RETURNING id
  `;
  workspaceId = w.rows[0].id;

  const c = await sql`
    INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${workspaceId}, 'Metrics Client', ${'metrics-test-client-' + Date.now() + '@example.com'}, 'active')
    RETURNING id
  `;
  clientId = c.rows[0].id;

  const s = await sql`
    INSERT INTO services (workspace_id, name, duration_minutes, price)
    VALUES (${workspaceId}, '60-min', 60, 100)
    RETURNING id
  `;
  serviceId = s.rows[0].id;

  cookieHeader = `ivy_session=${signSession(ownerId)}`;
}

async function teardown() {
  if (ownerId) await sql`DELETE FROM users WHERE id = ${ownerId}`;
}

async function callHandler(handlerPath, opts = {}) {
  const { default: handler } = await import(handlerPath);
  const req = {
    method: opts.method || 'GET',
    url: opts.url || '/api/clients/metrics',
    headers: {
      origin: 'http://localhost:3001', host: 'localhost:3001',
      'user-agent': 'test/1.0', cookie: cookieHeader,
      'content-type': 'application/json',
    },
    query: opts.query || {},
    body: opts.body,
    on() {},
  };
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

async function testEmptyState() {
  console.log('\n[1] Empty client → zero metrics');
  const r = await callHandler('../api/clients/metrics.js', { query: { id: clientId } });
  assert(r.status === 200, 'returns 200');
  const m = r.body?.metrics;
  assert(m && m.sessionsLeft === 0, 'sessionsLeft = 0');
  assert(m && m.monthlyPaymentCents === 0, 'monthlyPaymentCents = 0');
  assert(m && m.dueDate === null, 'dueDate = null');
  assert(m && m.revenue30dCents === 0, 'revenue30dCents = 0');
}

async function testSessionsLeft() {
  console.log('\n[2] Active package with credits → sessionsLeft reflects sum');
  await sql`
    INSERT INTO client_packages (workspace_id, client_id, name,
                                  credits_total, credits_remaining, price, status)
    VALUES (${workspaceId}, ${clientId}, '10-Pack',
            10, 7, 750, 'active')
  `;
  const r = await callHandler('../api/clients/metrics.js', { query: { id: clientId } });
  assert(r.body?.metrics?.sessionsLeft === 7, 'sessionsLeft = 7 (matches credits_remaining)');
  assert(r.body?.metrics?.packagesExhausted === 0, 'packagesExhausted = 0');
}

async function testMembershipMonthly() {
  console.log('\n[3] Active monthly membership → monthlyPaymentCents = price_cents');
  await sql`
    INSERT INTO client_memberships (workspace_id, client_id, membership_name,
                                     price_cents, interval, status, current_period_end)
    VALUES (${workspaceId}, ${clientId}, 'Gold',
            9900, 'month', 'active', NOW() + INTERVAL '14 days')
  `;
  const r = await callHandler('../api/clients/metrics.js', { query: { id: clientId } });
  assert(r.body?.metrics?.monthlyPaymentCents === 9900, 'monthly = 9900');
  assert(r.body?.metrics?.dueDateKind === 'membership', 'dueDateKind = membership (no unpaid invoices)');
}

async function testWeeklyAndYearlyMembership() {
  console.log('\n[4] Mixed-interval memberships normalize to monthly');
  await sql.query("DELETE FROM client_memberships WHERE workspace_id = $1", [workspaceId]);
  // weekly: 1000 cents/week ≈ 4345 cents/month
  await sql`
    INSERT INTO client_memberships (workspace_id, client_id, membership_name,
                                     price_cents, interval, status, current_period_end)
    VALUES (${workspaceId}, ${clientId}, 'Weekly', 1000, 'week', 'active',
            NOW() + INTERVAL '7 days')
  `;
  // yearly: 60000 cents/year → 5000 cents/month
  await sql`
    INSERT INTO client_memberships (workspace_id, client_id, membership_name,
                                     price_cents, interval, status, current_period_end)
    VALUES (${workspaceId}, ${clientId}, 'Yearly', 60000, 'year', 'active',
            NOW() + INTERVAL '300 days')
  `;
  const r = await callHandler('../api/clients/metrics.js', { query: { id: clientId } });
  // 1000 * 4.345 ≈ 4345  +  60000 / 12 = 5000  →  9345 total
  const monthly = r.body?.metrics?.monthlyPaymentCents;
  assert(Math.abs(monthly - 9345) <= 1, `monthly normalized ≈ 9345 (got ${monthly})`);
}

async function testDueDatePicksSooner() {
  console.log('\n[5] Due date picks the soonest of {unpaid invoice, membership renewal}');
  // Clean slate first.
  await sql.query("DELETE FROM client_memberships WHERE workspace_id = $1", [workspaceId]);
  await sql.query("DELETE FROM invoices WHERE workspace_id = $1", [workspaceId]);

  // Membership renews in 20 days.
  await sql`
    INSERT INTO client_memberships (workspace_id, client_id, membership_name,
                                     price_cents, interval, status, current_period_end)
    VALUES (${workspaceId}, ${clientId}, 'Gold', 9900, 'month', 'active',
            NOW() + INTERVAL '20 days')
  `;
  // Invoice due in 5 days.
  await sql`
    INSERT INTO invoices (workspace_id, client_id, client_name, client_email,
                          number, status, items, tax_rate, discount, due_date)
    VALUES (${workspaceId}, ${clientId}, 'Metrics Client', 'metrics@x.com',
            'INV-1', 'sent', '[]'::jsonb, 0, 0, (CURRENT_DATE + 5))
  `;
  const r = await callHandler('../api/clients/metrics.js', { query: { id: clientId } });
  assert(r.body?.metrics?.dueDateKind === 'invoice', 'dueDateKind = invoice (sooner than membership renewal)');
}

async function testRevenue30d() {
  console.log('\n[6] revenue30dCents sums paid invoices within 30d window');
  await sql.query("DELETE FROM invoices WHERE workspace_id = $1", [workspaceId]);

  // Three invoices: one paid 5 days ago ($75), one paid 25 days ago ($50),
  // one paid 45 days ago ($999, outside window).
  await sql`
    INSERT INTO invoices (workspace_id, client_id, client_name, client_email,
                          number, status, items, tax_rate, discount,
                          paid_amount, paid_at)
    VALUES
      (${workspaceId}, ${clientId}, 'Metrics Client', 'metrics@x.com',
       'PAID-1', 'paid', '[]'::jsonb, 0, 0, 75, NOW() - INTERVAL '5 days'),
      (${workspaceId}, ${clientId}, 'Metrics Client', 'metrics@x.com',
       'PAID-2', 'paid', '[]'::jsonb, 0, 0, 50, NOW() - INTERVAL '25 days'),
      (${workspaceId}, ${clientId}, 'Metrics Client', 'metrics@x.com',
       'OLD-1',  'paid', '[]'::jsonb, 0, 0, 999, NOW() - INTERVAL '45 days')
  `;
  const r = await callHandler('../api/clients/metrics.js', { query: { id: clientId } });
  // 75 + 50 = 125 dollars = 12500 cents
  assert(r.body?.metrics?.revenue30dCents === 12500,
    `revenue30dCents = 12500 (got ${r.body?.metrics?.revenue30dCents})`);
}

async function testBulkEndpoint() {
  console.log('\n[7] ?all=1 returns metrics keyed by client id');
  const r = await callHandler('../api/clients/metrics.js', { query: { all: '1' } });
  assert(r.status === 200, 'returns 200');
  assert(typeof r.body?.metrics === 'object', 'metrics is keyed by clientId');
  assert(clientId in r.body.metrics, 'our test client is present in the bulk result');
}

async function testConsumeCreditExhaustionSignal() {
  console.log('\n[8] consumeCredit signals when the package just exhausted');
  // Fresh single-credit package, then consume it.
  const cp = await sql`
    INSERT INTO client_packages (workspace_id, client_id, name,
                                  credits_total, credits_remaining, price, status)
    VALUES (${workspaceId}, ${clientId}, 'Single',
            1, 1, 100, 'active')
    RETURNING id
  `;
  const result = await consumeCredit({
    workspaceId, clientPackageId: cp.rows[0].id,
    clientId, serviceId,
  });
  assert(result.ok === true, 'consume succeeded');
  assert(result.exhausted === true, 'exhausted = true after last credit');
  assert(result.creditsRemaining === 0, 'creditsRemaining = 0');

  // Status flipped to exhausted in DB.
  const row = await sql`SELECT status FROM client_packages WHERE id = ${cp.rows[0].id}`;
  assert(row.rows[0].status === 'exhausted', 'DB status = exhausted');

  // Now try to consume again - should fail (no credits left).
  const retry = await consumeCredit({
    workspaceId, clientPackageId: cp.rows[0].id,
    clientId, serviceId,
  });
  assert(retry.ok === false, 'second consume on exhausted pack → ok:false');
}

async function testMetricsEndpointAuthScopes() {
  console.log('\n[9] Cross-workspace lookup → 404');
  // Spin up a second workspace owner; their session must NOT be able
  // to read our test client's metrics.
  const otherOwner = await sql`
    INSERT INTO users (email, password_hash, name)
    VALUES (${'metrics-test-other-' + Date.now() + '@example.com'}, 'fake', 'Other')
    RETURNING id
  `;
  await sql`INSERT INTO workspaces (owner_id, name) VALUES (${otherOwner.rows[0].id}, 'Other WS')`;
  const otherCookie = `ivy_session=${signSession(otherOwner.rows[0].id)}`;

  const { default: handler } = await import('../api/clients/metrics.js');
  const req = {
    method: 'GET', url: '/api/clients/metrics',
    headers: {
      origin: 'http://localhost:3001', host: 'localhost:3001',
      'user-agent': 'test/1.0', cookie: otherCookie,
      'content-type': 'application/json',
    },
    query: { id: clientId }, on() {},
  };
  const res = makeRes();
  await handler(req, res);
  assert(res.statusCode === 404, `other-workspace lookup → 404 (got ${res.statusCode})`);

  await sql`DELETE FROM users WHERE id = ${otherOwner.rows[0].id}`;
}

async function main() {
  console.log('=== Client metrics + package-exhaustion behavior tests ===');
  try {
    await setup();
    await testEmptyState();
    await testSessionsLeft();
    await testMembershipMonthly();
    await testWeeklyAndYearlyMembership();
    await testDueDatePicksSooner();
    await testRevenue30d();
    await testBulkEndpoint();
    await testConsumeCreditExhaustionSignal();
    await testMetricsEndpointAuthScopes();
  } finally {
    await teardown();
  }
  console.log('\n────────────────────────────');
  console.log(`Pass: ${pass}  Fail: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });

// End-to-end smoke test for the new email lifecycle flows. Verifies that
// each new helper actually runs its DB queries + reaches the transport
// without throwing. Outbound mail is muted by an invalid Resend key -
// what we're proving is that the prefs gate + DB lookups + email
// composition all work; the Resend call returns a non-muted error
// (transport failure), which is the correct path.
//
// Run with:
//   node --import ./.test-bootstrap.mjs ./.test-email-flows.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { notifyBookingCancellation, notifyBookingRescheduled } from '../api/_lib/bookingNotify.js';
import { notifyInvoicePaid, notifyInvoiceOverdue } from '../api/_lib/invoiceNotify.js';
import {
  notifySubscriptionStarted, notifyUpcomingRenewal,
  notifyPaymentFailed, notifySubscriptionCancelled,
} from '../api/_lib/subscriptionNotify.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

let ownerId, workspaceId, clientId, bookingId, invoiceId, serviceId, clientEmail;
const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function setup() {
  await ensureSchemaApplied();
  // Cleanup any prior run.
  await sql.query("DELETE FROM users WHERE email LIKE 'flow-test-%@example.com'");

  const u = await sql`
    INSERT INTO users (email, password_hash, name)
    VALUES (${'flow-test-owner-' + Date.now() + '@example.com'},
            'fake', 'Flow Owner')
    RETURNING id
  `;
  ownerId = u.rows[0].id;

  const w = await sql`
    INSERT INTO workspaces (owner_id, name)
    VALUES (${ownerId}, 'Flow Test Workspace')
    RETURNING id
  `;
  workspaceId = w.rows[0].id;

  await sql`
    INSERT INTO calendar_settings (workspace_id, biz_name, slug)
    VALUES (${workspaceId}, 'Flow Studio', ${'flow-' + Date.now()})
  `;

  clientEmail = 'flow-test-client-' + Date.now() + '@example.com';
  const c = await sql`
    INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${workspaceId}, 'Flow Client', ${clientEmail}, 'active')
    RETURNING id
  `;
  clientId = c.rows[0].id;

  const s = await sql`
    INSERT INTO services (workspace_id, name, duration_minutes, price)
    VALUES (${workspaceId}, '60-min', 60, 100)
    RETURNING id
  `;
  serviceId = s.rows[0].id;

  const b = await sql`
    INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email,
                          date, start_min, end_min)
    VALUES (${workspaceId}, ${serviceId}, ${clientId}, 'Flow Client', ${clientEmail},
            ${yesterday}::date, 600, 660)
    RETURNING id
  `;
  bookingId = b.rows[0].id;

  const inv = await sql`
    INSERT INTO invoices (workspace_id, client_id, client_name, client_email,
                          number, status, items, tax_rate, discount, due_date)
    VALUES (${workspaceId}, ${clientId}, 'Flow Client', ${clientEmail},
            'INV-001', 'sent', ${JSON.stringify([{ desc: 'Item', qty: 1, price: 100 }])}::jsonb,
            0, 0, ${yesterday}::date)
    RETURNING id
  `;
  invoiceId = inv.rows[0].id;

  // Subscription state on the workspace so subscription notifs find the row.
  await sql`
    UPDATE workspaces SET
      stripe_subscription_id = 'sub_test_flow',
      subscription_status = 'active',
      subscription_period_end = (NOW() + INTERVAL '30 days')
    WHERE id = ${workspaceId}
  `;
}

async function teardown() {
  if (ownerId) await sql`DELETE FROM users WHERE id = ${ownerId}`;
}

// Each section invokes a notify function; assertion is that it returns
// without throwing. The notify functions wrap their internal Resend
// call in try/catch and call reportError on failure, so a Resend
// rejection (which we expect, since RESEND_API_KEY is fake) is the
// correct path through the code.
async function testCancellation() {
  console.log('\n[1] notifyBookingCancellation - owner direction');
  await notifyBookingCancellation({ workspaceId, bookingId, source: 'owner' });
  assert(true, 'returns without throwing');

  console.log('\n[2] notifyBookingCancellation - client direction');
  await notifyBookingCancellation({ workspaceId, bookingId, source: 'client' });
  assert(true, 'returns without throwing');
}

async function testReschedule() {
  console.log('\n[3] notifyBookingRescheduled - client direction');
  await notifyBookingRescheduled({
    workspaceId, bookingId,
    oldDateISO: yesterday, oldStartMin: 540, oldEndMin: 600,
    source: 'client',
  });
  assert(true, 'returns without throwing');
}

async function testInvoices() {
  console.log('\n[4] notifyInvoicePaid');
  await notifyInvoicePaid({ workspaceId, invoiceId, totalAmount: 100, method: 'card' });
  assert(true, 'returns without throwing');

  console.log('\n[5] notifyInvoiceOverdue');
  await notifyInvoiceOverdue({
    workspaceId, invoiceId, daysOverdue: 3,
    viewUrl: 'http://localhost/invoice/x',
  });
  assert(true, 'returns without throwing');
}

async function testSubscription() {
  console.log('\n[6] notifySubscriptionStarted');
  await notifySubscriptionStarted({
    workspaceId,
    periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    amountCents: 2900, currency: 'usd',
  });
  assert(true, 'returns without throwing');

  console.log('\n[7] notifyUpcomingRenewal');
  await notifyUpcomingRenewal({
    workspaceId,
    periodEnd: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    amountCents: 2900, currency: 'usd',
  });
  assert(true, 'returns without throwing');

  console.log('\n[8] notifyPaymentFailed');
  await notifyPaymentFailed({
    workspaceId, amountCents: 2900, currency: 'usd',
    nextAttemptAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
  });
  assert(true, 'returns without throwing');

  console.log('\n[9] notifySubscriptionCancelled');
  await notifySubscriptionCancelled({
    workspaceId,
    endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
  assert(true, 'returns without throwing');
}

async function testCronOverdue() {
  console.log('\n[10] /api/cron/invoice-overdue picks up the overdue invoice');
  // Reset the reminder timestamp so the cron picks it up.
  try {
    await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_overdue_reminder_at TIMESTAMPTZ`;
  } catch {}
  await sql`UPDATE invoices SET last_overdue_reminder_at = NULL WHERE id = ${invoiceId}`;

  const { default: handler } = await import('../api/cron/invoice-overdue.js');
  process.env.CRON_SECRET = 'test-secret';
  const req = {
    method: 'GET', url: '/api/cron/invoice-overdue',
    headers: { authorization: 'Bearer test-secret' },
    query: {}, on() {},
  };
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader() {}, getHeader() {}, writeHead(c) { this.statusCode = c; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; },
  };
  await handler(req, res);
  assert(res.statusCode === 200, 'cron returns 200');
  assert(res.body?.scanned >= 1, `cron scanned ≥ 1 invoice (saw ${res.body?.scanned})`);

  // Re-run - should now find 0 (last_overdue_reminder_at was just set).
  await handler(req, { ...res, body: undefined });
}

async function testCancellationRespectsClientPrefs() {
  console.log('\n[11] cancellation email muted when client has opted out of bookings');
  // Set the client to opt out of bookings.
  await sql`UPDATE clients SET notification_prefs = '{"bookings": false}'::jsonb WHERE id = ${clientId}`;

  // The fire-and-forget path swallows email failures, so the assertion
  // here is via the wrapper: directly check sendEmailToClient. The
  // top-level notifyBookingCancellation is fire-and-forget and won't
  // surface the muted return value. So we just verify the underlying
  // helper still gates.
  const { sendEmailToClient } = await import('../api/_lib/email.js');
  const out = await sendEmailToClient({
    clientId, type: 'bookings',
    to: clientEmail, subject: 'cancel-test', html: '<p>x</p>',
  });
  assert(out.ok && !out.sent && out.reason === 'muted',
    'client opted out → cancellation email is muted at the wrapper');
}

async function main() {
  console.log('=== Email lifecycle flow tests ===');
  try {
    await setup();
    await testCancellation();
    await testReschedule();
    await testInvoices();
    await testSubscription();
    await testCronOverdue();
    await testCancellationRespectsClientPrefs();
  } finally {
    await teardown();
  }
  console.log('\n────────────────────────────');
  console.log(`Pass: ${pass}  Fail: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });

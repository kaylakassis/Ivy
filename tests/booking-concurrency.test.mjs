// Tests for the two scale fixes added after the production audit:
//   1. Double-booking race resolution (losesBookingRace) - the optimistic
//      post-insert check that lets exactly `capacity` concurrent bookings
//      of a slot win and rolls back the rest.
//   2. Stripe-native charge idempotency - chargeOffSession forwards an
//      Idempotency-Key header so a retry / crash-after-charge can't
//      double-bill.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/booking-concurrency.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { losesBookingRace } from '../api/_lib/calendar.js';
import { chargeOffSession } from '../api/_lib/stripe.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

const created = { users: [] };

async function mkUser(label) {
  const r = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`bc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id
  `;
  created.users.push(r.rows[0].id);
  return r.rows[0].id;
}

async function mkBooking({ workspaceId, serviceId, date, start, end, agoSeconds }) {
  const r = await sql.query(
    `INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min, created_at)
     VALUES ($1, $2, 'T', 't@example.com', $3, $4, $5, NOW() - ($6 || ' seconds')::interval)
     RETURNING id, created_at`,
    [workspaceId, serviceId, date, start, end, String(agoSeconds)],
  );
  return r.rows[0];
}

async function run() {
  try {
    await ensureSchemaApplied();
    const owner = await mkUser('owner');
    const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${owner}) RETURNING id`;
    const workspaceId = w.rows[0].id;
    const svc = await sql`
      INSERT INTO services (workspace_id, name, duration_minutes, capacity)
      VALUES (${workspaceId}, 'Test', 30, 1) RETURNING id
    `;
    const serviceId = svc.rows[0].id;
    const DATE = '2030-01-15';

    console.log('\n[1] capacity 1, same service exact slot → later racer loses, earlier wins');
    const a = await mkBooking({ workspaceId, serviceId, date: DATE, start: 600, end: 630, agoSeconds: 2 });
    const b = await mkBooking({ workspaceId, serviceId, date: DATE, start: 600, end: 630, agoSeconds: 1 });
    const aLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 600, end: 630, serviceId, capacity: 1, bookingId: a.id, createdAt: a.created_at });
    const bLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 600, end: 630, serviceId, capacity: 1, bookingId: b.id, createdAt: b.created_at });
    assert(aLoses === false, 'earlier booking A wins (does not lose)');
    assert(bLoses === true,  'later booking B loses the race');

    console.log('\n[2] capacity 2 → first two win, third loses');
    const c = await mkBooking({ workspaceId, serviceId, date: DATE, start: 700, end: 730, agoSeconds: 3 });
    const d = await mkBooking({ workspaceId, serviceId, date: DATE, start: 700, end: 730, agoSeconds: 2 });
    const e = await mkBooking({ workspaceId, serviceId, date: DATE, start: 700, end: 730, agoSeconds: 1 });
    const cLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 700, end: 730, serviceId, capacity: 2, bookingId: c.id, createdAt: c.created_at });
    const dLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 700, end: 730, serviceId, capacity: 2, bookingId: d.id, createdAt: d.created_at });
    const eLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 700, end: 730, serviceId, capacity: 2, bookingId: e.id, createdAt: e.created_at });
    assert(cLoses === false && dLoses === false, 'first two (C, D) win under capacity 2');
    assert(eLoses === true, 'third (E) loses under capacity 2');

    console.log('\n[3] different service overlap → later racer loses regardless of capacity');
    const svc2 = await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity) VALUES (${workspaceId}, 'Other', 30, 5) RETURNING id`;
    const f = await mkBooking({ workspaceId, serviceId, date: DATE, start: 800, end: 830, agoSeconds: 2 });
    const g = await mkBooking({ workspaceId, serviceId: svc2.rows[0].id, date: DATE, start: 815, end: 845, agoSeconds: 1 });
    const gLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 815, end: 845, serviceId: svc2.rows[0].id, capacity: 5, bookingId: g.id, createdAt: g.created_at });
    assert(gLoses === true, 'overlapping different-service booking loses (one resource, no stacking)');

    console.log('\n[4] non-overlapping times → no loss');
    const h = await mkBooking({ workspaceId, serviceId, date: DATE, start: 900, end: 930, agoSeconds: 2 });
    const i = await mkBooking({ workspaceId, serviceId, date: DATE, start: 930, end: 960, agoSeconds: 1 });
    const iLoses = await losesBookingRace({ workspaceId, dateISO: DATE, start: 930, end: 960, serviceId, capacity: 1, bookingId: i.id, createdAt: i.created_at });
    assert(iLoses === false, 'back-to-back (non-overlapping) booking does not lose');

    console.log('\n[5] cancelled earlier booking frees the slot');
    await sql`UPDATE bookings SET cancelled_at = NOW() WHERE id = ${a.id}`;
    const bLosesAfterCancel = await losesBookingRace({ workspaceId, dateISO: DATE, start: 600, end: 630, serviceId, capacity: 1, bookingId: b.id, createdAt: b.created_at });
    assert(bLosesAfterCancel === false, 'B now wins after the earlier A was cancelled');

    console.log('\n[6] chargeOffSession forwards a Stripe Idempotency-Key header');
    const realFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, opts = {}) => {
      captured = { url: String(url), headers: opts.headers || {} };
      return { ok: true, status: 200, json: async () => ({ id: 'pi_test', status: 'succeeded' }) };
    };
    try {
      await chargeOffSession({
        secretKey: 'sk_test_x', customerId: 'cus_1', paymentMethodId: 'pm_1',
        amountCents: 1500, currency: 'usd', description: 'test',
        idempotencyKey: 'fee-abc123',
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert(captured?.url.includes('/payment_intents'), 'charge hits /payment_intents');
    assert(captured?.headers['Idempotency-Key'] === 'fee-abc123', 'Idempotency-Key header is forwarded to Stripe');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of created.users) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

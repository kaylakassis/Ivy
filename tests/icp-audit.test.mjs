// ICP-audit regression tests (audit v3):
//   1. Gift-card credit counts as PAID everywhere: computeBookingPayment
//      + the collect-in-person balance (the $180-for-a-$100-service bug).
//   2. Phone-only clients: creatable via POST /clients and bookable via
//      POST /calendar/bookings (walk-ins without email).
//   3. Portal invites are a choice: sendInvite:false suppresses on add;
//      import only sends with explicit sendInvites:true.
//   4. Default sales tax: PATCHable, GETtable, seeded onto new invoices.
//   5. /api/me/bookings returns the server-computed startEpochMs (fee
//      warning tz fix), giftCardCredit in payment, and recurrenceRule.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/icp-audit.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { computeBookingPayment, slotEpochMs } from '../api/_lib/calendar.js';
import { redeemAtomic, generateCode, hashCode, normalizeCode } from '../api/_lib/giftCards.js';
import clientsHandler from '../api/clients/index.js';
import importHandler from '../api/clients/import.js';
import bookingsHandler from '../api/calendar/bookings.js';
import collectHandler from '../api/calendar/bookings/collect.js';
import taxHandler from '../api/finance/tax-settings.js';
import invoicesHandler from '../api/invoices/index.js';
import meBookingsHandler from '../api/me/bookings.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.18.0.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } };
}

const STAMP = Date.now();
let userId, wsId, cookie;

async function setup() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`icp-${STAMP}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  cookie = `ivy_session=${signSession(userId)}`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${userId}, 'ICP', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  wsId = w.rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${wsId}, 'ICP Studio', ${`icp-${STAMP}`}, 'America/Los_Angeles')
    ON CONFLICT (workspace_id) DO UPDATE SET timezone = 'America/Los_Angeles', slug = ${`icp-${STAMP}`}`;
}

async function run() {
  await setup();

  // ── 1. Gift credit counts as paid ───────────────────────────────
  console.log('\n[1] gift-card credit counts as paid in every balance');
  const pay = computeBookingPayment({
    booking_total: 100, deposit_paid: 0, gift_card_credit_cents: 8000,
  });
  assert(pay.giftCardCredit === 80, `computeBookingPayment giftCardCredit=80 (got ${pay.giftCardCredit})`);
  assert(pay.balanceDue === 20, `balanceDue 100-80=20 (got ${pay.balanceDue})`);
  assert(pay.amountPaid === 80 && !pay.fullyPaid, 'amountPaid=80, not fully paid');
  const payFull = computeBookingPayment({
    booking_total: 100, deposit_paid: 20, gift_card_credit_cents: 8000,
  });
  assert(payFull.fullyPaid === true, 'deposit 20 + gift 80 = fully paid');

  // collect-in-person mints the REMAINDER, not the full total
  const cl = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wsId}, 'Gifted', ${`icp-gift-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0];
  const bk = (await sql`
    INSERT INTO bookings (workspace_id, client_id, client_name, client_email,
                          date, start_min, end_min, booking_total, gift_card_credit_cents)
    VALUES (${wsId}, ${cl.id}, 'Gifted', ${`icp-gift-${STAMP}@example.com`},
            CURRENT_DATE + 2, 600, 660, 100, 8000)
    RETURNING id`).rows[0];
  let r = mockRes();
  await collectHandler(req({ method: 'POST', cookie, body: { id: bk.id } }), r);
  assert(r.statusCode === 200, `collect ok (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
  assert(Number(r.body?.invoice?.total) === 20,
    `collect invoice bills the $20 remainder, not $100 (got ${r.body?.invoice?.total})`);

  // ── 2. Phone-only clients ───────────────────────────────────────
  console.log('\n[2] phone-only clients are creatable and bookable');
  r = mockRes();
  await clientsHandler(req({ method: 'POST', cookie,
    body: { name: 'Walk In', phone: '555-867-5309', stage: 'active' } }), r);
  assert(r.statusCode === 201, `phone-only client created (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
  assert(r.body?.client?.email == null, 'no fake email persisted');

  r = mockRes();
  await clientsHandler(req({ method: 'POST', cookie, body: { name: 'No Contact' } }), r);
  assert(r.statusCode === 400, `no contact at all still rejected (got ${r.statusCode})`);

  r = mockRes();
  await bookingsHandler(req({ method: 'POST', cookie, body: {
    clientName: 'Walk In 2', clientPhone: '555-201-3000',
    date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    startMin: 600, endMin: 660,
  } }), r);
  assert(r.statusCode === 201 || r.statusCode === 200,
    `phone-only manual booking accepted (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 120)})`);

  // ── 3. Invites are a choice ─────────────────────────────────────
  console.log('\n[3] portal invites are an explicit choice');
  r = mockRes();
  await clientsHandler(req({ method: 'POST', cookie,
    body: { name: 'Quiet Add', email: `icp-quiet-${STAMP}@example.com`, sendInvite: false } }), r);
  assert(r.statusCode === 201, 'quiet add created');
  const quiet = await sql`SELECT invite_sent_at FROM clients WHERE id = ${r.body.client.id}`;
  assert(quiet.rows[0].invite_sent_at === null, 'sendInvite:false → no invite stamped');

  r = mockRes();
  await importHandler(req({ method: 'POST', cookie, body: {
    rows: [{ name: 'Imported One', email: `icp-imp-${STAMP}@example.com` }],
  } }), r);
  assert(r.statusCode === 200 || r.statusCode === 201, `import ok (got ${r.statusCode})`);
  const imp = await sql`SELECT invite_sent_at FROM clients
    WHERE workspace_id = ${wsId} AND email = ${`icp-imp-${STAMP}@example.com`}`;
  assert(imp.rows[0]?.invite_sent_at === null, 'import without sendInvites → NO invite emails');

  // ── 4. Default sales tax wired end to end ───────────────────────
  console.log('\n[4] default sales tax: settable + seeded onto new invoices');
  r = mockRes();
  await taxHandler(req({ method: 'PATCH', cookie, body: { defaultTaxRate: 8.25 } }), r);
  assert(r.statusCode === 200 && Number(r.body?.defaultTaxRate) === 8.25,
    `tax rate saved (got ${r.statusCode}/${r.body?.defaultTaxRate})`);
  r = mockRes();
  await taxHandler(req({ method: 'GET', cookie }), r);
  assert(Number(r.body?.defaultTaxRate) === 8.25, `GET returns it (got ${r.body?.defaultTaxRate})`);
  r = mockRes();
  await invoicesHandler(req({ method: 'POST', cookie, body: {
    items: [{ description: 'Candle', quantity: 1, rate: 100 }], discount: 0,
  } }), r);
  assert(Number(r.body?.invoice?.taxRate) === 8.25,
    `new invoice seeded with 8.25% (got ${r.body?.invoice?.taxRate})`);
  r = mockRes();
  await invoicesHandler(req({ method: 'POST', cookie, body: {
    items: [{ description: 'Untaxed', quantity: 1, rate: 50 }], taxRate: 0, discount: 0,
  } }), r);
  assert(Number(r.body?.invoice?.taxRate) === 0, 'explicit taxRate 0 still wins');

  // ── 5. Portal bookings payload: tz-correct epoch + gift + recurrence ──
  console.log('\n[5] /api/me/bookings serves tz-correct epoch + gift credit');
  await sql`UPDATE clients SET user_id = ${userId} WHERE id = ${cl.id}`;
  await sql`UPDATE bookings SET recurrence_rule = 'weekly' WHERE id = ${bk.id}`;
  r = mockRes();
  await meBookingsHandler(req({ method: 'GET', cookie }), r);
  const items = [...(r.body?.upcoming || []), ...(r.body?.past || [])];
  const mine = items.find((b) => b.id === bk.id);
  assert(!!mine, `portal sees the booking (got ${items.length} items)`);
  if (mine) {
    const dateISO = mine.date;
    const expected = slotEpochMs(dateISO, 600, 'America/Los_Angeles');
    assert(Number(mine.startEpochMs) === expected,
      `startEpochMs uses the WORKSPACE tz (got ${mine.startEpochMs}, want ${expected})`);
    const utcGuess = Date.parse(`${dateISO}T00:00:00Z`) + 600 * 60000;
    assert(expected !== utcGuess, 'and it differs from the old UTC guess (the bug)');
    assert(mine.payment?.giftCardCredit === 80, `payment.giftCardCredit=80 (got ${mine.payment?.giftCardCredit})`);
    assert(mine.recurrenceRule === 'weekly', 'recurrenceRule exposed (reschedule button hides)');
  }
}

async function cleanup() {
  if (wsId) await sql`DELETE FROM workspaces WHERE id = ${wsId}`;
  if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
}

run()
  .catch((e) => { fail++; console.log('  ✗ threw:', e.message, '\n', e.stack); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n────────────────────────────\nPass: ${pass}  Fail: ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });

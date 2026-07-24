// Audit v2 regression tests for the money-moving fixes in this batch:
//   1. Owner package top-up is an ATOMIC SQL delta (concurrent consume
//      can't be silently un-done into a free credit).
//   2. Gift-card credit is restored to the card exactly once when a
//      booking is cancelled - from either cancel path, and never twice.
//   3. Voiding a POS sale restocks; restoring it re-deducts; a
//      void→restore→void cycle restocks exactly once per void.
//   4. No-show DELETE undo clears the flag but preserves fee_charged_*.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-v2-fixes.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { redeemAtomic, restoreGiftCardCreditForBooking, generateCode, hashCode, normalizeCode } from '../api/_lib/giftCards.js';
import { consumeCredit } from '../api/_lib/packages.js';
import pkgHandler from '../api/clients/[id]/packages/[cpId].js';
import voidHandler from '../api/invoices/void.js';
import invoiceIdHandler from '../api/invoices/[id].js';
import noShowHandler from '../api/calendar/bookings/no-show.js';
import bookingIdHandler from '../api/calendar/bookings/[id].js';

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
      'x-forwarded-for': `203.0.113.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } };
}

const STAMP = Date.now();
let userId, wsId, cookie, clientId;

async function setup() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`av2-${STAMP}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  cookie = `ivy_session=${signSession(userId)}`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${userId}, 'AV2', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  wsId = w.rows[0].id;
  const c = await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wsId}, 'Cli', ${`av2c-${STAMP}@example.com`}, 'active') RETURNING id`;
  clientId = c.rows[0].id;
}

const mkBooking = async (extra = {}) => {
  const r = await sql`
    INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min,
                          gift_card_credit_cents)
    VALUES (${wsId}, ${clientId}, 'Cli', ${`av2c-${STAMP}@example.com`},
            CURRENT_DATE + 1, 600, 660, ${extra.giftCents || 0})
    RETURNING *`;
  return r.rows[0];
};

async function run() {
  await setup();

  // ── 1. Atomic package top-up ────────────────────────────────────
  console.log('\n[1] owner top-up is an atomic delta, not read-modify-write');
  const cp = (await sql`
    INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status)
    VALUES (${wsId}, ${clientId}, 'Ten pack', 10, 10, 'active') RETURNING *`).rows[0];

  // Simulate the race the fix closes: the handler reads the row (10
  // remaining), a portal booking consumes one (→9), THEN the handler
  // writes. Read-modify-write would store 10+2=12 (the consume lost);
  // an atomic delta stores 9+2=11.
  const consumed = await consumeCredit({ workspaceId: wsId, clientPackageId: cp.id, clientId, serviceId: null });
  assert(consumed.ok && consumed.creditsRemaining === 9, `portal booking consumed one → 9 (got ${JSON.stringify(consumed)})`);
  let r = mockRes();
  await pkgHandler(req({ method: 'PATCH', cookie, query: { id: clientId, cpId: cp.id },
    body: { addCredits: 2 } }), r);
  assert(r.statusCode === 200, `top-up ok (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
  const after = (await sql`SELECT * FROM client_packages WHERE id = ${cp.id}`).rows[0];
  assert(after.credits_remaining === 11, `remaining 9+2=11, not 12 (got ${after.credits_remaining})`);
  assert(after.credits_total === 12, `total 10+2=12 (got ${after.credits_total})`);

  // Negative delta clamps at 0 and never violates the <= total CHECK.
  r = mockRes();
  await pkgHandler(req({ method: 'PATCH', cookie, query: { id: clientId, cpId: cp.id },
    body: { addCredits: -50 } }), r);
  const clamped = (await sql`SELECT * FROM client_packages WHERE id = ${cp.id}`).rows[0];
  assert(r.statusCode === 200 && clamped.credits_remaining === 0,
    `big negative clamps to 0 (got ${r.statusCode}/${clamped.credits_remaining})`);

  // Auto-reactivate on top-up still works (exhausted → active).
  await sql`UPDATE client_packages SET status = 'exhausted' WHERE id = ${cp.id}`;
  r = mockRes();
  await pkgHandler(req({ method: 'PATCH', cookie, query: { id: clientId, cpId: cp.id },
    body: { addCredits: 3 } }), r);
  const react = (await sql`SELECT * FROM client_packages WHERE id = ${cp.id}`).rows[0];
  assert(react.status === 'active', `exhausted → active on top-up (got ${react.status})`);
  // Explicit status in the body still wins (no double `status =` assignment).
  r = mockRes();
  await pkgHandler(req({ method: 'PATCH', cookie, query: { id: clientId, cpId: cp.id },
    body: { addCredits: 1, status: 'cancelled' } }), r);
  const both = (await sql`SELECT * FROM client_packages WHERE id = ${cp.id}`).rows[0];
  assert(r.statusCode === 200 && both.status === 'cancelled',
    `explicit status wins alongside addCredits (got ${r.statusCode}/${both.status})`);

  // ── 2. Gift-card credit restored exactly once on cancel ─────────
  console.log('\n[2] gift-card credit returns to the card exactly once per cancel');
  const raw = generateCode();
  const card = (await sql`
    INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, status)
    VALUES (${wsId}, ${hashCode(normalizeCode(raw))}, ${normalizeCode(raw).slice(-4)}, 10000, 10000, 'active')
    RETURNING *`).rows[0];
  const bk = await mkBooking({ giftCents: 2500 });
  await redeemAtomic({ giftCardId: card.id, workspaceId: wsId, amountCents: 2500,
    appliedToKind: 'booking', appliedToId: bk.id, clientId });
  let bal = (await sql`SELECT balance_cents FROM gift_cards WHERE id = ${card.id}`).rows[0].balance_cents;
  assert(bal === 7500, `debited on booking (got ${bal})`);

  const n1 = await restoreGiftCardCreditForBooking({ workspaceId: wsId, bookingId: bk.id });
  bal = (await sql`SELECT balance_cents FROM gift_cards WHERE id = ${card.id}`).rows[0].balance_cents;
  assert(n1 === 2500 && bal === 10000, `restored on cancel (returned ${n1}, balance ${bal})`);
  const n2 = await restoreGiftCardCreditForBooking({ workspaceId: wsId, bookingId: bk.id });
  bal = (await sql`SELECT balance_cents FROM gift_cards WHERE id = ${card.id}`).rows[0].balance_cents;
  assert(n2 === 0 && bal === 10000, `second call is a no-op - no double credit (returned ${n2}, balance ${bal})`);

  // A depleted card comes back to life when credit is returned.
  const bk2 = await mkBooking({ giftCents: 10000 });
  await redeemAtomic({ giftCardId: card.id, workspaceId: wsId, amountCents: 10000,
    appliedToKind: 'booking', appliedToId: bk2.id, clientId });
  const depleted = (await sql`SELECT status, balance_cents FROM gift_cards WHERE id = ${card.id}`).rows[0];
  assert(depleted.status === 'depleted' && depleted.balance_cents === 0, 'card depleted by full redemption');
  await restoreGiftCardCreditForBooking({ workspaceId: wsId, bookingId: bk2.id });
  const revived = (await sql`SELECT status, balance_cents FROM gift_cards WHERE id = ${card.id}`).rows[0];
  assert(revived.status === 'active' && revived.balance_cents === 10000,
    `depleted → active on restore (got ${revived.status}/${revived.balance_cents})`);

  // Owner DELETE path wires the restore in (exactly once even on re-delete).
  const bk3 = await mkBooking({ giftCents: 4000 });
  await redeemAtomic({ giftCardId: card.id, workspaceId: wsId, amountCents: 4000,
    appliedToKind: 'booking', appliedToId: bk3.id, clientId });
  r = mockRes();
  await bookingIdHandler(req({ method: 'DELETE', cookie, query: { id: bk3.id } }), r);
  const afterDel = (await sql`SELECT balance_cents FROM gift_cards WHERE id = ${card.id}`).rows[0].balance_cents;
  assert(afterDel === 10000, `owner cancel restored the credit (got ${afterDel})`);

  // ── 3. POS void restocks; restore re-deducts; cycle is balanced ──
  console.log('\n[3] voiding a POS sale restocks, restoring re-deducts');
  const prod = (await sql`
    INSERT INTO products (workspace_id, name, price, track_stock, stock_qty)
    VALUES (${wsId}, 'Candle', 20, TRUE, 10) RETURNING *`).rows[0];
  const items = [{ id: 'li_1', productId: prod.id, description: 'Candle', quantity: 3, rate: 20 }];
  const inv = (await sql`
    INSERT INTO invoices (workspace_id, number, client_name, items, tax_rate, discount, status)
    VALUES (${wsId}, ${`INV-AV2-${STAMP}`}, 'Walk-in', ${JSON.stringify(items)}::jsonb, 0, 0, 'sent')
    RETURNING *`).rows[0];
  await sql`UPDATE products SET stock_qty = stock_qty - 3 WHERE id = ${prod.id}`; // sale decremented
  const stock = async () => (await sql`SELECT stock_qty FROM products WHERE id = ${prod.id}`).rows[0].stock_qty;
  assert(await stock() === 7, 'sale decremented stock to 7');

  r = mockRes();
  await voidHandler(req({ method: 'POST', cookie, body: { id: inv.id } }), r);
  assert(r.statusCode === 200 && await stock() === 10, `void restocked to 10 (got ${await stock()})`);

  r = mockRes();
  await invoiceIdHandler(req({ method: 'PATCH', cookie, query: { id: inv.id }, body: { status: 'draft' } }), r);
  assert(r.statusCode === 200 && await stock() === 7,
    `restore re-deducted to 7 (got ${r.statusCode}/${await stock()})`);

  r = mockRes();
  await voidHandler(req({ method: 'POST', cookie, body: { id: inv.id } }), r);
  assert(await stock() === 10, `second void restocks again, once (got ${await stock()})`);

  // A paid invoice can never be flipped to voided by a racing void.
  const paidInv = (await sql`
    INSERT INTO invoices (workspace_id, number, client_name, items, tax_rate, discount, status, paid_at)
    VALUES (${wsId}, ${`INV-AV2P-${STAMP}`}, 'Walk-in', ${JSON.stringify(items)}::jsonb, 0, 0, 'paid', NOW())
    RETURNING *`).rows[0];
  r = mockRes();
  await voidHandler(req({ method: 'POST', cookie, body: { id: paidInv.id } }), r);
  const stillPaid = (await sql`SELECT status FROM invoices WHERE id = ${paidInv.id}`).rows[0].status;
  assert(stillPaid === 'paid', `paid invoice stays paid against a void (got ${stillPaid})`);

  // ── 4. No-show undo keeps the fee record ────────────────────────
  console.log('\n[4] no-show undo clears the flag but keeps fee_charged_*');
  const bk4 = await mkBooking();
  await sql`UPDATE bookings SET no_show_at = NOW(), fee_charged_amount = 25, fee_charged_at = NOW(),
              fee_charged_kind = 'no_show', fee_payment_intent = 'pi_test_av2'
            WHERE id = ${bk4.id}`;
  r = mockRes();
  await noShowHandler(req({ method: 'DELETE', cookie, body: { id: bk4.id } }), r);
  const undone = (await sql`SELECT * FROM bookings WHERE id = ${bk4.id}`).rows[0];
  assert(r.statusCode === 200 && undone.no_show_at === null, `no_show_at cleared (got ${r.statusCode})`);
  assert(Number(undone.fee_charged_amount) === 25 && undone.fee_payment_intent === 'pi_test_av2',
    'charged-fee record preserved (real money stays on the books)');
  r = mockRes();
  await noShowHandler(req({ method: 'DELETE', cookie, body: { id: bk4.id } }), r);
  assert(r.statusCode === 400, `undoing twice is rejected (got ${r.statusCode})`);
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

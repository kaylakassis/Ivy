// Tests the PayPal webhook foundation: resolving the owning workspace from
// an event (by payee merchant id, or by capture id for refunds) and the
// idempotent apply logic that marks invoices paid / refunded. This is the
// piece that makes PayPal payments actually register - PayPal Commerce
// delivers to ONE platform webhook, so the handler must resolve the
// workspace itself rather than rely on a per-workspace URL.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/paypal-webhook.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import {
  resolveWorkspaceForPaypalEvent,
  applyPaymentToInvoice,
  applyRefundToInvoice,
} from '../api/_lib/paypalApply.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  await ensureSchemaApplied();

  const tag = `pp-${Date.now()}`;
  const merchant = `MERCH-${tag}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, payment_provider, paypal_merchant_id)
    VALUES (${wid}, 'paypal', ${merchant})
    ON CONFLICT (workspace_id) DO UPDATE SET payment_provider = 'paypal', paypal_merchant_id = ${merchant}`;

  const invId = (await sql.query(
    `INSERT INTO invoices (workspace_id, number, client_name, issue_date, due_date, items, status)
     VALUES ($1,$2,'Walk-in',CURRENT_DATE,CURRENT_DATE,$3::jsonb,'sent') RETURNING id, total`,
    [wid, `INV-${tag}`, JSON.stringify([{ id: 'l1', description: 'X', quantity: 1, rate: 100 }])],
  )).rows[0];

  console.log('\n[1] resolve workspace by payee merchant id');
  const wsByMerchant = await resolveWorkspaceForPaypalEvent({ payeeMerchantId: merchant });
  assert(wsByMerchant === wid, 'capture event resolves to the connected workspace via payee merchant id');
  assert((await resolveWorkspaceForPaypalEvent({ payeeMerchantId: 'nope' })) === null, 'unknown merchant resolves to null');

  console.log('\n[2] apply a completed capture → invoice paid (method paypal)');
  const payParsed = { type: 'checkout.completed', status: 'paid', metadata: { invoice_id: invId.id }, paymentId: 'CAP1', amountCents: 10000, payeeMerchantId: merchant };
  assert((await applyPaymentToInvoice({ workspaceId: wid, parsed: payParsed })) === 'paid', 'first apply marks paid');
  let row = (await sql`SELECT status, paid_amount, paid_method, stripe_payment_intent FROM invoices WHERE id = ${invId.id}`).rows[0];
  assert(row.status === 'paid' && Number(row.paid_amount) === 100, 'invoice is paid for $100');
  assert(row.paid_method === 'paypal', "paid_method = 'paypal'");
  assert(row.stripe_payment_intent === 'CAP1', 'capture id stored in the generic payment-id column');

  console.log('\n[3] replay is idempotent');
  assert((await applyPaymentToInvoice({ workspaceId: wid, parsed: payParsed })) === 'already-applied', 'same capture replay is a no-op');

  console.log('\n[4] resolve workspace by capture id (refund path, no payee on event)');
  const wsByCapture = await resolveWorkspaceForPaypalEvent({ paymentId: 'CAP1' });
  assert(wsByCapture === wid, 'refund event resolves via the capture id → invoice');

  console.log('\n[5] partial then full refund');
  const r1 = await applyRefundToInvoice({ workspaceId: wid, parsed: { type: 'refund.updated', status: 'succeeded', paymentId: 'CAP1', refundId: 'REF1', amountCents: 3000 } });
  assert(r1 === 'partial-refund', 'partial refund recorded');
  row = (await sql`SELECT status, refunded_amount FROM invoices WHERE id = ${invId.id}`).rows[0];
  assert(Number(row.refunded_amount) === 30 && row.status === 'paid', 'refunded 30, still paid');
  // replay same refund id → idempotent
  const rDup = await applyRefundToInvoice({ workspaceId: wid, parsed: { type: 'refund.updated', status: 'succeeded', paymentId: 'CAP1', refundId: 'REF1', amountCents: 3000 } });
  assert(rDup === 'already-applied', 'same refund id replay is a no-op');
  const r2 = await applyRefundToInvoice({ workspaceId: wid, parsed: { type: 'refund.updated', status: 'succeeded', paymentId: 'CAP1', refundId: 'REF2', amountCents: 7000 } });
  assert(r2 === 'refunded', 'reaching the full amount flips status to refunded');
  row = (await sql`SELECT status, refunded_amount FROM invoices WHERE id = ${invId.id}`).rows[0];
  assert(Number(row.refunded_amount) === 100 && row.status === 'refunded', 'fully refunded');

  console.log('\n[6] booking-deposit capture marks the booking, idempotently');
  const bId = (await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min, deposit_required)
    VALUES (${wid}, 'T', 't@example.com', CURRENT_DATE, 600, 660, 25) RETURNING id`).rows[0].id;
  const depParsed = { type: 'checkout.completed', status: 'paid', metadata: { invoice_id: `bookdep_${bId}` }, paymentId: 'CAPDEP', amountCents: 2500, payeeMerchantId: merchant };
  assert((await applyPaymentToInvoice({ workspaceId: wid, parsed: depParsed })) === 'deposit-paid', 'deposit recorded');
  assert((await applyPaymentToInvoice({ workspaceId: wid, parsed: depParsed })) === 'deposit-already-paid', 'deposit replay is a no-op');
  const bk = (await sql`SELECT deposit_paid, deposit_payment_intent FROM bookings WHERE id = ${bId}`).rows[0];
  assert(Number(bk.deposit_paid) === 25 && bk.deposit_payment_intent === 'CAPDEP', 'deposit_paid + payment intent stored');

  // Cleanup.
  await sql`DELETE FROM bookings WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM finance_settings WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

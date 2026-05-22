// Tests synchronous invoice payment settlement — the fix for "I paid via
// the Stripe QR code but the finance tab never showed it / invoice stayed
// overdue." Payment is now confirmed on return instead of relying solely on
// a per-workspace webhook most owners never configure.
//
//   • markInvoicePaid — idempotent mark-paid (status, amount, method, intent)
//   • reconcileStripeInvoice — no-op guards (no session / non-Stripe session)
//   • invoice-pay ?action=confirm — idempotent confirm by token
//
// The live Stripe session fetch needs real creds, so the "happy path"
// settlement is exercised through markInvoicePaid directly.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/invoice-payment-confirm.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { markInvoicePaid, reconcileStripeInvoice } from '../api/_lib/invoicePayments.js';
import payHandler from '../api/invoice-pay/[token].js';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(s) { this.body = s; return this; } });
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function run() {
  await ensureSchemaApplied();
  const tag = `ipc-${Date.now()}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;

  const mkInvoice = async (token, sessionId) => (await sql.query(
    `INSERT INTO invoices (workspace_id, number, client_name, issue_date, due_date, items, status, view_token_hash, stripe_session_id)
     VALUES ($1,$2,'Walk-in',CURRENT_DATE,CURRENT_DATE,$3::jsonb,'sent',$4,$5) RETURNING id, total`,
    [wid, `INV-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify([{ id: 'l', description: 'X', quantity: 1, rate: 200 }]),
     token ? hash(token) : null, sessionId || null],
  )).rows[0];

  console.log('\n[1] markInvoicePaid is idempotent + records the settlement');
  const inv1 = await mkInvoice(null, null);
  assert(Number(inv1.total) === 200, 'trigger total = 200');
  assert((await markInvoicePaid({ workspaceId: wid, invoiceId: inv1.id, paymentIntent: 'pi_1', amountCents: 20000 })) === 'paid', 'first call → paid');
  let row = (await sql`SELECT status, paid_amount, paid_method, stripe_payment_intent FROM invoices WHERE id = ${inv1.id}`).rows[0];
  assert(row.status === 'paid' && Number(row.paid_amount) === 200, 'status paid, amount 200');
  assert(row.paid_method === 'card' && row.stripe_payment_intent === 'pi_1', 'method + payment intent recorded');
  assert((await markInvoicePaid({ workspaceId: wid, invoiceId: inv1.id, paymentIntent: 'pi_1', amountCents: 20000 })) === 'already-paid', 'replay → already-paid');
  assert((await markInvoicePaid({ workspaceId: wid, invoiceId: '00000000-0000-0000-0000-000000000000', paymentIntent: 'x' })) === 'invoice-not-found', 'unknown invoice → not-found');

  console.log('\n[2] reconcileStripeInvoice no-op guards (no live Stripe call)');
  assert((await reconcileStripeInvoice({ id: 'x', workspace_id: wid, status: 'sent', stripe_session_id: null })) === false, 'no session → false');
  assert((await reconcileStripeInvoice({ id: 'x', workspace_id: wid, status: 'sent', stripe_session_id: 'sq_123' })) === false, 'non-Stripe (no cs_ prefix) session → false');
  assert((await reconcileStripeInvoice({ id: 'x', workspace_id: wid, status: 'paid', stripe_session_id: 'cs_123' })) === true, 'already-paid → true (no fetch)');

  console.log('\n[3] invoice-pay ?action=confirm — idempotent by token');
  const tokPaid = `tok-${tag}-paid-abcdefgh`;
  const invPaid = await mkInvoice(tokPaid, 'cs_paid');
  await markInvoicePaid({ workspaceId: wid, invoiceId: invPaid.id, paymentIntent: 'pi_2', amountCents: 20000 });
  let res = mockRes();
  await payHandler({ method: 'POST', query: { token: tokPaid, action: 'confirm' }, headers: { 'x-forwarded-for': '203.0.113.9' }, body: {} }, res);
  assert(res.body?.paid === true, 'confirm on an already-paid invoice → paid:true');

  res = mockRes();
  await payHandler({ method: 'POST', query: { token: `tok-${tag}-missing-xyz12345`, action: 'confirm' }, headers: { 'x-forwarded-for': '203.0.113.10' }, body: {} }, res);
  assert(res.body?.paid === true, 'confirm with a consumed/unknown token → paid:true (treated as already settled)');

  const tokUnpaid = `tok-${tag}-unpaid-abcdefgh`;
  await mkInvoice(tokUnpaid, null); // sent, no Stripe session → reconcile can't settle
  res = mockRes();
  await payHandler({ method: 'POST', query: { token: tokUnpaid, action: 'confirm' }, headers: { 'x-forwarded-for': '203.0.113.11' }, body: {} }, res);
  assert(res.body?.paid === false, 'confirm on an unpaid invoice with no completed session → paid:false');

  // Cleanup.
  await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

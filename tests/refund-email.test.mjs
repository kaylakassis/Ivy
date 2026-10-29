// The client is told when they are refunded: once per refund, with honest
// copy about who sends the money back, from the owner's Refund button (and
// Ivy, which shares the same core) and from refunds made in the Stripe
// Dashboard. The Stripe echo of an in-app refund never sends a second email.
// Run: node --import ./tests/bootstrap.mjs ./tests/refund-email.test.mjs
import crypto from 'node:crypto';

const WEBHOOK_SECRET = 'whsec_test_refund_email';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_platform';
process.env.RESEND_API_KEY ||= 're_test_not_real';

const { ensureSchemaApplied } = await import('../api/_lib/ensureSchema.js');
const { sql } = await import('../api/_lib/db.js');
const { refundInvoice } = await import('../api/_lib/refunds.js');
const { renderInvoiceRefunded } = await import('../api/_lib/invoiceNotify.js');
const { default: webhook } = await import('../api/webhooks/stripe-platform.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture outbound email; answer Stripe refund calls.
const emails = [];
const stripeCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('resend.com')) {
    emails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.stripe.com/v1/refunds')) {
    stripeCalls.push({ url: u, body: String(init.body || ''), headers: init.headers });
    return new Response(JSON.stringify({ id: `re_${stripeCalls.length}`, amount: 1, status: 'succeeded' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

function signedReq(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}
function mkRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; }, json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; } };
}

async function main() {
  await ensureSchemaApplied();
  const tag = `rfe-${Date.now()}`;
  const acctId = `acct_${tag}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`${tag}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${uid}, 'Glow', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${acctId}, 'complete')`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, 'Glow Studio', ${tag}) ON CONFLICT (workspace_id) DO UPDATE SET biz_name = 'Glow Studio'`;
  const items = JSON.stringify([{ description: 'Session', qty: 1, price: 100 }]);
  const client = async (name, email) => (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, ${name}, ${email}, 'active') RETURNING id`).rows[0].id;
  const invoice = async ({ cid, email, name, number, method, pi = null }) => (await sql`
    INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount, paid_amount, paid_at, paid_method, stripe_payment_intent)
    VALUES (${wid}, ${cid}, ${name}, ${email}, ${number}, 'paid', ${items}::jsonb, 0, 0, 100, NOW(), ${method}, ${pi}) RETURNING id`).rows[0].id;

  console.log('\n[1] manual payment (Venmo): partial then full refund, honest copy');
  const cV = await client('Vera Lane', `vera-${tag}@example.com`);
  const iV = await invoice({ cid: cV, email: `vera-${tag}@example.com`, name: 'Vera Lane', number: 'INV-V1', method: 'venmo' });
  emails.length = 0;
  await refundInvoice({ workspaceId: wid, id: iV, amount: 40 });
  assert(emails.length === 1, `one email (${emails.length})`);
  let e = emails[0];
  assert(e?.to === `vera-${tag}@example.com` || (Array.isArray(e?.to) && e.to[0] === `vera-${tag}@example.com`), 'sent to the client');
  assert(/Refund issued: invoice INV-V1/.test(e.subject) && /\$40\.00/.test(e.subject), `subject: ${e.subject}`);
  assert(/Hi Vera/.test(e.html) && /Glow Studio/.test(e.html), 'greets the client and names the business');
  assert(/by Venmo/.test(e.html) && /send the money back to you directly/.test(e.html), 'manual refund says the business sends it back');
  assert(/partial refund/.test(e.html) && /\$60\.00/.test(e.html), 'partial refund states what stays applied');
  assert(stripeCalls.length === 0, 'no processor call for a manual payment');
  emails.length = 0;
  await refundInvoice({ workspaceId: wid, id: iV });
  assert(emails.length === 1 && /fully refunded/.test(emails[0].html) && /\$60\.00/.test(emails[0].subject), 'remaining refund: "fully refunded"');

  console.log('\n[2] card payment refunded in Ivy: one email, and the Stripe echo sends nothing');
  const cC = await client('Cal Ruiz', `cal-${tag}@example.com`);
  const iC = await invoice({ cid: cC, email: `cal-${tag}@example.com`, name: 'Cal Ruiz', number: 'INV-C1', method: 'card', pi: `pi_${tag}_C` });
  emails.length = 0; stripeCalls.length = 0;
  const r = await refundInvoice({ workspaceId: wid, id: iC });
  assert(r.refund.fullyRefunded && stripeCalls.length === 1, 'refund went through the processor');
  assert(emails.length === 1, `one email (${emails.length})`);
  e = emails[0];
  assert(/original payment method/.test(e.html) && /5 to 10 business days/.test(e.html), 'card copy: original method, 5 to 10 business days');
  assert(/fully refunded/.test(e.html), 'full refund wording');
  const echo = mkRes();
  await webhook(signedReq({ id: `evt_echo_${tag}`, type: 'charge.refunded', account: acctId, data: { object: { id: 'ch_c', payment_intent: `pi_${tag}_C`, amount: 10000, amount_refunded: 10000 } } }), echo);
  assert(echo.body?.ignored === 'refund already recorded' && emails.length === 1, 'Stripe echo ignored, still one email');

  console.log('\n[3] refund made in the Stripe Dashboard: client emailed once');
  const cD = await client('Dee Park', `dee-${tag}@example.com`);
  const iD = await invoice({ cid: cD, email: `dee-${tag}@example.com`, name: 'Dee Park', number: 'INV-D1', method: 'card', pi: `pi_${tag}_D` });
  emails.length = 0;
  const w1 = mkRes();
  await webhook(signedReq({ id: `evt_dash_${tag}`, type: 'charge.refunded', account: acctId, data: { object: { id: 'ch_d', payment_intent: `pi_${tag}_D`, amount: 10000, amount_refunded: 2500 } } }), w1);
  assert(w1.body?.applied === 'invoice-refund-synced', 'Dashboard refund synced');
  assert(emails.length === 1 && /\$25\.00/.test(emails[0].subject) && /partial refund/.test(emails[0].html), 'one email for the $25 partial');
  const w2 = mkRes();
  await webhook(signedReq({ id: `evt_dash2_${tag}`, type: 'charge.refunded', account: acctId, data: { object: { id: 'ch_d', payment_intent: `pi_${tag}_D`, amount: 10000, amount_refunded: 2500 } } }), w2);
  assert(emails.length === 1, 'redelivered event sends nothing more');

  console.log('\n[4] ACH payment: copy mentions the bank account');
  const cA = await client('Ash Moon', `ash-${tag}@example.com`);
  const iA = await invoice({ cid: cA, email: `ash-${tag}@example.com`, name: 'Ash Moon', number: 'INV-A1', method: 'ach', pi: `pi_${tag}_A` });
  emails.length = 0;
  await refundInvoice({ workspaceId: wid, id: iA });
  assert(emails.length === 1 && /bank account you paid from/.test(emails[0].html), 'ACH copy');

  console.log('\n[5] client who muted invoice emails: refund still happens, no email');
  const cM = await client('Mo Quiet', `mo-${tag}@example.com`);
  await sql`UPDATE clients SET notification_prefs = '{"invoices": false}'::jsonb WHERE id = ${cM}`;
  const iM = await invoice({ cid: cM, email: `mo-${tag}@example.com`, name: 'Mo Quiet', number: 'INV-M1', method: 'cash' });
  emails.length = 0;
  const rm = await refundInvoice({ workspaceId: wid, id: iM });
  assert(rm.refund.fullyRefunded && emails.length === 0, 'refunded, no email');

  console.log('\n[6] no client email on file: refund still succeeds');
  const iN = await invoice({ cid: null, email: null, name: 'Walk-in', number: 'INV-N1', method: 'cash' });
  emails.length = 0;
  const rn = await refundInvoice({ workspaceId: wid, id: iN });
  assert(rn.refund.fullyRefunded && emails.length === 0, 'refunded, nothing sent');

  console.log('\n[7] an email outage never fails the refund');
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('resend.com') ? Promise.reject(new TypeError('fetch failed')) : saved(url, init));
  const cO = await client('Oz Out', `oz-${tag}@example.com`);
  const iO = await invoice({ cid: cO, email: `oz-${tag}@example.com`, name: 'Oz Out', number: 'INV-O1', method: 'check' });
  let threw = null;
  try { await refundInvoice({ workspaceId: wid, id: iO }); } catch (err) { threw = err; }
  globalThis.fetch = saved;
  const oRow = (await sql`SELECT status FROM invoices WHERE id = ${iO}`).rows[0];
  assert(!threw && oRow.status === 'refunded', 'refund recorded despite the email failure');

  console.log('\n[8] copy rules');
  const sample = renderInvoiceRefunded({ business: 'Glow', firstName: 'Kay', number: 'INV-1', amount: 50, remaining: 0, fullyRefunded: true, method: 'card', online: true });
  assert(!/—/.test(sample.html + sample.subject), 'no em dashes');
  assert(!/claude|anthropic|stripe|resend/i.test(sample.html.replace(/<!--[\s\S]*?-->/g, '')), 'no vendor names in the client email');
  assert(/<script/i.test(sample.html) === false, 'no scripts');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((err) => { console.error('crashed:', err); process.exit(1); });

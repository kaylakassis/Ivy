// A failed payment return shows a fixed message picked by code, never text
// from the URL (?payment=error&msg=... used to be printed as-is).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/payment-error-codes.test.mjs
import { readFileSync } from 'node:fs';
import paypalReturn, { paymentErrorCode } from '../api/finance/paypal-return.js';
import { paymentErrorMessage, PAYMENT_ERROR_MESSAGES, GENERIC_PAYMENT_ERROR } from '../src/lib/paymentErrors.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {},
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
  };
}

async function run() {
  console.log('\n[1] code → fixed message');
  assert(GENERIC_PAYMENT_ERROR === 'Something went wrong with the payment. Please try again.', 'generic message wording');
  for (const code of Object.keys(PAYMENT_ERROR_MESSAGES)) {
    assert(paymentErrorMessage(code) === PAYMENT_ERROR_MESSAGES[code], `known code "${code}"`);
  }
  for (const junk of [null, undefined, '', 'Call 555-0100 to fix your card', '__proto__', 'toString', 'constructor', 42]) {
    assert(paymentErrorMessage(junk) === GENERIC_PAYMENT_ERROR, `unknown code ${JSON.stringify(junk)} → generic`);
  }
  assert(Object.values(PAYMENT_ERROR_MESSAGES).concat(GENERIC_PAYMENT_ERROR).every((m) => !/[\u2013\u2014]/.test(m)), 'no dashes in any message');

  console.log('\n[2] server classifies failures into codes the page knows');
  assert(paymentErrorCode(new Error('PayPal capture failed (422): {"details":[{"issue":"INSTRUMENT_DECLINED"}]}')) === 'declined', 'declined');
  assert(paymentErrorCode(new Error('PayPal is not connected for this workspace')) === 'unavailable', 'not connected → unavailable');
  assert(paymentErrorCode(new Error('socket hang up')) === 'failed', 'anything else → failed');
  for (const c of ['declined', 'unavailable', 'failed']) {
    assert(Object.prototype.hasOwnProperty.call(PAYMENT_ERROR_MESSAGES, c), `server code "${c}" has a page message`);
  }

  console.log('\n[3] the redirect carries a code, never free text, and drops any ?msg=');
  const res = mockRes();
  await paypalReturn({ method: 'GET', query: { next: '/book/demo?msg=Call%20555-0100%20now' }, headers: {} }, res);
  const loc = new URL(res.headers.Location);
  assert(res.statusCode === 302, 'redirects');
  assert(loc.searchParams.get('payment') === 'error' && loc.searchParams.get('reason') === 'failed', `payment=error&reason=failed (${loc.search})`);
  assert(!loc.searchParams.has('msg'), 'no msg param in the redirect');

  console.log('\n[4] the pages never read ?msg=');
  for (const f of ['src/features/calendar/PublicBooking.jsx', 'src/features/finance/PublicInvoice.jsx']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert(!/get\(\s*['"]msg['"]\s*\)/.test(src), `${f} does not display ?msg=`);
    assert(/paymentErrorMessage\(/.test(src), `${f} uses the fixed messages`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });

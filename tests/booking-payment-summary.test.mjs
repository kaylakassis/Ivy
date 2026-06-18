// Tests computeBookingPayment - the unified appointment-total summary that
// merges the deposit + the "collect on the spot" balance invoice so owner
// and client both see whether the whole service has been paid.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/booking-payment-summary.test.mjs

import { computeBookingPayment } from '../api/_lib/calendar.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function run() {
  console.log('\n[1] deposit + collected balance = fully paid');
  const p = computeBookingPayment({ booking_total: 200, deposit_paid: 50, collect_invoice_status: 'paid', collect_invoice_paid_amount: 150 });
  assert(p && p.total === 200 && p.depositPaid === 50, 'total + deposit reflected');
  assert(p.amountPaid === 200 && p.balanceDue === 0 && p.fullyPaid === true, '$50 deposit + $150 balance = $200 fully paid');

  console.log('\n[2] deposit only, balance not yet collected → balance due');
  const q = computeBookingPayment({ booking_total: 200, deposit_paid: 50 });
  assert(q.balanceDue === 150 && q.fullyPaid === false && q.amountPaid === 50, '$150 balance still due');
  const q2 = computeBookingPayment({ booking_total: 200, deposit_paid: 50, collect_invoice_status: 'sent', collect_invoice_paid_amount: 0 });
  assert(q2.balanceDue === 150 && q2.fullyPaid === false, 'an unpaid (sent) balance invoice does not count');

  console.log('\n[3] deposit covers the whole total → fully paid');
  const r = computeBookingPayment({ booking_total: 80, deposit_paid: 80 });
  assert(r.fullyPaid === true && r.balanceDue === 0, 'deposit equal to total is fully paid');

  console.log('\n[4] $0 / untotaled booking → no summary');
  assert(computeBookingPayment({ booking_total: 0, deposit_paid: 0 }) === null, 'zero-total booking returns null');
  assert(computeBookingPayment({}) === null, 'missing total returns null');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

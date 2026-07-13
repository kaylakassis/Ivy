// Pure projection behind the onboarding "Here's what Ivy sees for you"
// proof step (src/features/onboarding/impact.js). React-free, so we can
// import and assert directly with no DOM.
//
// Run: node ./tests/onboarding-impact.test.mjs
import { computeImpact } from '../src/features/onboarding/impact.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

console.log('\n[1] every output is a finite, non-negative number');
const base = computeImpact({ challengeIds: [], stageIds: [], businessType: 'both' });
for (const k of ['clientsPerMonth', 'reclaimedHours', 'noShowsPrevented', 'recovered', 'toolSavings', 'totalUpside']) {
  assert(Number.isFinite(base[k]) && base[k] >= 0, `${k} is a non-negative number (${base[k]})`);
}
assert(base.totalUpside === base.recovered + base.toolSavings, 'totalUpside = recovered + toolSavings');
assert(base.toolSavings > 100, 'tool savings exceeds $100/mo (stack minus Ivy)');

console.log('\n[2] emphasis keys off the stated pain point');
assert(computeImpact({ challengeIds: ['getting_paid'] }).emphasis === 'recovered', 'getting_paid → emphasis recovered');
assert(computeImpact({ challengeIds: ['no_shows'] }).emphasis === 'recovered', 'no_shows → emphasis recovered');
assert(computeImpact({ challengeIds: ['organized'] }).emphasis === 'hours', 'organized → emphasis hours');
assert(computeImpact({ challengeIds: ['leads'] }).emphasis === 'total', 'unmapped challenge → emphasis total');
assert(computeImpact({ challengeIds: [] }).emphasis === 'total', 'no challenge → emphasis total');
// getting_paid wins even when combined with an hours-leaning pain.
assert(computeImpact({ challengeIds: ['organized', 'getting_paid'] }).emphasis === 'recovered', 'money pain outranks time pain');

console.log('\n[3] business stage scales client volume → recovered revenue is monotonic');
const starting = computeImpact({ stageIds: ['starting'], businessType: 'service' });
const scaling  = computeImpact({ stageIds: ['scaling'],  businessType: 'service' });
assert(scaling.clientsPerMonth > starting.clientsPerMonth, 'scaling implies more clients than starting');
assert(scaling.recovered >= starting.recovered, 'more clients → at least as much recovered revenue');

console.log('\n[4] product-only businesses take no appointments → no no-show recovery');
const product = computeImpact({ stageIds: ['scaling'], businessType: 'product' });
assert(product.noShowsPrevented === 0, 'product business has no no-show recovery');
assert(product.takesAppointments === false, 'product business takesAppointments=false');
assert(product.reclaimedHours > 0, 'product business still reclaims admin hours');

console.log('\n[5] robust to junk / missing input (never throws, always shaped)');
const empty = computeImpact();
assert(Number.isFinite(empty.totalUpside), 'no-arg call returns a finite total');
const junk = computeImpact({ challengeIds: 'nope', stageIds: null, businessType: 42 });
assert(Number.isFinite(junk.totalUpside) && junk.emphasis === 'total', 'junk input falls back cleanly');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

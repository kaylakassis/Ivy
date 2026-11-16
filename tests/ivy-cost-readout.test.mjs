// The Readiness page's "Ivy cost (30 days)" line is what cost decisions are
// made from, so its prices and its breakdown are pinned here.
import { readFileSync } from 'node:fs';
import { MODEL_PRICES } from '../api/_lib/ivyPricing.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// [input, output, cache read, cache write (1 hour)] per million tokens.
for (const [model, row] of Object.entries(MODEL_PRICES)) {
  const [inp, out, read, write] = row;
  assert(row.length === 4 && row.every((n) => Number.isFinite(n) && n > 0), `${model}: four prices`);
  assert(Math.abs(write - inp * 2) < 1e-9, `${model}: the one-hour cache write is priced at twice the input rate`);
  assert(read < inp && out > inp, `${model}: reusing instructions is cheaper than new input, replies cost more`);
}
assert(JSON.stringify(MODEL_PRICES['claude-sonnet-5-5']) === JSON.stringify([2, 10, 0.1, 4]), 'the model Ivy runs on by default is priced as listed on 2026-11-16');

const page = readFileSync(new URL('../api/admin/prod-readiness.js', import.meta.url), 'utf8');
assert(/Where it went: \$\{pct\(parts\.reload\)\}% reloading Ivy's instructions after a quiet hour/.test(page), 'the cost line says how much went on reloading instructions after a quiet hour');
assert(/\$\{pct\(parts\.reread\)\}% reusing them, \$\{pct\(parts\.fresh\)\}% new input, \$\{pct\(parts\.reply\)\}% replies/.test(page), 'and splits the rest into reuse, new input and replies');

// The daily ceiling: when it is reached Ivy stops for everyone, so the
// operator must be able to see it and how close usage comes.
process.env.DATABASE_URL ||= 'postgres://x:y@localhost/z';
const { globalIvyCeiling } = await import('../api/_lib/ivy.js');
delete process.env.IVY_GLOBAL_DAILY_TOKEN_CAP; delete process.env.IVY_GLOBAL_DAILY_REQUEST_CAP;
let c = await globalIvyCeiling();
assert(c.tokenCap === 5_000_000 && c.requestCap === 50_000 && !c.tokenCapSet && !c.requestCapSet, 'with nothing set, the built-in limits apply and are reported as defaults');
process.env.IVY_GLOBAL_DAILY_TOKEN_CAP = '20000000';
c = await globalIvyCeiling();
assert(c.tokenCap === 20_000_000 && c.tokenCapSet && !c.requestCapSet, 'a limit set in the environment is used and reported as set');
delete process.env.IVY_GLOBAL_DAILY_TOKEN_CAP;
assert(typeof c.usage?.tokens === 'number' && typeof c.usage?.requests === 'number', "today's usage comes back as numbers");
assert(/check\('ai_ceiling', 'Ivy daily ceiling', Math\.max\(todayPct, peakPct\) >= 70 \? 'warn' : 'ok'/.test(page), 'Readiness shows the ceiling and warns once a day reaches 70% of it');
assert(/Ivy stops answering for everyone until midnight UTC/.test(page) && /add \$\{name\} in Vercel to change it/.test(page), 'the line says what happens at the ceiling and where to change it');

console.log(`\n${pass} passed, ${fail} failed`);

process.exit(fail ? 1 : 0);

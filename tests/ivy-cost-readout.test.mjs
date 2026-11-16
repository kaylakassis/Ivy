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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

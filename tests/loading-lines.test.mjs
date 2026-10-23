// Playful loading lines (src/components/motion/loadingLines.js): the owner
// set has exactly the 24 approved lines about Ivy, the client set exactly
// the 26 approved lines, copy rules hold (no em dashes, no vendor names),
// and the picker never hands back the line it just showed.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/loading-lines.test.mjs

import { LOADING_LINES, CLIENT_LOADING_LINES, pickNext, nextLine } from '../src/components/motion/loadingLines.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const VENDORS = /anthropic|claude|openai|chatgpt|gpt|gemini|google|microsoft|stripe|square|paypal|twilio|resend|vercel|neon/i;

console.log('owner set');
assert(Array.isArray(LOADING_LINES) && LOADING_LINES.length === 24, '24 owner lines');
assert(LOADING_LINES.every((l) => l.startsWith('Loading… Ivy is')), 'every owner line starts with "Loading… Ivy is"');
assert(LOADING_LINES.every((l) => !l.includes('—')), 'no em dash in owner lines');
assert(LOADING_LINES.every((l) => !VENDORS.test(l)), 'no vendor name in owner lines');
assert(new Set(LOADING_LINES).size === LOADING_LINES.length, 'owner lines are unique');

console.log('client set');
assert(Array.isArray(CLIENT_LOADING_LINES) && CLIENT_LOADING_LINES.length === 26, '26 client lines');
assert(CLIENT_LOADING_LINES.every((l) => l.startsWith('Loading…')), 'every client line starts with "Loading…"');
assert(CLIENT_LOADING_LINES.every((l) => !l.includes('—')), 'no em dash in client lines');
assert(CLIENT_LOADING_LINES.every((l) => !VENDORS.test(l)), 'no vendor name in client lines');
assert(new Set(CLIENT_LOADING_LINES).size === CLIENT_LOADING_LINES.length, 'client lines are unique');

console.log('picker');
for (const [name, lines] of [['owner', LOADING_LINES], ['client', CLIENT_LOADING_LINES]]) {
  let prev = pickNext(null, lines);
  let repeats = 0, outOfRange = 0;
  for (let i = 0; i < 500; i++) {
    const n = pickNext(prev, lines);
    if (n === prev) repeats++;
    if (!Number.isInteger(n) || n < 0 || n >= lines.length) outOfRange++;
    prev = n;
  }
  assert(repeats === 0, `${name}: pickNext never returns prev across 500 draws`);
  assert(outOfRange === 0, `${name}: pickNext always returns a valid index`);
}
// Edge: pickNext with prev at either end still never repeats and stays in range.
assert([...Array(200)].every(() => pickNext(0, LOADING_LINES) !== 0), 'prev=0 never repeats');
assert([...Array(200)].every(() => pickNext(LOADING_LINES.length - 1, LOADING_LINES) !== LOADING_LINES.length - 1), 'prev=last never repeats');
// Session-level picker: consecutive lines differ per set.
let last = nextLine('owner'), dupes = 0;
for (let i = 0; i < 200; i++) { const l = nextLine('owner'); if (l === last) dupes++; last = l; }
assert(dupes === 0, 'nextLine("owner") never repeats back to back');
last = nextLine('client'); dupes = 0;
for (let i = 0; i < 200; i++) { const l = nextLine('client'); if (l === last) dupes++; last = l; }
assert(dupes === 0, 'nextLine("client") never repeats back to back');
assert(CLIENT_LOADING_LINES.includes(nextLine('client')), 'nextLine("client") draws from the client set');
assert(LOADING_LINES.includes(nextLine('owner')), 'nextLine("owner") draws from the owner set');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

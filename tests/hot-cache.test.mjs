// Unit tests for the in-process hot cache (api/_lib/hotCache.js).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/hot-cache.test.mjs

import { get, set, invalidate, getOrSet, _resetForTests } from '../api/_lib/hotCache.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

console.log('\n[1] get/set/invalidate round-trip');
_resetForTests();
assert(get('k') === undefined, 'miss → undefined');
set('k', 'v1', 1000);
assert(get('k') === 'v1', 'set then get returns the value');
invalidate('k');
assert(get('k') === undefined, 'invalidate clears');

console.log('\n[2] TTL expiry');
_resetForTests();
set('k', 'v', 10); // 10ms TTL
await new Promise((r) => setTimeout(r, 30));
assert(get('k') === undefined, 'expired entry returns undefined');

console.log('\n[3] LRU eviction caps memory');
_resetForTests();
// CACHE_MAX is 500 internally — overflow by 50 and verify the oldest are gone.
for (let i = 0; i < 550; i++) set(`k${i}`, i, 10_000);
assert(get('k0') === undefined, 'oldest entry evicted after overflow');
assert(get('k549') === 549, 'newest entry retained');

console.log('\n[4] getOrSet — loader runs once per key');
_resetForTests();
let calls = 0;
const v1 = await getOrSet('k', 1000, async () => { calls++; return 42; });
const v2 = await getOrSet('k', 1000, async () => { calls++; return 99; });
assert(v1 === 42 && v2 === 42, 'second call returns first value');
assert(calls === 1, 'loader fires only once');

console.log('\n[5] getOrSet — concurrent calls share the in-flight Promise');
_resetForTests();
let runs = 0;
const slow = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return 'done'; };
const [a, b, c] = await Promise.all([
  getOrSet('k', 1000, slow),
  getOrSet('k', 1000, slow),
  getOrSet('k', 1000, slow),
]);
assert(a === 'done' && b === 'done' && c === 'done', 'all three see the same result');
assert(runs === 1, 'loader fires once across 3 concurrent calls');

console.log('\n[6] getOrSet — undefined return does NOT cache (re-fetched next time)');
_resetForTests();
let undefCalls = 0;
const undefLoader = async () => { undefCalls++; return undefined; };
await getOrSet('k', 1000, undefLoader);
await getOrSet('k', 1000, undefLoader);
assert(undefCalls === 2, 'undefined is treated as "no value, retry"');

console.log('\n[7] getOrSet — null IS cached (DB returned "row absent")');
_resetForTests();
let nullCalls = 0;
const nullLoader = async () => { nullCalls++; return null; };
await getOrSet('k', 1000, nullLoader);
await getOrSet('k', 1000, nullLoader);
assert(nullCalls === 1, 'null is cached so the second call short-circuits');

console.log('\n[8] LRU touch on read keeps hot keys alive');
_resetForTests();
set('hot', 'a', 10_000);
for (let i = 0; i < 510; i++) {
  set(`f${i}`, i, 10_000);
  // Read 'hot' every iteration so it stays at the LRU tail.
  if (i % 5 === 0) get('hot');
}
assert(get('hot') === 'a', 'hot key survives 510 inserts because it was touched');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

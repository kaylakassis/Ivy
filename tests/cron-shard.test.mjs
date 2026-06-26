// Unit tests for the cron-shard + deadline helper (pure functions, no DB).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/cron-shard.test.mjs

import { shardFromReq, shardClause, withDeadline } from '../api/_lib/cronShard.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

console.log('\n[1] shardFromReq — defaults preserve historical behavior');
assert(JSON.stringify(shardFromReq({})) === '{"shard":0,"shards":1}', 'empty req → {shard:0, shards:1}');
assert(JSON.stringify(shardFromReq({ query: {} })) === '{"shard":0,"shards":1}', 'empty query → defaults');
assert(JSON.stringify(shardFromReq()) === '{"shard":0,"shards":1}', 'no req → defaults');

console.log('\n[2] shardFromReq — valid sharded params');
const r = shardFromReq({ query: { shard: '2', shards: '4' } });
assert(r.shard === 2 && r.shards === 4, 'shard=2&shards=4 round-trips');

console.log('\n[3] shardFromReq — clamping');
assert(shardFromReq({ query: { shards: '999' } }).shards === 64, 'shards>64 clamps to 64');
assert(shardFromReq({ query: { shards: '0' } }).shards === 1, 'shards=0 clamps to 1');
assert(shardFromReq({ query: { shards: '-5' } }).shards === 1, 'shards=-5 clamps to 1');
assert(shardFromReq({ query: { shard: '10', shards: '4' } }).shard === 3, 'shard out of range clamps to shards-1');
assert(shardFromReq({ query: { shard: '-1', shards: '4' } }).shard === 0, 'shard negative clamps to 0');
assert(shardFromReq({ query: { shards: 'banana' } }).shards === 1, 'non-numeric shards → default');
assert(shardFromReq({ query: { shard: 'banana', shards: '4' } }).shard === 0, 'non-numeric shard → default 0');

console.log('\n[4] shardClause — unsharded returns empty string');
assert(shardClause({ shard: 0, shards: 1 }) === '', 'shards=1 → empty (no filter)');
assert(shardClause({ shard: 0, shards: 1 }, 'w.id') === '', 'shards=1 with columnRef → empty');
assert(shardClause({ shard: 5, shards: 0 }) === '', 'shards=0 → empty (guard against bad input)');

console.log('\n[5] shardClause — sharded returns ` AND ` prefix + hash math');
const clause = shardClause({ shard: 2, shards: 4 }, 'w.id');
assert(clause.startsWith(' AND '), 'clause starts with leading AND so it splices into any WHERE');
assert(clause.includes('hashtext(w.id::text)'), 'hashtext applied to the column reference');
assert(clause.includes('% 4 + 4) % 4'), 'non-negative bucket math present');
assert(clause.endsWith(' = 2'), 'matches the requested shard id');

console.log('\n[6] shardClause — custom column references work');
assert(shardClause({ shard: 0, shards: 2 }, 'workspace_id').includes('hashtext(workspace_id::text)'), 'default-style ref');
assert(shardClause({ shard: 0, shards: 2 }, 'r.workspace_id').includes('hashtext(r.workspace_id::text)'), 'aliased ref');

console.log('\n[7] shardClause — refuses unsafe column refs (defense against accidental injection)');
let threw = false;
try { shardClause({ shard: 0, shards: 2 }, "w.id; DROP TABLE workspaces"); }
catch { threw = true; }
assert(threw, 'rejects ref with semicolon');
threw = false;
try { shardClause({ shard: 0, shards: 2 }, "1 OR 1=1"); }
catch { threw = true; }
assert(threw, 'rejects ref starting with non-ident char');
threw = false;
try { shardClause({ shard: 0, shards: 2 }, ""); }
catch { threw = true; }
assert(threw, 'rejects empty ref');

console.log('\n[8] withDeadline — passes a future deadline to fn');
let received = null;
const startBefore = Date.now();
await withDeadline(async (deadline) => { received = deadline; }, { budgetMs: 5_000, safetyMs: 1_000 });
assert(received !== null, 'fn was called');
assert(received > startBefore, 'deadline is in the future');
assert(received - startBefore <= 5_000, 'deadline is within the budget');
assert(received - startBefore >= 3_000, 'deadline accounts for the safety margin (budget - safety)');

console.log('\n[9] withDeadline — budget defaults to ~270s budget / 30s safety');
const t0 = Date.now();
let defaultDeadline = null;
await withDeadline(async (d) => { defaultDeadline = d; });
const window = defaultDeadline - t0;
assert(window >= 200_000 && window <= 260_000, `default deadline window ~240s (got ${window}ms)`);

console.log('\n[10] withDeadline — clamps absurd budgets to the Vercel ceiling');
let clamped = null;
const t1 = Date.now();
await withDeadline(async (d) => { clamped = d; }, { budgetMs: 10_000_000, safetyMs: 0 });
assert(clamped - t1 <= 290_000, 'budget > 290s clamps to 290s');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

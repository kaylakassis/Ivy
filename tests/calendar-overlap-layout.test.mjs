// Calendar tiles that overlap in time sit side by side instead of one
// covering the next (Kayla's Monday: "Call Tim" 10:30 to 11:30 hid the
// 11:00 to 12:00 item's title).
import { layoutOverlaps, tileX, hex6 } from '../src/features/calendar/utils.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const ev = (id, s, e, extra = {}) => ({ id, startMin: s * 60, endMin: e * 60, ...extra });

// Kayla's day from the screenshot.
const greg = ev('greg', 8, 9), sally = ev('sally', 9, 10), tim = ev('tim', 10.5, 11.5),
  hidden = ev('hidden', 11, 12), bryce = ev('bryce', 12.5, 13.5), workshop = ev('workshop', 13.5, 14.5),
  jojo = ev('jojo', 16, 17);
const day = [greg, sally, tim, hidden, bryce, workshop, jojo];
const pos = layoutOverlaps(day);

assert(pos.get(tim).cols === 2 && pos.get(hidden).cols === 2, 'the 10:30 and 11:00 items split the width');
assert(pos.get(tim).col !== pos.get(hidden).col, '...in different columns, so both titles show');
for (const x of [greg, sally, bryce, workshop, jojo]) {
  assert(pos.get(x).cols === 1 && pos.get(x).span === 1, `${x.id} (no overlap) keeps the full width`);
}
assert(pos.get(greg).cols === 1 && pos.get(sally).cols === 1, 'back-to-back items (9:00 end, 9:00 start) are not treated as overlapping');

// Three-way: A 9-12, B 9-10, C 10-11 -> 2 columns; B and C share column 1.
const a = ev('a', 9, 12), b = ev('b', 9, 10), c = ev('c', 10, 11);
const p3 = layoutOverlaps([c, b, a]);
assert(p3.get(a).cols === 2 && p3.get(b).col === p3.get(c).col, 'a later item reuses a column that has freed up');

// Widening: A 9-11, B 9-10, C 9-10 -> 3 cols; D 10-11 sits under B and widens over C's free space.
const A = ev('A', 9, 11), B = ev('B', 9, 10), C = ev('C', 9, 10), D = ev('D', 10, 11);
const p4 = layoutOverlaps([A, B, C, D]);
assert(p4.get(A).cols === 3, 'three items starting together get three columns');
assert(p4.get(D).span === 2, 'an item widens into an empty column to its right');

// Short items are treated as their drawn height so a 10 minute tile does not get covered.
const s1 = { id: 's1', startMin: 600, endMin: 610 }, s2 = { id: 's2', startMin: 615, endMin: 640 };
assert(layoutOverlaps([s1, s2]).get(s1).cols === 1, 'without a minimum, 10:00-10:10 and 10:15 do not overlap');
assert(layoutOverlaps([s1, s2], 23).get(s1).cols === 2, 'with the drawn minimum they sit side by side');

// All-day and malformed items are left out (all-day ones show in their own strip).
const p5 = layoutOverlaps([ev('x', 9, 10), { id: 'ad', allDay: true, startMin: 0, endMin: 1440 }, { id: 'bad' }]);
assert(p5.size === 1, 'all-day and malformed items are not placed in the hour grid');

// Geometry.
assert(tileX(undefined, 6).left === 6 && tileX(undefined, 6).width === 'calc(100% - 12px)', 'a lone tile fills the column');
const second = tileX({ col: 1, cols: 2, span: 1 }, 6, 4);
assert(second.left === 'calc(6px + (100% - 12px) / 2 * 1)' && second.width === 'calc((100% - 12px) / 2 * 1 - 0px)', 'the right-hand tile starts halfway');
assert(tileX({ col: 0, cols: 2, span: 1 }, 6, 4).width.endsWith('- 4px)'), 'a gap separates side-by-side tiles');

assert(hex6('#abc') === '#aabbcc' && hex6('#3b82f6') === '#3b82f6' && hex6(null) === null, 'short colors expand so tinted backgrounds stay valid');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

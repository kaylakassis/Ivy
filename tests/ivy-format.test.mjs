// Unit tests for Ivy's reply formatting helpers (pure, DB-free):
//   sanitizeIvyReply   - strips em/en dashes + literal "--" and markdown
//                        we don't render, but PRESERVES **bold**.
//   stripInlineMarkdown - flattens inline markup for plain-text previews.
import assert from 'node:assert';
import { sanitizeIvyReply, stripInlineMarkdown } from '../api/_lib/ivy.js';

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok - ${label}`); };

check('spaced em-dash becomes a comma', () => {
  assert.strictEqual(sanitizeIvyReply('Revenue is up — keep going'), 'Revenue is up, keep going');
});

check('tight em-dash becomes a hyphen', () => {
  assert.strictEqual(sanitizeIvyReply('low—high'), 'low-high');
});

check('en-dash is handled too', () => {
  assert.strictEqual(sanitizeIvyReply('9 – 5'), '9, 5');
});

check('literal double-hyphen collapses', () => {
  assert.strictEqual(sanitizeIvyReply('wait -- what'), 'wait - what');
});

check('bold markup is preserved for the renderer', () => {
  assert.strictEqual(sanitizeIvyReply('You earned **$1,200** this month'), 'You earned **$1,200** this month');
});

check('no em-dash survives anywhere', () => {
  const out = sanitizeIvyReply('a — b — c—d');
  assert.ok(!/[—–]/.test(out), `em/en dash leaked: ${out}`);
});

check('markdown headings are stripped', () => {
  assert.strictEqual(sanitizeIvyReply('## Summary\nAll good'), 'Summary\nAll good');
});

check('stripInlineMarkdown flattens bold/code for previews', () => {
  assert.strictEqual(stripInlineMarkdown('Send **now**, run `sync`'), 'Send now, run sync');
});

check('stripInlineMarkdown leaves no asterisks', () => {
  const out = stripInlineMarkdown('**a** *b* `c`');
  assert.ok(!out.includes('*') && !out.includes('`'), `markup leaked: ${out}`);
});

console.log(`\n${passed} passed, 0 failed`);

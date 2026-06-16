// Static wiring test for Ivy's tool registry. Runs without a database —
// it only loads module-level metadata, never executes a tool. Catches the
// classic mistakes when adding a tool: a schema with no handler, an orphan
// handler with no schema, a duplicate name, or a sensitive tool that isn't
// a real tool.
import assert from 'node:assert';
import { IVY_TOOLS, HANDLERS, SENSITIVE_TOOLS } from '../api/_lib/ivyTools.js';

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok - ${label}`); };

const toolNames = IVY_TOOLS.map((t) => t.name);
const handlerNames = Object.keys(HANDLERS);

check('no duplicate tool names', () => {
  assert.strictEqual(new Set(toolNames).size, toolNames.length,
    'duplicate name in IVY_TOOLS');
});

check('every tool has a handler', () => {
  const missing = toolNames.filter((n) => typeof HANDLERS[n] !== 'function');
  assert.deepStrictEqual(missing, [], `tools without a handler: ${missing.join(', ')}`);
});

check('no orphan handlers', () => {
  const orphans = handlerNames.filter((n) => !toolNames.includes(n));
  assert.deepStrictEqual(orphans, [], `handlers without a schema: ${orphans.join(', ')}`);
});

check('every tool schema is well-formed', () => {
  for (const t of IVY_TOOLS) {
    assert.ok(t.name && typeof t.name === 'string', 'tool missing name');
    assert.ok(t.description, `${t.name} missing description`);
    assert.ok(t.input_schema && t.input_schema.type === 'object', `${t.name} bad input_schema`);
  }
});

check('every sensitive tool is a real tool', () => {
  const bogus = [...SENSITIVE_TOOLS].filter((n) => !toolNames.includes(n));
  assert.deepStrictEqual(bogus, [], `sensitive names not in IVY_TOOLS: ${bogus.join(', ')}`);
});

check('the new expanded tools are registered', () => {
  const expected = [
    'create_quote', 'create_product', 'create_expense', 'create_goal',
    'create_time_entry', 'create_recurring_invoice', 'create_campaign',
    'send_quote', 'send_campaign', 'reschedule_booking',
  ];
  const missing = expected.filter((n) => !toolNames.includes(n));
  assert.deepStrictEqual(missing, [], `expected new tools missing: ${missing.join(', ')}`);
});

check('new sends are confirmation-gated', () => {
  for (const n of ['send_quote', 'send_campaign', 'reschedule_booking']) {
    assert.ok(SENSITIVE_TOOLS.has(n), `${n} should be in SENSITIVE_TOOLS`);
  }
});

console.log(`\n${passed} passed, 0 failed`);

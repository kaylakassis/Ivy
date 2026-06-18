// Catalog shape test for src/features/workflows/templates.js.
// Catches breakage in the static data - types, missing config keys,
// dangling token references - so the picker never offers a template
// that would 400 on save.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/workflow-templates.test.mjs

import { WORKFLOW_TEMPLATES, TEMPLATE_CATEGORIES, getTemplateById }
  from '../src/features/workflows/templates.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

const VALID_TRIGGERS = new Set([
  'lead_created', 'client_created', 'client_inactive', 'booking_completed',
]);
const VALID_ACTION_TYPES = new Set([
  'send_email', 'send_sms', 'create_task', 'send_document',
  'wait', 'if_has_tag', 'if_lacks_tag',
]);

console.log('\n[1] Catalog has reasonable coverage');
assert(WORKFLOW_TEMPLATES.length >= 10, `at least 10 templates (got ${WORKFLOW_TEMPLATES.length})`);
assert(TEMPLATE_CATEGORIES.length >= 3, `at least 3 categories (got ${TEMPLATE_CATEGORIES.length})`);

console.log('\n[2] Every template has a valid shape');
const seenIds = new Set();
for (const t of WORKFLOW_TEMPLATES) {
  const label = (k) => `${t.id || '<no id>'}.${k}`;
  assert(typeof t.id === 'string' && t.id.length > 0, label('id'));
  assert(!seenIds.has(t.id), label('id is unique'));
  seenIds.add(t.id);

  assert(typeof t.category === 'string' && t.category.length > 0, label('category'));
  assert(typeof t.name === 'string' && t.name.length > 0, label('name'));
  assert(typeof t.summary === 'string' && t.summary.length > 0, label('summary'));
  assert(typeof t.description === 'string', label('description'));

  assert(VALID_TRIGGERS.has(t.triggerType), label(`triggerType=${t.triggerType}`));
  assert(t.triggerConfig && typeof t.triggerConfig === 'object', label('triggerConfig'));

  if (t.triggerType === 'client_inactive') {
    assert(Number.isInteger(t.triggerConfig.daysInactive) && t.triggerConfig.daysInactive >= 1,
      label('daysInactive present + ≥ 1'));
  }
  if (t.triggerType === 'booking_completed') {
    assert(Number.isInteger(t.triggerConfig.daysAfter) && t.triggerConfig.daysAfter >= 1,
      label('daysAfter present + ≥ 1'));
  }

  assert(Array.isArray(t.actions) && t.actions.length >= 1, label('has ≥ 1 action'));
  for (let i = 0; i < t.actions.length; i++) {
    const a = t.actions[i];
    assert(VALID_ACTION_TYPES.has(a.type), label(`actions[${i}].type=${a.type}`));
    assert(a.config && typeof a.config === 'object', label(`actions[${i}].config is object`));

    if (a.type === 'send_email') {
      assert(typeof a.config.subject === 'string' && a.config.subject.length > 0,
        label(`actions[${i}] email subject`));
      assert(typeof a.config.body === 'string' && a.config.body.length > 0,
        label(`actions[${i}] email body`));
    }
    if (a.type === 'send_sms') {
      assert(typeof a.config.body === 'string' && a.config.body.length > 0,
        label(`actions[${i}] sms body`));
    }
    if (a.type === 'create_task') {
      assert(typeof a.config.title === 'string' && a.config.title.length > 0,
        label(`actions[${i}] task title`));
    }
    if (a.type === 'wait') {
      const d = Number(a.config.days || 0);
      const h = Number(a.config.hours || 0);
      assert(d + h > 0, label(`actions[${i}] wait has a non-zero duration`));
    }
    if (a.type === 'if_has_tag' || a.type === 'if_lacks_tag') {
      assert(typeof a.config.tag === 'string' && a.config.tag.length > 0,
        label(`actions[${i}] ${a.type} has a tag`));
    }
  }
}

console.log('\n[3] Only known tokens appear in user-facing text');
// Tokens listed in api/_lib/workflows.js (the executor resolves these).
const KNOWN_TOKENS = new Set([
  'firstName', 'clientName', 'businessName', 'ownerName',
]);
const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
for (const t of WORKFLOW_TEMPLATES) {
  for (let i = 0; i < t.actions.length; i++) {
    const a = t.actions[i];
    const blobs = [
      a.config.subject, a.config.body, a.config.title, a.config.notes,
    ].filter(Boolean);
    for (const blob of blobs) {
      for (const m of String(blob).matchAll(TOKEN_RE)) {
        const name = m[1];
        assert(KNOWN_TOKENS.has(name),
          `${t.id} actions[${i}]: token {{${name}}} is in KNOWN_TOKENS`);
      }
    }
  }
}

console.log('\n[4] getTemplateById returns deep-cloned copies');
const a = getTemplateById('welcome-new-client');
const b = getTemplateById('welcome-new-client');
assert(a !== null, 'known id resolves');
assert(a !== b, 'two getById calls return different object references');
assert(a.actions !== b.actions, 'actions arrays are not shared');
assert(a.actions[0] !== b.actions[0], 'inner action objects are not shared');
assert(a.actions[0].config !== b.actions[0].config, 'inner configs are not shared');
a.actions[0].config.subject = 'mutated';
const c = getTemplateById('welcome-new-client');
assert(c.actions[0].config.subject !== 'mutated',
  'mutating a cloned template does NOT bleed into a fresh getById');
assert(getTemplateById('nope-not-a-real-id') === null, 'unknown id returns null');

console.log('\n[5] if_has_tag / if_lacks_tag have something after them');
// A workflow that ENDS on a conditional is a no-op - flag any template
// where the last action is a conditional.
for (const t of WORKFLOW_TEMPLATES) {
  const last = t.actions[t.actions.length - 1];
  assert(last.type !== 'if_has_tag' && last.type !== 'if_lacks_tag',
    `${t.id}: conditional is not the last action`);
}

console.log('\n────────────────────────────');
console.log(`Pass: ${pass}  Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);

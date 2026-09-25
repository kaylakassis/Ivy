// The technology behind Ivy is confidential. Nothing a user can see may
// name the AI vendor or model: app screens, the assistant's own replies,
// failure wording, API responses to the browser, legal and marketing pages.
// Operator-only surfaces (the super-admin readiness page, server logs,
// Sentry) keep the real detail so problems stay fixable.
// Run: node --import ./tests/bootstrap.mjs ./tests/no-provider-leak.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { userFacingReason, explainProviderError } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
// Ivy's own vendor and model family. Competitor names on the marketing
// comparison page ("ChatGPT on the side") are about other products and stay.
const VENDOR = /\b(anthropic|claude)\b/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
// Same, but for any extensions (site HTML, built output, source maps).
function walkExt(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkExt(p, exts, out); else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
// Strip line comments and block comments, keep everything else (strings,
// JSX text, template literals) - the parts that can reach a screen.
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

console.log('\n[1] app screens: no vendor or model names in anything renderable');
const leaks = [];
for (const f of walk('src')) {
  const code = codeOnly(fs.readFileSync(f, 'utf8'));
  code.split('\n').forEach((line, i) => { if (VENDOR.test(line)) leaks.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`); });
}
assert(leaks.length === 0, leaks.length ? `vendor names found:\n    ${leaks.join('\n    ')}` : 'src/ is clean');

console.log('\n[1b] marketing site HTML, blog and the built app');
const staticLeaks = [];
const staticFiles = [...walkExt('public', ['.html', '.webmanifest', '.txt', '.xml']), 'index.html'];
if (fs.existsSync('dist')) staticFiles.push(...walkExt('dist', ['.js', '.html', '.css', '.json', '.txt', '.xml']));
for (const f of staticFiles) {
  const text = fs.readFileSync(f, 'utf8');
  const m = text.match(VENDOR);
  if (m) staticLeaks.push(`${f}: …${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…`);
}
assert(staticLeaks.length === 0, staticLeaks.length ? `vendor names found:\n    ${staticLeaks.join('\n    ')}` : `${staticFiles.length} static/built files are clean${fs.existsSync('dist') ? ' (dist included)' : ''}`);
assert(!fs.existsSync('dist') || walkExt('dist', ['.map']).length === 0, 'no source maps in the built output');

console.log('\n[1c] operator-only readiness text names no vendor either');
const readiness = fs.readFileSync('api/admin/prod-readiness.js', 'utf8').replace(/process\.env\.[A-Z_]+/g, '');
assert(!VENDOR.test(readiness), 'prod-readiness labels and details are neutral');
for (const e of [Object.assign(new Error('credit balance too low'), { status: 400 }), Object.assign(new Error('invalid x-api-key'), { status: 401 }), Object.assign(new Error('overloaded'), { status: 529 })]) {
  const r = explainProviderError(e);
  assert(!VENDOR.test(r), `operator reason for ${e.status}: "${r}"`);
}

console.log('\n[2] the assistant is told to keep the technology confidential');
const ivySrc = fs.readFileSync('api/_lib/ivy.js', 'utf8');
assert(/The technology behind you is confidential\. Never name, confirm, deny, hint at, or compare yourself to any AI company, model, or model family/.test(ivySrc), 'system prompt carries the confidentiality rule');
assert(/I'm Ivy, the assistant built into this app\. I don't share details about the technology behind me\./.test(ivySrc), 'system prompt gives the exact line to say');
assert(/Do not invent or claim a different vendor either/.test(ivySrc), 'rule forbids inventing a different vendor (decline, never lie)');

console.log('\n[3] failure wording the owner sees never names the vendor');
const errs = [
  Object.assign(new Error('Your credit balance is too low'), { status: 400 }),
  Object.assign(new Error('invalid x-api-key'), { status: 401 }),
  Object.assign(new Error('not found'), { status: 404 }),
  Object.assign(new Error('overloaded_error'), { status: 529 }),
  Object.assign(new Error('Request timed out.'), { status: 0 }),
  Object.assign(new Error('Internal server error'), { status: 500 }),
];
for (const e of errs) {
  const r = userFacingReason(e);
  assert(!VENDOR.test(r) && /AI service/.test(r), `${e.status}: "${r}"`);
}
const fallbackLine = ivySrc.match(/I couldn't put together an answer just now: \$\{reason\}/);
assert(!!fallbackLine, 'fallback reply uses the neutral wording');
const attachLine = ivySrc.match(/Full analysis needs Ivy's AI service/);
assert(!!attachLine, 'attachment fallback uses the neutral wording');

console.log('\n[4] the browser is not told which model answers');
const ivyIndex = fs.readFileSync('api/ivy/index.js', 'utf8');
assert(!/^\s*model:/m.test(ivyIndex), 'GET /api/ivy response has no model field');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

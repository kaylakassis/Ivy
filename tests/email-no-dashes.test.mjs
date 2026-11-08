// No long dashes in what Ivy sends (1.0.6 copy rule: no em or en dashes).
//
//   [1] every template in the admin email preview (api/admin/email-preview.js
//       PREVIEW_CATALOGUE, the same render* functions the real sends call)
//       renders with no "—" or "–" (or their HTML entities) in its subject,
//       preheader, HTML or text
//   [2] no string or template literal anywhere in api/ carries one either
//       (emails, texts, pushes and API messages are all built from those),
//       apart from the few places that READ dashes on purpose (listed below
//       with why). Comments and regular expressions are not checked.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/email-no-dashes.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { PREVIEW_CATALOGUE, renderPreview } from '../api/admin/email-preview.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const DASH = /[–—]|&mdash;|&ndash;|&#8211;|&#8212;|&#x201[34];/i;
const where = (s) => {
  const m = DASH.exec(s);
  return m ? JSON.stringify(s.slice(Math.max(0, m.index - 50), m.index + 50)) : '';
};

console.log('\n[1] every email in the admin preview');
assert(PREVIEW_CATALOGUE.length >= 40, `the catalogue lists ${PREVIEW_CATALOGUE.length} emails`);
for (const t of PREVIEW_CATALOGUE) {
  let out;
  try { out = renderPreview(t.id); } catch (e) { out = { error: e.message }; }
  if (!out || out.error) { assert(false, `${t.id} renders (${out?.error || 'no output'})`); continue; }
  const parts = Object.entries(out).filter(([, v]) => typeof v === 'string');
  const bad = parts.filter(([, v]) => DASH.test(v));
  assert(out.subject && out.html && bad.length === 0,
    `${t.id}: no long dash${bad.length ? ` (found in ${bad.map(([k, v]) => `${k}: ${where(v)}`).join('; ')})` : ''}`);
  assert(!DASH.test(t.label), `${t.id}: the picker label has no long dash either`);
}

console.log('\n[2] no long dash in any string in api/');
// Places that hold a dash on purpose: they read or strip dashes, never send one.
const ALLOWED = [
  { file: 'api/_lib/icsParse.js', why: 'splits imported calendar titles on " - ", " – " and " — "', test: (s) => /^' [–—] '$/.test(s) },
  { file: 'api/_lib/ivy.js', why: "Ivy's instructions telling the model never to use them", test: (s) => s.includes('Do NOT use em-dashes or en-dashes') },
  { file: 'api/_lib/schema.js', why: 'SQL comments inside the schema text', test: () => true },
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(m?js)$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'api'));
const found = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/[–—]|&mdash;|&ndash;/.test(src)) continue;
  const rel = path.relative(root, f).split(path.sep).join('/');
  let tokens;
  try { tokens = [...acorn.tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true })]; }
  catch (e) { found.push(`${rel}: could not be read (${e.message})`); continue; }
  for (const t of tokens) {
    if (t.type.label !== 'string' && t.type.label !== 'template') continue;
    const raw = src.slice(t.start, t.end);
    if (!DASH.test(raw)) continue;
    if (ALLOWED.some((a) => a.file === rel && a.test(raw))) continue;
    found.push(`${rel}:${t.loc.start.line} ${where(raw)}`);
  }
}
assert(files.length > 300, `scanned ${files.length} files`);
assert(found.length === 0, `no long dash in a string or template literal${found.length ? `:\n      ${found.join('\n      ')}` : ''}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

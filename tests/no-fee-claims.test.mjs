// Ivy adds no fee of its own, but Stripe, Square and PayPal charge their
// standard processing rates - so nothing Ivy publishes may say "no
// transaction fees", "0% fees", "takes no cut" or the like. Kayla's call:
// the phrase reads as "no fees at all" to a customer. This scans every
// renderable string in the app, the marketing site, the blog and the App
// Store copy.
// Run: node --import ./tests/bootstrap.mjs ./tests/no-fee-claims.test.mjs
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
// "no-show fee" copy ("no fee charges", "no fee collection") is a different
// fee and stays; the pattern needs a transaction/processing/platform qualifier.
const CLAIM = /\b(no|zero|0%|without)\s+(platform\s+)?(transaction|processing|platform)\s+fees?\b|takes?\s+no\s+cut|no\s+cut\s+of|0%\s+of\s+your\s+sales|takes?\s+0%|fees?,\s+forever|no\s+platform\s+percentage|adds\s+nothing\s+on\s+top/i;

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out); else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const files = [
  ...walk('src', ['.js', '.jsx']).map((f) => [f, codeOnly(fs.readFileSync(f, 'utf8'))]),
  ...walk('public', ['.html']).map((f) => [f, fs.readFileSync(f, 'utf8')]),
  ['docs/APP_STORE_LISTING.md', fs.readFileSync('docs/APP_STORE_LISTING.md', 'utf8')],
];
const hits = [];
for (const [f, text] of files) {
  text.split('\n').forEach((line, i) => { const m = line.match(CLAIM); if (m) hits.push(`${f}:${i + 1}: …${line.slice(Math.max(0, m.index - 40), m.index + 60).trim()}…`); });
}
assert(hits.length === 0, hits.length ? `fee claims found:\n    ${hits.join('\n    ')}` : `no "no fees" claims in ${files.length} files`);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// scripts/prerender-adopt.mjs: pages pre-rendered by CI are adopted by the
// Vercel build, with the entry/chunk tags swapped for that build's own.
import { adoptPage } from '../scripts/prerender-adopt.mjs';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const throws = (fn, re, m) => { try { fn(); assert(false, m); } catch (e) { assert(re.test(e.message), `${m} (${e.message})`); } };

const ctx = {
  entryTags: {
    html: '<script type="module" crossorigin src="/assets/index-NEWHASH1.js"></script><link rel="modulepreload" crossorigin href="/assets/router-NEWHASH2.js"><link rel="stylesheet" crossorigin href="/assets/index-NEWHASH3.css">',
    names: new Set(['index.js', 'router.js', 'index.css']),
  },
  assetFiles: new Set(['index-NEWHASH1.js', 'router-NEWHASH2.js', 'index-NEWHASH3.css', 'VerticalPage-NEWHASH4.js', 'web-AAAAAAAA.js', 'web-BBBBBBBB.js']),
  byName: new Map([['VerticalPage.js', ['VerticalPage-NEWHASH4.js']], ['web.js', ['web-AAAAAAAA.js', 'web-BBBBBBBB.js']]]),
};
const page = (extraHead = '', body = '<div id="root"><h1>Hi</h1></div>') => `<!doctype html><html data-prerendered="1"><head><title>T</title>
<script>inline()</script>
<script type="module" crossorigin src="/assets/index-OLDHASH1.js"></script>
<link rel="modulepreload" crossorigin href="/assets/router-OLDHASH2.js">
<link rel="stylesheet" crossorigin href="/assets/index-OLDHASH3.css">
<link rel="modulepreload" as="script" crossorigin href="/assets/VerticalPage-OLDHASH4.js">${extraHead}
</head><body>${body}</body></html>`;

console.log('\n[1] tags swapped for this build');
const out = adoptPage(page(), ctx);
assert(!/OLDHASH/.test(out), 'no tag from the CI build survives');
assert(out.includes('src="/assets/index-NEWHASH1.js"'), 'entry script from this build');
assert(out.includes('href="/assets/index-NEWHASH3.css"'), 'stylesheet from this build');
assert(out.includes('href="/assets/VerticalPage-NEWHASH4.js"'), 'route chunk hint mapped by name');
assert((out.match(/type="module"/g) || []).length === 1, 'exactly one module script');
assert(out.includes('<script>inline()</script>'), 'inline script untouched');
assert(out.includes('<div id="root"><h1>Hi</h1></div>'), 'markup untouched');

console.log('\n[2] ambiguous route chunk name: hint dropped, page still valid');
const amb = adoptPage(page('<link rel="modulepreload" href="/assets/web-OLDHASH9.js">'), ctx);
assert(!/web-/.test(amb), 'ambiguous hint dropped');

console.log('\n[3] fails loudly');
throws(() => adoptPage(page('', '<div id="root"><img src="/assets/photo-ABCDEFGH.png"></div>'), ctx), /markup references/, 'hashed asset in markup');
throws(() => adoptPage(page().replace('</head>', ''), ctx), /no <\/head>/, 'broken document');
const noEntry = { ...ctx, entryTags: { html: '', names: new Set() } };
throws(() => adoptPage(page(), noEntry), /module script missing/, 'no entry script to swap in');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Build step on Vercel: adopt the marketing pages that CI already
// pre-rendered, instead of opening a browser here.
//
// Vercel's build machines lack the system libraries a headless browser
// needs, so the deploy job in .github/workflows/ci.yml runs the full
// `npm run build` (vite + scripts/prerender.mjs in Chromium) on GitHub's
// runner and puts the result in prerender-snapshots/ next to the sources it
// uploads. This script, run by scripts/prerender-step.mjs when that folder
// exists, copies those pages into dist/prerender and swaps every hashed
// /assets/ tag in their <head> for the ones this build produced (chunk
// hashes can differ between the two builds because Vercel's build has the
// project's VITE_ variables). The page markup itself references no hashed
// assets; the script checks that and fails otherwise.
//
// Fails loudly on anything unexpected: a missing page, an asset tag it
// cannot map, or a reference to a file this build did not produce. Nothing
// half-adopted can ship.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, marketingRoutes, prerenderFile } from './_lib/marketing-routes.mjs';

const DIST = path.join(ROOT, 'dist');
const SNAP = path.join(ROOT, 'prerender-snapshots');
const OUT = path.join(DIST, 'prerender');

function fail(msg) {
  console.error(`\n[prerender-adopt] FAILED: ${msg}`);
  process.exit(1);
}

// "/assets/Name-HASH8.ext" -> "Name.ext"
const HASHED = /^\/assets\/(.+)-[A-Za-z0-9_-]{8}\.([a-z0-9]+)$/;
const nameOf = (href) => { const m = href.match(HASHED); return m ? `${m[1]}.${m[2]}` : null; };

// Every <script src> / <link href> that points into /assets/.
const ASSET_TAG = /<(?:script\b[^>]*\bsrc|link\b[^>]*\bhref)="(\/assets\/[^"]+)"[^>]*>(?:<\/script>)?/g;

export function adoptPage(html, { entryTags, assetFiles, byName }) {
  const headEnd = html.indexOf('</head>');
  if (headEnd < 0) throw new Error('no </head>');
  let head = html.slice(0, headEnd);
  const body = html.slice(headEnd);
  if (/\/assets\//.test(body)) throw new Error('page markup references a hashed asset');

  const routeHints = [];
  head = head.replace(ASSET_TAG, (tag, href) => {
    const name = nameOf(href);
    // The entry script, its stylesheet and the shared chunks come from this
    // build's index.html as a block (below).
    if (!name || name === 'index.js' || name === 'index.css' || entryTags.names.has(name)) return '';
    // A route chunk the page preloaded: keep the hint when the name maps to
    // exactly one file of this build; otherwise drop it (only a hint: the
    // app loads the chunk itself before it mounts).
    const files = byName.get(name) || [];
    if (files.length === 1 && /rel="modulepreload"/.test(tag)) routeHints.push(tag.replace(href, `/assets/${files[0]}`));
    return '';
  });
  const out = head + entryTags.html + routeHints.join('') + body;

  for (const m of out.matchAll(/"\/assets\/([^"]+)"/g)) {
    if (!assetFiles.has(m[1])) throw new Error(`references /assets/${m[1]}, which this build did not produce`);
  }
  if (!/<script type="module"[^>]*src="\/assets\//.test(out)) throw new Error('module script missing after adoption');
  return out;
}

function main() {
  const indexPath = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexPath)) fail('dist/index.html not found - run `vite build` first');
  const index = fs.readFileSync(indexPath, 'utf8');
  const indexHead = index.slice(0, index.indexOf('</head>'));
  const tags = [...indexHead.matchAll(ASSET_TAG)].map((m) => m[0]);
  if (!tags.some((t) => t.startsWith('<script'))) fail('no module script in dist/index.html');
  const entryTags = { html: tags.join(''), names: new Set([...indexHead.matchAll(ASSET_TAG)].map((m) => nameOf(m[1])).filter(Boolean)) };

  const assetFiles = new Set(fs.readdirSync(path.join(DIST, 'assets')));
  const byName = new Map();
  for (const f of assetFiles) {
    const n = nameOf(`/assets/${f}`);
    if (!n) continue;
    byName.set(n, [...(byName.get(n) || []), f]);
  }

  const inlineScript = (index.match(/<script>[^]*?<\/script>/) || [])[0];
  if (!inlineScript) fail('index.html inline script not found');

  const routes = marketingRoutes();
  fs.rmSync(OUT, { recursive: true, force: true });
  let n = 0;
  for (const route of routes) {
    const rel = prerenderFile(route.path);
    const src = path.join(SNAP, rel);
    if (!fs.existsSync(src)) fail(`${route.path}: no snapshot at prerender-snapshots/${rel}`);
    let html;
    try {
      html = adoptPage(fs.readFileSync(src, 'utf8'), { entryTags, assetFiles, byName });
    } catch (e) {
      fail(`${route.path}: ${e.message}`);
    }
    if (!html.includes(inlineScript)) fail(`${route.path}: inline script differs from this build (CSP hash would break)`);
    const dest = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html);
    n++;
  }
  for (const f of ['prerender/manifest.json', 'marketing-sitemap.xml']) {
    const src = path.join(SNAP, f);
    if (!fs.existsSync(src)) fail(`prerender-snapshots/${f} missing`);
    fs.mkdirSync(path.dirname(path.join(DIST, f)), { recursive: true });
    fs.copyFileSync(src, path.join(DIST, f));
  }
  console.log(`[prerender-adopt] ${n} pre-rendered pages adopted from CI, asset tags matched to this build`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

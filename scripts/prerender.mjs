#!/usr/bin/env node
// Build step: pre-render the public marketing + legal pages to static HTML
// so search engines and AI crawlers that do not run JavaScript see the real
// page (title, meta, canonical, JSON-LD and the full copy) instead of an
// empty <div id="root">. Runs after `vite build` as part of `npm run build`.
//
// How: serve dist/ the way the SPA catch-all does, open every route from
// scripts/_lib/marketing-routes.mjs in headless Chromium as a fresh,
// logged-out visitor, wait for the page's <h1> and canonical tag, and save
// the live document as dist/prerender/<path>.html. vercel.json rewrites the
// public paths to those files (www host only); the SPA shell dist/index.html
// is untouched, so the native app and every app route behave as before.
//
// The saved page keeps the original module script, so React boots on it and
// replaces the static DOM with its identical render (see src/main.jsx and
// src/lib/lazyRoute.js for how that happens without a spinner or a flash).
// <html data-prerendered> plus a small style keep CSS animations paused until
// React takes over, so entrance animations play exactly once.
//
// Any route that fails to render fails the build: an empty page must never
// ship silently.
//
// Browser: set PRERENDER_PLAYWRIGHT (path to playwright-core's index.mjs) and
// PRERENDER_CHROMIUM (Chromium executable) to point at an install; otherwise
// `playwright-core` from node_modules is used with its default browser, with
// a last fallback to the paths used by the development sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startDistServer } from './_lib/serve-dist.mjs';

// Where playwright-core keeps its browser when it has to download one: "0"
// means inside node_modules, which build caches keep between deploys. Set
// before Playwright loads, which reads it once; an explicit value wins.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '0';
import { ROOT, SITE_ORIGIN, marketingRoutes, prerenderFile } from './_lib/marketing-routes.mjs';
import { buildSitemapXml } from './_lib/sitemap.mjs';

const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'prerender');
const CONCURRENCY = Number(process.env.PRERENDER_CONCURRENCY || 4);
const TIMEOUT = 45_000;

function fail(msg) {
  console.error(`\n[prerender] FAILED: ${msg}`);
  process.exit(1);
}

async function loadChromium() {
  const candidates = [
    process.env.PRERENDER_PLAYWRIGHT,
    'playwright-core',
    '/opt/node-tools/node_modules/playwright-core/index.mjs',
  ].filter(Boolean);
  let mod = null;
  for (const c of candidates) {
    try {
      mod = await import(c.startsWith('/') ? pathToFileURL(c).href : c);
      break;
    } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find/.test(e?.message || '')) throw e;
    }
  }
  if (!mod?.chromium) {
    fail('playwright-core is not available. Install it (npm i -D playwright-core && npx playwright-core install chromium) '
      + 'or set PRERENDER_PLAYWRIGHT=/path/to/playwright-core/index.mjs and PRERENDER_CHROMIUM=/path/to/chromium.');
  }
  const executablePath = process.env.PRERENDER_CHROMIUM
    || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const launch = () => mod.chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    return await launch();
  } catch (e) {
    // No browser yet (a fresh build machine): fetch Playwright's headless
    // Chromium once into node_modules (PLAYWRIGHT_BROWSERS_PATH=0 keeps it
    // inside the dependency cache) and try again.
    if (executablePath || !/Executable doesn't exist|install/i.test(e.message)) throw e;
    console.log('[prerender] no Chromium found - installing chromium-headless-shell via playwright-core');
    const r = spawnSync('npx', ['playwright-core', 'install', 'chromium-headless-shell'], {
      stdio: 'inherit', cwd: ROOT, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' },
    });
    if (r.status !== 0) fail('could not install Chromium. If system libraries are missing on the build machine, run '
      + '`npx playwright-core install-deps chromium-headless-shell` there, or set PRERENDER_CHROMIUM to a working Chromium.');
    return launch();
  }
}

// Console noise that is expected for a logged-out visitor with no API:
// the auth probe is a 401 in production too, and the sandbox may not reach
// Google Fonts. Everything else is a real error and fails the build.
function isExpectedConsoleError(msg) {
  const url = msg.location()?.url || '';
  const text = msg.text();
  if (/\/api\//.test(url) && /Failed to load resource/.test(text)) return true;
  if (/fonts\.(googleapis|gstatic)\.com/.test(url)) return true;
  return false;
}

// Runs in the page: returns the document as the static file we ship.
function snapshotInPage() {
  const html = document.documentElement.cloneNode(true);
  html.setAttribute('data-prerendered', '1');
  const head = html.querySelector('head');
  // Web fonts must not block first paint on the static page either. main.jsx
  // promoted index.html's preload to a stylesheet; put it back the way
  // index.html has it (main.jsx promotes it again on the live page). It is
  // the page's one font request: it carries id="site-fonts", so the site
  // chrome does not add a second.
  for (const link of head.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('https://fonts.googleapis.com')) continue;
    link.setAttribute('rel', 'preload');
    link.setAttribute('as', 'style');
  }
  const freeze = document.createElement('style');
  freeze.id = 'prerender-freeze';
  freeze.textContent = 'html[data-prerendered] *{animation-play-state:paused!important}';
  head.appendChild(freeze);
  const h1 = document.querySelector('h1');
  return {
    html: '<!doctype html>\n' + html.outerHTML + '\n',
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
    h1: h1 ? h1.textContent.trim() : '',
    jsonLdCount: document.querySelectorAll('script[type="application/ld+json"]').length,
  };
}

async function renderRoute(browser, base, route, inlineScript) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    serviceWorkers: 'block',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isExpectedConsoleError(msg)) errors.push(`console.error: ${msg.text()}`);
  });
  try {
    const url = base + route.path;
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT });
    if (!resp || !resp.ok()) throw new Error(`HTTP ${resp?.status()} loading ${url}`);
    await page.waitForSelector('h1', { state: 'visible', timeout: TIMEOUT });
    await page.waitForSelector('head link[rel="canonical"]', { state: 'attached', timeout: TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
    // Let script-driven text settle (the home page counts its stats up over
    // ~1.3s) so the snapshot carries final values, never a mid-animation one.
    await page.waitForFunction(() => {
      const t = document.body.innerText;
      const w = window;
      if (w.__pr_text === t) { w.__pr_same = (w.__pr_same || 0) + 1; } else { w.__pr_same = 0; w.__pr_text = t; }
      return w.__pr_same >= 5;
    }, null, { polling: 100, timeout: TIMEOUT });
    const finalPath = new URL(page.url()).pathname;
    if (finalPath !== route.path) throw new Error(`redirected to ${finalPath}`);

    const snap = await page.evaluate(snapshotInPage);
    if (errors.length) throw new Error(errors.join(' | '));
    if (!snap.h1) throw new Error('no <h1> text');
    if (!snap.title) throw new Error('no <title>');
    if (!snap.description) throw new Error('no meta description');
    if (snap.canonical !== SITE_ORIGIN + route.path) throw new Error(`canonical is "${snap.canonical}"`);
    if (!/<div id="root">\s*<[a-z]/i.test(snap.html)) throw new Error('#root is empty');
    if (!snap.html.includes(inlineScript)) throw new Error('inline script changed (CSP hash would break)');
    if (!/<script type="module" crossorigin(?:="")? src="\/assets\//.test(snap.html)) throw new Error('module script missing');

    const file = path.join(DIST, prerenderFile(route.path));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, snap.html);
    return { path: route.path, file: path.relative(DIST, file), title: snap.title, description: snap.description, h1: snap.h1, canonical: snap.canonical, jsonLd: snap.jsonLdCount, bytes: Buffer.byteLength(snap.html) };
  } finally {
    await context.close();
  }
}

async function main() {
  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) fail('dist/index.html not found - run `vite build` first');
  const indexHtml = fs.readFileSync(index, 'utf8');
  const inlineScript = (indexHtml.match(/<script>[^]*?<\/script>/) || [])[0];
  if (!inlineScript) fail('index.html inline script not found');

  const routes = marketingRoutes();
  if (routes.length < 40) fail(`only ${routes.length} routes - route list looks broken`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const server = await startDistServer({ dist: DIST, mode: 'spa' });
  const browser = await loadChromium();
  const t0 = Date.now();
  const results = [];
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < routes.length) {
      const route = routes[next++];
      try {
        const r = await renderRoute(browser, server.url, route, inlineScript);
        results.push(r);
        console.log(`[prerender] ${route.path.padEnd(28)} ${String(r.bytes).padStart(7)} B  "${r.title}"`);
      } catch (e) {
        failures.push(`${route.path}: ${e.message}`);
        console.error(`[prerender] ${route.path} FAILED: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, routes.length) }, worker));
  await browser.close();
  await server.close();

  if (failures.length) fail(`${failures.length} route(s) did not render:\n  ${failures.join('\n  ')}`);

  const titles = new Set(results.map((r) => r.title));
  if (titles.size !== results.length) fail('duplicate <title> across pre-rendered pages');

  results.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), pages: results }, null, 2));

  fs.writeFileSync(path.join(DIST, 'marketing-sitemap.xml'), buildSitemapXml());

  console.log(`[prerender] ${results.length} pages + marketing-sitemap.xml in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => fail(e.stack || e.message));

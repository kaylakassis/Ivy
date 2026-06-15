// Hard-paywall coverage test: pure grep-based, no DB / no server needed.
// Asserts the two invariants the migration relies on:
//
//   1. EVERY non-exempt owner endpoint that calls ensureWorkspace also
//      calls ensureActiveWorkspace (the gate has actually replaced it).
//   2. NO endpoint in the exempt set imports workspaceGate (we never
//      accidentally gated the client portal / billing / data export /
//      webhooks / crons, which would lock paying owners out of the
//      escape hatches).
//
// Run: node ./tests/paywall-coverage.test.mjs
//
// This test is intentionally cheap so it can land in pre-merge CI
// without bringing up Postgres.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

// These directories are the documented exempt set. The semantics are
// codified here so a future contributor who reads this file knows
// EXACTLY what's off-limits to the gate.
const EXEMPT_DIRS = [
  'api/_lib/',
  'api/auth/',
  'api/me/',
  'api/billing/',
  'api/onboarding/',
  'api/webhooks/',
  'api/cron/',
  'api/site/',
  'api/sign/',
  'api/quote-view/',
  'api/invoice-view/',
  'api/invoice-pay/',
  'api/review/',
  'api/early-access/',
  'api/support/',
];
const EXEMPT_FILES = [
  'api/account/export.js',
  'api/account/delete.js',
  'api/dashboard.js',
  'api/health.js',
  'api/public-stats.js',
  'api/geocode.js',
  'api/newsletter.js',
  'api/marketing-sitemap.xml.js',
  'api/bug-reports.js',
  'api/admin/impersonate.js',
];

function isExempt(file) {
  if (EXEMPT_FILES.includes(file)) return true;
  return EXEMPT_DIRS.some((d) => file.startsWith(d));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

const apiFiles = walk('api');

// Invariant 1: every non-exempt file that mentions ensureWorkspace
// must also reference ensureActiveWorkspace. If it does, we trust
// the migration. If not, it's a paywall hole.
const holes = [];
for (const f of apiFiles) {
  if (isExempt(f)) continue;
  const src = readFileSync(f, 'utf8');
  if (!/\bensureWorkspace\s*\(/.test(src)) continue;
  if (!/\bensureActiveWorkspace\s*\(/.test(src)) {
    holes.push(f);
  }
}
assert(holes.length === 0,
  `every non-exempt owner endpoint uses ensureActiveWorkspace${holes.length ? ` (holes: ${holes.join(', ')})` : ''}`);

// Invariant 2: NO exempt file CALLS ensureActiveWorkspace as a gating
// check. evictWorkspaceGateCache is allowed (billing/sync uses it).
// Comments are excluded — we match `await ensureActiveWorkspace(`.
const escapeHatchLeaks = [];
for (const f of apiFiles) {
  // Helper file itself defines the function; allow.
  if (f === 'api/_lib/workspaceGate.js') continue;
  if (!isExempt(f)) continue;
  const src = readFileSync(f, 'utf8');
  if (/await\s+ensureActiveWorkspace\s*\(/.test(src)) {
    escapeHatchLeaks.push(f);
  }
}
assert(escapeHatchLeaks.length === 0,
  `exempt set never calls the gate${escapeHatchLeaks.length ? ` (leaks: ${escapeHatchLeaks.join(', ')})` : ''}`);

// Invariant 3: dead old gate. No source file should reference
// requireActiveSubscription anymore (the helper file is deleted; any
// live caller would now be a runtime error). Comments anywhere are OK.
const oldGateCallers = [];
for (const f of apiFiles) {
  const src = readFileSync(f, 'utf8');
  if (/^\s*import[^;]*requireActiveSubscription/m.test(src)
   || /\brequireActiveSubscription\s*\(/.test(src)) {
    oldGateCallers.push(f);
  }
}
assert(oldGateCallers.length === 0,
  `old requireActiveSubscription has no live callers${oldGateCallers.length ? ` (residual: ${oldGateCallers.join(', ')})` : ''}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

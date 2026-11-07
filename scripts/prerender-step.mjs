#!/usr/bin/env node
// `npm run build` runs this after `vite build`. Where CI already
// pre-rendered the marketing pages (prerender-snapshots/ exists, which is
// the case on Vercel's build machines: see the deploy job in
// .github/workflows/ci.yml), adopt them; everywhere else render them in a
// headless browser. Either way a failure fails the build.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './_lib/marketing-routes.mjs';

const adopt = fs.existsSync(path.join(ROOT, 'prerender-snapshots', 'prerender', 'manifest.json'));
const script = path.join(ROOT, 'scripts', adopt ? 'prerender-adopt.mjs' : 'prerender.mjs');
const r = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: ROOT });
process.exit(r.status ?? 1);

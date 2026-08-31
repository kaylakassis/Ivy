// Preflight for the native iOS build.
//
// The iOS bundle is built on the MAC by `npm run build`, then copied into
// the .ipa by `npx cap sync ios`. That means the two VITE_* values below
// are baked in from the MAC's environment at that moment - Vercel's
// environment variables have nothing to do with it. Setting them only in
// Vercel produces an app that installs, launches, and then fails every
// single API call (relative `/api/...` resolves to https://localhost on
// the Capacitor origin) with an unsellable paywall.
//
// That failure is silent, ships in a signed build, and is only visible
// after a TestFlight round-trip - so we fail the build here instead.
//
// Escape hatch: IVY_SKIP_IOS_ENV_CHECK=1 (for building a throwaway
// simulator bundle you don't intend to sign or ship).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite reads .env / .env.local itself, so we have to look in the same
// places to know what the build will actually see.
function fromEnvFiles(key) {
  for (const f of ['.env.local', '.env']) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return '';
}

const read = (key) => (process.env[key] || fromEnvFiles(key) || '').trim();

const problems = [];

const base = read('VITE_API_BASE_URL');
if (!base) {
  problems.push(
    'VITE_API_BASE_URL is not set.\n' +
    '      The app would call https://localhost/api/... and every request\n' +
    '      would fail. Set it to your API host, e.g. https://joinivy.ai',
  );
} else if (!/^https:\/\/[^/\s]+$/.test(base.replace(/\/+$/, ''))) {
  problems.push(
    `VITE_API_BASE_URL is "${base}", which is not a bare https origin.\n` +
    '      Expected something like https://joinivy.ai (no path, no trailing slash).',
  );
}

if (!read('VITE_REVENUECAT_PUBLIC_KEY_IOS')) {
  problems.push(
    'VITE_REVENUECAT_PUBLIC_KEY_IOS is not set.\n' +
    '      The paywall would load with nothing to purchase, which Apple\n' +
    '      rejects under guideline 3.1.1. Copy the iOS public SDK key from\n' +
    '      RevenueCat (Project settings > API keys).',
  );
}

if (problems.length && process.env.IVY_SKIP_IOS_ENV_CHECK !== '1') {
  console.error('\n\x1b[31m✖ iOS build preflight failed\x1b[0m\n');
  for (const p of problems) console.error('   • ' + p + '\n');
  console.error(
    '   Fix: create a .env file in the repo root on this Mac:\n\n' +
    '     VITE_API_BASE_URL=https://joinivy.ai\n' +
    '     VITE_REVENUECAT_PUBLIC_KEY_IOS=appl_xxxxxxxxxxxx\n\n' +
    '   These are build-time values baked into the app bundle. They are\n' +
    '   NOT read from Vercel - Vercel only serves the web app.\n' +
    '   (Override for a throwaway build: IVY_SKIP_IOS_ENV_CHECK=1)\n',
  );
  process.exit(1);
}

if (problems.length) {
  console.warn('\n\x1b[33m! iOS env check skipped via IVY_SKIP_IOS_ENV_CHECK - do not ship this build.\x1b[0m\n');
} else {
  console.log(`✓ iOS build preflight passed (API base: ${base})`);
}

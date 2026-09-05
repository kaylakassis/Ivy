// Preflight for the native iOS build.
//
// The iOS bundle is built on the MAC by `npm run build`, then copied into
// the .ipa by `npx cap sync ios`. That means the two VITE_* values below
// are baked in from the MAC's environment at that moment - Vercel's
// environment variables have nothing to do with it. Setting them only in
// Vercel produces a signed build whose failures only surface after a
// TestFlight round-trip, which is an expensive way to find out.
//
// The two values are NOT equally important, so they fail differently:
//
//   VITE_API_BASE_URL           FATAL. Without it every API call resolves
//                               to https://localhost/api/... and the app
//                               is completely non-functional. Nothing
//                               about the build is salvageable.
//
//   VITE_REVENUECAT_PUBLIC_KEY_IOS
//                               WARNS. The app works fine and is worth
//                               installing through TestFlight; only the
//                               paywall comes up with nothing to buy. That
//                               is a legitimate state while you are still
//                               setting RevenueCat up, but such a build
//                               must not be submitted for sale (App Store
//                               guideline 3.1.1).
//
// Escape hatch for the fatal one: IVY_SKIP_IOS_ENV_CHECK=1, for building
// a throwaway simulator bundle you have no intention of signing.
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

const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const OFF = '\x1b[0m';

// ── Fatal: the API base ────────────────────────────────────────────────
const base = read('VITE_API_BASE_URL');
let fatal = null;
if (!base) {
  fatal = 'VITE_API_BASE_URL is not set.\n'
    + '     Without it the app calls https://localhost/api/... and every\n'
    + '     request fails. The build would install and then do nothing.';
} else if (!/^https:\/\/[^/\s]+$/.test(base.replace(/\/+$/, ''))) {
  fatal = `VITE_API_BASE_URL is "${base}", which is not a bare https origin.\n`
    + '     Expected something like https://joinivy.ai (no path, no trailing slash).';
}

if (fatal && process.env.IVY_SKIP_IOS_ENV_CHECK !== '1') {
  console.error(`\n${RED}✖ iOS build stopped${OFF}\n`);
  console.error('   • ' + fatal + '\n');
  console.error(
    '   Fix: open the .env file in this folder and set:\n\n'
    + '     VITE_API_BASE_URL=https://joinivy.ai\n\n'
    + '   This is a build-time value baked into the app. It is NOT read\n'
    + '   from Vercel, which only builds the website.\n',
  );
  process.exit(1);
}
if (fatal) {
  console.warn(`\n${YEL}! IVY_SKIP_IOS_ENV_CHECK is set and ${'VITE_API_BASE_URL'} is bad. This build cannot work. Do not ship it.${OFF}\n`);
}

// ── Non-fatal: the store key ───────────────────────────────────────────
if (!read('VITE_REVENUECAT_PUBLIC_KEY_IOS')) {
  console.warn(
    `\n${YEL}! Building WITHOUT a RevenueCat key.${OFF}\n\n`
    + '   VITE_REVENUECAT_PUBLIC_KEY_IOS is not set, so the subscription\n'
    + '   screen will load with nothing to purchase.\n\n'
    + '   This is fine for a build you install through TestFlight to try\n'
    + '   the app out. It CANNOT be submitted for review: Apple rejects a\n'
    + '   non-working paywall under guideline 3.1.1.\n\n'
    + '   When you are ready, put the key from RevenueCat (Project settings\n'
    + '   > API keys, the public one starting with appl_) into .env and\n'
    + '   run this again.\n',
  );
} else if (!fatal) {
  console.log(`✓ iOS build preflight passed (API base: ${base})`);
}

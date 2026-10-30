// Pure logic behind the iPhone polish: which links open in the in-app
// Safari sheet, and who sees the "get the free app" prompt.
// Run: node ./tests/native-polish.test.mjs
import { shouldOpenInSheet } from '../src/lib/native.js';
import { isAppleMobile, isClientPath, APP_STORE_URL } from '../src/lib/getApp.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const APP = 'capacitor://localhost';

console.log('\n[1] outside links open in the in-app sheet');
assert(shouldOpenInSheet('https://stripe.com/docs', APP), 'https outside page → sheet');
assert(shouldOpenInSheet('https://www.joinivy.ai/terms', APP), 'website page → sheet (the app runs from its own origin)');
assert(!shouldOpenInSheet('/finance', APP), 'app route → stays in the app');
assert(!shouldOpenInSheet(`${APP}/me`, APP), 'same-origin absolute → stays');
assert(!shouldOpenInSheet('mailto:hello@joinivy.ai', APP), 'mailto → Mail app');
assert(!shouldOpenInSheet('tel:+15551234567', APP), 'tel → Phone app');
assert(!shouldOpenInSheet('sms:+15551234567', APP), 'sms → Messages app');
assert(!shouldOpenInSheet('itms-apps://apps.apple.com/app/id1', APP), 'itms-apps → App Store app');
assert(!shouldOpenInSheet('https://apps.apple.com/account/subscriptions', APP), 'App Store page → App Store app');
assert(!shouldOpenInSheet(APP_STORE_URL, APP), 'Ivy App Store listing → App Store app');
assert(!shouldOpenInSheet('', APP) && !shouldOpenInSheet(null, APP), 'empty → nothing');

console.log('\n[2] who sees the get-the-app prompt');
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const ipados = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const mac = ipados;
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
assert(isAppleMobile(iphone, 5), 'iPhone Safari');
assert(isAppleMobile(chromeIos, 5), 'iPhone Chrome');
assert(isAppleMobile(ipados, 5), 'iPad (desktop-style user agent + touch)');
assert(!isAppleMobile(mac, 0), 'Mac desktop: no');
assert(!isAppleMobile(android, 5), 'Android: no (no Android app yet)');
for (const p of ['/invoice/abc', '/quote/abc', '/sign/abc', '/book/glow', '/p/123', '/me', '/me/bookings']) assert(isClientPath(p), `client page ${p}`);
for (const p of ['/', '/dashboard', '/finance', '/pricing', '/signin', '/memberships']) assert(!isClientPath(p), `not shown on ${p}`);
assert(APP_STORE_URL === 'https://apps.apple.com/us/app/ivy-for-solo-businesses/id6808542331', 'links to the Ivy listing');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

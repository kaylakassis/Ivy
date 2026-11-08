// Home-screen quick actions: the ivy:// URL iOS hands the app → the in-app
// route with the right drawer open (src/lib/quickActions.js), and the
// Info.plist items / Swift forwarding agree with it.
// Run: node ./tests/quick-actions.test.mjs
import fs from 'node:fs';
import { routeForAppUrl, routeForQuickAction, routeForShortcutType, QUICK_ACTIONS, SHORTCUT_TYPE_PREFIX } from '../src/lib/quickActions.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

console.log('\n[1] quick action URLs open the right screen with its drawer');
assert(routeForAppUrl('ivy://action/new-booking') === '/calendar?newBooking=new', 'New booking → calendar with the booking drawer');
assert(routeForAppUrl('ivy://action/new-client') === '/clients?add=1', 'New client → clients with the add form');
assert(routeForAppUrl('ivy://action/new-invoice') === '/finance?newInvoice=new', 'New invoice → finance with the invoice drawer');
assert(routeForAppUrl('ivy://action/ask-ivy') === '/ivy', 'Ask Ivy → Ivy');
assert(routeForAppUrl('IVY://ACTION/NEW-CLIENT') === '/clients?add=1', 'case-insensitive');
assert(routeForAppUrl('ivy://action/new-booking/') === '/calendar?newBooking=new', 'trailing slash tolerated');

console.log('\n[2] plain ivy:// links');
assert(routeForAppUrl('ivy://finance') === '/finance', 'ivy://finance (payment return page) → Money');
assert(routeForAppUrl('ivy://dashboard') === '/dashboard', 'ivy://dashboard → Home');
assert(routeForAppUrl('ivy://admin') === null, 'unlisted screens are ignored');
assert(routeForAppUrl('ivy://me/invoices') === null, 'nested paths are ignored');

console.log('\n[3] junk never navigates');
for (const bad of ['', null, undefined, 42, 'https://evil.example/action/new-booking', 'javascript:alert(1)', 'ivy://action', 'ivy://action/unknown', 'ivy://action/new-booking/extra', 'ivy:', 'not a url']) {
  assert(routeForAppUrl(bad) === null, `ignored: ${JSON.stringify(bad)}`);
}
assert(routeForQuickAction('nope') === null, 'unknown action name → null');
assert(routeForShortcutType(`${SHORTCUT_TYPE_PREFIX}new-invoice`) === '/finance?newInvoice=new', 'shortcut type → route');
assert(routeForShortcutType('com.other.new-invoice') === null, 'foreign shortcut type → null');

console.log('\n[4] Info.plist, Swift and the dashboard tiles agree');
const plist = fs.readFileSync('ios/App/App/Info.plist', 'utf8');
const swift = fs.readFileSync('ios/App/App/SceneDelegate.swift', 'utf8');
const dash = fs.readFileSync('src/features/dashboard/Dashboard.jsx', 'utf8');
for (const [name, route] of Object.entries(QUICK_ACTIONS)) {
  assert(plist.includes(`<string>${SHORTCUT_TYPE_PREFIX}${name}</string>`), `Info.plist has shortcut type for ${name}`);
  assert(plist.includes(`<string>ivy://action/${name}</string>`), `Info.plist carries ivy://action/${name}`);
  if (route !== '/ivy') assert(dash.includes(`to: '${route}'`), `dashboard tile uses the same route ${route}`);
}
assert((plist.match(/<key>UIApplicationShortcutItemTitle<\/key>\s*<string>([^<]+)<\/string>/g) || []).length === 4, 'four titled items');
assert(/<string>New booking<\/string>[\s\S]*<string>New client<\/string>[\s\S]*<string>New invoice<\/string>[\s\S]*<string>Ask Ivy<\/string>/.test(plist), 'titles match the dashboard tiles, in order');
assert(swift.includes('performActionFor shortcutItem'), 'SceneDelegate handles a tap while running');
assert(swift.includes('connectionOptions.shortcutItem'), 'SceneDelegate handles a cold start');
assert(swift.includes('.capacitorViewDidAppear'), 'cold start waits for the web view (plugins loaded)');
assert(swift.includes('name: .capacitorOpenURL'), 'forwards as a Capacitor URL open (App plugin → appUrlOpen)');
assert(swift.includes(`"${SHORTCUT_TYPE_PREFIX}"`), 'Swift fallback derives the url from the same type prefix');
assert(fs.readFileSync('ios/App/Podfile', 'utf8').includes("pod 'CapacitorApp'"), 'Podfile includes the App plugin');
assert(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies['@capacitor/app'], '@capacitor/app is a direct dependency');
assert(fs.readFileSync('src/App.jsx', 'utf8').includes('<NativeUrlOpens/>'), 'App mounts the appUrlOpen listener');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

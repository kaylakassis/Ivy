// The onboarding About step's required answers (enforced in the UI, never
// on the server) and the save payload it sends.
//   • Goals, what's draining them, stage, location and heard-from are
//     required; ideal client is not.
//   • "Other" picked without typing blocks, even next to a preset.
//   • Location: a US state, or Outside the US + a country (typed when
//     "Somewhere else").
//   • The payload never sends the Other sentinel, only sends typed Other
//     text when Other is picked, and carries the referrer only with
//     "Friend / referral".
//   • Setup steps after About are skippable; the beginning is not.
//
// Run: node ./tests/onboarding-about-required.test.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the JSX module so its pure helpers can run under plain Node.
const out = await build({
  entryPoints: [path.join(ROOT, 'src/features/onboarding/aboutFields.jsx')],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'about-')), 'aboutFields.mjs');
fs.writeFileSync(tmp, out.outputFiles[0].text);
const { OTHER, OUTSIDE_US, validateAbout, aboutPayload, aboutFromProfile } = await import(pathToFileURL(tmp).href);

const complete = {
  goalIds: ['grow_revenue'], goalOther: '',
  challengeIds: ['leads'], challengeOther: '',
  stageIds: ['starting'], idealClient: '',
  heardFromIds: ['google'], heardFromOther: '', referralName: '',
  locationState: 'GA', locationCountry: '', locationCountryOther: '',
};

console.log('\n[1] required answers');
assert(Object.keys(validateAbout(complete)).length === 0, 'a complete answer set passes (ideal client optional)');
const empty = validateAbout({});
assert(['goal', 'challenge', 'stage', 'location', 'heardFrom'].every((k) => empty[k]), 'every required question flagged when empty');
assert(!('idealClient' in empty), 'ideal client never required');
assert(validateAbout({ ...complete, stageIds: [] }).stage, 'stage is required');
assert(validateAbout({ ...complete, heardFromIds: [] }).heardFrom === 'Tell us how you heard about Ivy.', 'heard-from is required');

console.log('\n[2] Other must be typed');
assert(validateAbout({ ...complete, heardFromIds: [OTHER] }).heardFrom === 'Tell us where you heard about Ivy.', 'heard-from Other with nothing typed blocks');
assert(validateAbout({ ...complete, heardFromIds: ['google', OTHER], heardFromOther: '   ' }).heardFrom, 'Other blocks even next to a preset (whitespace is empty)');
assert(!validateAbout({ ...complete, heardFromIds: [OTHER], heardFromOther: 'A podcast' }).heardFrom, 'typed Other passes');
assert(validateAbout({ ...complete, goalIds: ['save_time', OTHER] }).goal, 'goal Other must be typed');
assert(validateAbout({ ...complete, challengeIds: [OTHER] }).challenge, 'challenge Other must be typed');

console.log('\n[3] location');
assert(validateAbout({ ...complete, locationState: '' }).location, 'location required');
assert(validateAbout({ ...complete, locationState: OUTSIDE_US }).location === 'Pick your country.', 'outside the US asks for the country');
assert(validateAbout({ ...complete, locationState: OUTSIDE_US, locationCountry: OTHER }).location === 'Type your country.', 'Somewhere else must be typed');
assert(!validateAbout({ ...complete, locationState: OUTSIDE_US, locationCountry: 'Canada' }).location, 'a listed country passes');

console.log('\n[4] payload');
let p = aboutPayload({ ...complete, heardFromIds: ['referral', OTHER], heardFromOther: ' Podcast ', referralName: ' Dana ' });
assert(JSON.stringify(p.heardFromIds) === JSON.stringify(['referral']), 'Other sentinel never sent');
assert(p.heardFromOther === 'Podcast' && p.referralName === 'Dana', 'typed Other and referrer sent, trimmed');
assert(p.locationState === 'GA' && p.locationCountry === null, 'US state sent');
p = aboutPayload({ ...complete, goalOther: 'stale text', heardFromIds: ['google'], referralName: 'Dana' });
assert(p.goalOther === '' && p.referralName === '', 'stale Other text and referrer not sent when not picked');
p = aboutPayload({ ...complete, locationState: OUTSIDE_US, locationCountry: OTHER, locationCountryOther: ' Ghana ' });
assert(p.locationState === null && p.locationCountry === 'Ghana', 'typed country sent for outside the US');
const back = aboutFromProfile({ goalIds: ['save_time'], goalOther: 'Hire help', heardFromIds: [], heardFromOther: 'Podcast', locationCountry: 'Ghana' });
assert(back.goalIds.includes(OTHER) && back.heardFromIds.includes(OTHER), 'stored Other text brings back the Other chip');
assert(back.locationState === OUTSIDE_US && back.locationCountry === OTHER && back.locationCountryOther === 'Ghana', 'an unlisted country reloads as typed');

console.log('\n[5] wizard wiring');
const page = fs.readFileSync(path.join(ROOT, 'src/features/onboarding/OnboardingPage.jsx'), 'utf8');
for (const id of ['services', 'availability', 'switch', 'payments', 'branding', 'first_client', 'website']) {
  assert(new RegExp(`id: '${id}',[^}]*optional: true`).test(page), `${id} is skippable`);
}
assert(/id: 'first_product', label: 'First product', optional: true }\);\n\s*base\.push\(SWITCH\)/.test(page), 'first product (product-only flow) is skippable');
for (const id of ['welcome', 'business', 'about']) {
  assert(new RegExp(`id: '${id}',[^}]*optional: false`).test(page), `${id} is required`);
}
assert(/REQUIRED_STEPS = new Set\(\['welcome', 'business', 'about'\]\)/.test(page), 'Save & exit hidden on the required steps');
assert(/ivyMode && !ivyAboutDone/.test(page), 'the Ivy-guided path asks the About questions first');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// The cancellation policy writer behind "Help me write it" on the
// Cancellation policy card and Ivy's cancellation_policy draft action
// (src/features/finance/policyGenerator.js). Pure functions, no database.
// Also renders the panel (CancellationPolicyHelper.jsx) to static markup
// and lints its source copy (no dashes as punctuation, no "business OS",
// no fee claims, no AI vendor names).
//
//   node tests/policy-generator.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import {
  BUSINESS_TYPES, NOTICE_OPTIONS, FEE_ACTIONS, APP_FEE_ACTIONS, RESCHEDULE_OPTIONS, TONES, VOICES,
  DEFAULT_POLICY_OPTIONS, generatePolicy, normalizePolicyOptions, cleanAmount, noticeLabel,
  policyOptionsFromIvy, businessTypeFor,
} from '../src/features/finance/policyGenerator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

// Problems any generated text must never have.
function textProblems(t) {
  const out = [];
  if (/undefined|null|NaN|\[object|Infinity/.test(t)) out.push('placeholder leaked');
  if (/[–—]/.test(t)) out.push('en or em dash');
  if (/\S - \S/.test(t)) out.push('hyphen used as a dash');
  if (/ {2,}/.test(t)) out.push('double space');
  if (/ [.,]|\.\.|,\.|\.,/.test(t)) out.push('stray punctuation');
  if (/\ban (session|lesson|visit)\b|\ba appointment\b/.test(t)) out.push('a/an');
  return out;
}

console.log('policy generator');

await test('default policy reads well and fits in Ivy (5000 chars)', () => {
  const t = generatePolicy(DEFAULT_POLICY_OPTIONS);
  assert.deepEqual(textProblems(t), []);
  assert.ok(t.startsWith('Cancellation policy\n'));
  assert.ok(t.includes("24 hours' notice"));
  assert.ok(t.includes('deposit'));
  assert.ok(t.length < 5000);
});

// Every combination of the choices (amounts rotate through valid, empty,
// junk and out-of-range values; the settings Ivy fills in rotate too).
const AMOUNTS = ['', '40', '12.5', 'abc', '150', '-5', '$1,200'];
await test('every option combination produces sensible text', () => {
  let n = 0;
  for (const businessType of BUSINESS_TYPES.map((x) => x.value))
  for (const voice of VOICES.map((x) => x.value))
  for (const noticeHours of NOTICE_OPTIONS.map((x) => x.value))
  for (const takesDeposit of [true, false])
  for (const lateAction of FEE_ACTIONS.map((x) => x.value))
  for (const noShowAction of FEE_ACTIONS.map((x) => x.value))
  for (const reschedule of RESCHEDULE_OPTIONS.map((x) => x.value))
  for (const tone of TONES.map((x) => x.value))
  for (const flags of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    n++;
    const o = {
      businessType, voice, noticeHours, takesDeposit, lateAction, noShowAction, reschedule, tone,
      runningLate: !!(flags & 1), packages: !!(flags & 2), emergencies: !!(flags & 4), graceFirst: !!(flags & 8),
      lateAmount: AMOUNTS[n % AMOUNTS.length], noShowAmount: AMOUNTS[(n + 3) % AMOUNTS.length],
      businessName: n % 5 === 0 ? 'Willow Studio' : '',
      depositRefundable: n % 3 !== 0,
      packageUse: n % 7 === 0 ? 'completion' : 'booking',
      cardFees: n % 4 !== 0,
    };
    const t = generatePolicy(o);
    const where = JSON.stringify(o);
    const probs = textProblems(t);
    assert.deepEqual(probs, [], `${probs.join(', ')} in ${where}\n${t}`);
    assert.ok(t.length < 5000, `too long for Ivy's policy box: ${where}`);
    const notice = noticeHours === 168 ? "7 days' notice" : `${noticeHours} hours' notice`;
    assert.ok(t.includes(notice), `notice missing: ${where}`);
    if (!takesDeposit) assert.ok(!/deposit/i.test(t), `mentions a deposit without one: ${where}`);
    if (voice === 'i') assert.ok(!/\b(we|We|our|Our|us)\b/.test(t), `"we" in an I policy: ${where}`);
    if (voice === 'we') assert.ok(!/\b(I|me|my|My)\b|I'll/.test(t), `"I" in a we policy: ${where}`);
    if (businessType === 'cleaning') assert.ok(!t.includes('Running late'), 'cleaning has no running-late section');
    // Every bullet starts with a capital letter and ends with a full stop.
    for (const line of t.split('\n').filter((l) => l.startsWith('• '))) {
      assert.match(line, /^• [A-Z$]/, `bullet case: ${line}`);
      assert.match(line, /[.?)]$/, `bullet end: ${line}`);
    }
    if (o.graceFirst && lateAction === 'none') assert.ok(!t.includes('first late cancellation is on'), 'grace with no fee');
    // Ivy's package rule: sessions used when booked never cost a fee AND a
    // session; the business cancelling always gives the session back.
    if (o.packages && o.packageUse === 'booking') assert.ok(t.includes('instead of a fee') && t.includes('never charged a fee and a session'), `package rule: ${where}`);
    if (o.packages) assert.ok(t.includes('If you booked with a package session, the session goes back into your package.'), 'business cancel returns the session');
    if (takesDeposit && !o.depositRefundable) assert.ok(t.includes('Deposits are not refundable') && !t.includes('Your deposit is refunded, or carried over'), `non-refundable deposit: ${where}`);
    if ((lateAction === 'flat' || noShowAction === 'flat') && !o.cardFees) assert.ok(!t.includes('card on file'), 'no card promise without card payments');
  }
  assert.ok(n > 100000, `ran ${n} combinations`);
});

await test('fees: amounts, percents, deposit counts toward the fee', () => {
  const base = { takesDeposit: true, lateAction: 'flat', lateAmount: '40', noShowAction: 'percent', noShowAmount: '100' };
  const t = generatePolicy(base);
  assert.ok(t.includes('For a late cancellation, I charge a fee of $40. Your deposit counts toward this fee.'));
  assert.ok(t.includes('For a no-show, I charge the full price of the appointment.'));
  assert.ok(t.includes('charged to the card on file'));
  assert.ok(generatePolicy({ ...base, lateAmount: '12.5' }).includes('$12.50'));
  assert.ok(generatePolicy({ ...base, lateAmount: '1200' }).includes('$1,200'));
  assert.ok(generatePolicy({ ...base, lateAmount: '' }).includes('I charge the fee shown when you book. Your deposit'), 'no single amount points at the booking page');
  assert.ok(generatePolicy({ ...base, noShowAmount: '50' }).includes('50% of the price of the appointment'));
  assert.ok(generatePolicy({ ...base, noShowAmount: '250' }).includes('the full price'), 'percent capped at 100');
  assert.ok(generatePolicy({ ...base, tone: 'gentle' }).includes('I may charge a fee of $40'));
  assert.ok(!generatePolicy({ ...base, takesDeposit: false }).includes('deposit'));
  assert.ok(generatePolicy({ ...base, cardFees: false }).includes('If a fee applies, you will receive an invoice for it.'));
  const depOnly = generatePolicy({});
  assert.ok(!depOnly.includes('card on file'), 'no fee section when only the deposit is kept');
  assert.ok(depOnly.includes('refund your deposit or work something out'));
});

await test("Ivy's real rules: refundable deposits, packages, business cancels", () => {
  const nonRef = generatePolicy({ depositRefundable: false });
  assert.ok(nonRef.includes('Deposits are not refundable, but if you reschedule in time, your deposit moves to your new time.'));
  // Used when booked + a late fee: late cancel and no-show use the session.
  const pkgFee = generatePolicy({ packages: true, lateAction: 'flat', lateAmount: '25', noShowAction: 'flat', noShowAmount: '40' });
  assert.ok(pkgFee.includes('a late cancellation or a no-show uses that session instead of a fee. You are never charged a fee and a session for the same booking.'));
  assert.ok(pkgFee.includes("With 24 hours' notice or more, the session goes back into your package."));
  // Used when booked, no late fee: Ivy gives the session back on any cancel.
  const pkgNoFee = generatePolicy({ packages: true, lateAction: 'deposit', noShowAction: 'deposit' });
  assert.ok(pkgNoFee.includes('a no-show uses that session instead of a fee') && !pkgNoFee.includes('late cancellation or a no-show uses'));
  assert.ok(pkgNoFee.includes('If you cancel, the session goes back into your package.'));
  // Used when completed: cancels give it back, the normal fees apply.
  const done = generatePolicy({ packages: true, packageUse: 'completion', noShowAction: 'flat', noShowAmount: '30' });
  assert.ok(done.includes('the session counts as used once your appointment takes place'));
  assert.ok(done.includes('A no-show uses the session, and the no-show fee above also applies.'));
  assert.ok(!done.includes('instead of a fee'));
  for (const t of [pkgFee, pkgNoFee, done]) {
    assert.ok(t.includes('you will never be charged a fee.') && t.includes('If you booked with a package session, the session goes back into your package.'), 'business cancel: no fee, session back');
  }
});

await test('notice windows match any service window', () => {
  assert.equal(noticeLabel(36), '36 hours');
  assert.equal(noticeLabel(168), '7 days');
  assert.equal(noticeLabel(96), '4 days');
  assert.ok(generatePolicy({ noticeHours: 36 }).includes("36 hours' notice"));
  assert.equal(normalizePolicyOptions({ noticeHours: 1 }).noticeHours, 24);
  assert.equal(normalizePolicyOptions({ noticeHours: 10000 }).noticeHours, 24);
  assert.equal(normalizePolicyOptions({ noticeHours: 6.5 }).noticeHours, 24);
});

await test('options are normalized safely', () => {
  const o = normalizePolicyOptions({ businessType: 'nope', voice: 'they', noticeHours: 5000, tone: 'loud', lateAction: 'deposit', takesDeposit: false, businessName: '  A\u0007B  ' + 'x'.repeat(200), packageUse: 'later' });
  assert.equal(o.businessType, 'other');
  assert.equal(o.voice, 'i');
  assert.equal(o.noticeHours, 24);
  assert.equal(o.tone, 'standard');
  assert.equal(o.lateAction, 'none');
  assert.equal(o.packageUse, 'booking');
  assert.ok(o.businessName.length <= 80 && !/\u0007/.test(o.businessName));
  assert.equal(cleanAmount('abc'), null);
  assert.equal(cleanAmount('0'), null);
  assert.equal(cleanAmount('$1,250.555'), 1250.56);
  assert.deepEqual(textProblems(generatePolicy(null)), []);
  assert.deepEqual(textProblems(generatePolicy(undefined)), []);
});

await test('voice, tone and business type change the wording', () => {
  const we = generatePolicy({ voice: 'we', businessName: 'Glow Co' });
  assert.ok(we.startsWith('Glow Co: cancellation policy'));
  assert.ok(we.includes('message us directly') && we.includes('If we need to cancel'));
  assert.ok(generatePolicy({ tone: 'firm' }).includes('By booking, you confirm you have read and agree to this policy.'));
  assert.ok(generatePolicy({ tone: 'gentle' }).includes('Thank you for respecting my time.'));
  assert.ok(generatePolicy({ businessType: 'tutoring' }).includes('Missed lessons (no-shows)'));
  assert.ok(generatePolicy({ businessType: 'tutoring' }).includes('parent or guardian'));
  assert.ok(generatePolicy({ businessType: 'cleaning' }).includes('cannot get into your home'));
  assert.ok(generatePolicy({ businessType: 'massage' }).includes('contagious'));
  assert.ok(!generatePolicy({ businessType: 'coaching' }).includes('contagious'));
  assert.ok(generatePolicy({ noticeHours: 168 }).includes("7 days' notice"));
  assert.ok(generatePolicy({ reschedule: 'once' }).includes('once for free'));
});

console.log('starting point from Ivy settings');

await test('the app offers only fixed dollar fees', () => {
  assert.deepEqual(APP_FEE_ACTIONS.map((a) => a.value), ['deposit', 'flat', 'none']);
});

await test('pre-fill matches the services, switches and packages', () => {
  const { options, notes } = policyOptionsFromIvy({
    businessName: 'Willow Massage',
    category: 'Wellness',
    services: [
      { name: '60-min massage', depositType: 'fixed', depositAmount: 20, lateCancelFee: 25, windowHours: 48, noShowFee: 60 },
      { name: '90-min massage', depositType: 'fixed', depositAmount: 30, lateCancelFee: 25, windowHours: 48, noShowFee: 80 },
      { name: 'Free consult', depositType: 'none', depositAmount: 0, lateCancelFee: 0, windowHours: 24, noShowFee: 0 },
    ],
    settings: { refundDepositOutsideWindow: false },
    packages: { any: true, useOn: 'completion' },
    cardPayments: false,
  });
  assert.equal(options.businessName, 'Willow Massage');
  assert.equal(options.businessType, 'massage');
  assert.equal(options.noticeHours, 48);
  assert.equal(options.takesDeposit, true);
  assert.equal(options.depositRefundable, false);
  assert.equal(options.lateAction, 'flat');
  assert.equal(options.lateAmount, '25');
  assert.equal(options.noShowAction, 'flat');
  assert.equal(options.noShowAmount, '', 'different no-show fees: no single amount');
  assert.equal(options.packages, true);
  assert.equal(options.packageUse, 'completion');
  assert.equal(options.cardFees, false);
  assert.ok(notes.mixedNoShowFees && !notes.mixedLateFees && notes.fromServices);
  const t = generatePolicy(options);
  assert.ok(t.startsWith('Willow Massage: cancellation policy'));
  assert.ok(t.includes("48 hours' notice") && t.includes('a fee of $25') && t.includes('the fee shown when you book'));
  assert.ok(t.includes('Deposits are not refundable') && t.includes('you will receive an invoice'));
});

await test('pre-fill with nothing set up yet stays honest', () => {
  const { options, notes } = policyOptionsFromIvy({});
  assert.equal(options.takesDeposit, false);
  assert.equal(options.lateAction, 'none');
  assert.equal(options.noShowAction, 'none');
  assert.equal(options.noticeHours, 24);
  assert.equal(options.packages, false);
  assert.equal(options.businessType, 'other');
  assert.equal(notes.fromServices, false);
  assert.ok(!/deposit/i.test(generatePolicy(options)));
  const dep = policyOptionsFromIvy({ services: [{ name: 'Cut', depositType: 'percent', depositAmount: 25, lateCancelFee: 0, windowHours: 24, noShowFee: 0 }] }).options;
  assert.equal(dep.lateAction, 'deposit', 'a deposit and no fee: the deposit is kept');
  assert.equal(dep.businessType, 'hair');
});

await test('business type from the onboarding category and service names', () => {
  assert.equal(businessTypeFor({ category: 'Beauty', serviceNames: ['Signature facial'] }), 'esthetics');
  assert.equal(businessTypeFor({ category: 'Beauty', serviceNames: ['Cut and style'] }), 'hair');
  assert.equal(businessTypeFor({ category: 'Home' }), 'cleaning');
  assert.equal(businessTypeFor({ category: 'Pet' }), 'other');
  assert.equal(businessTypeFor({ category: null, serviceNames: ['Private lesson'] }), 'tutoring');
});

console.log('panel');

await test('the panel renders the options, the preview and the disclaimer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-helper-'));
  const out = path.join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'tests/fixtures/policy-helper-entry.jsx')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    jsx: 'automatic',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const E = await import(pathToFileURL(out).href);
  const { options } = policyOptionsFromIvy({
    businessName: 'Willow <Studio>', category: 'Wellness',
    services: [{ name: 'Massage', depositType: 'fixed', depositAmount: 20, lateCancelFee: 25, windowHours: 36, noShowFee: 25 }],
  });
  const html = E.renderToStaticMarkup(E.React.createElement(E.HelperBody, { initial: options, notes: {}, onUse: () => {}, onClose: () => {} }));
  assert.ok(html.includes('Write it as') && html.includes('Notice to cancel or reschedule') && html.includes('Tone'));
  assert.ok(html.includes('36 hours'), 'the service window is offered as a choice');
  assert.ok(html.includes('Keep the deposit') && html.includes('A set fee ($)') && html.includes('No charge'));
  assert.ok(!html.includes('% of the price'), 'no percent option in the app');
  assert.ok(html.includes('This is a template, not legal advice. Check local rules.'));
  assert.ok(html.includes('Use this policy'));
  assert.ok(html.includes('Willow &lt;Studio&gt;: cancellation policy'), 'preview is escaped text');
  assert.ok(html.includes('a fee of $25'));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('copy');

await test('source copy follows the house rules', () => {
  for (const f of ['src/features/finance/policyGenerator.js', 'src/features/finance/CancellationPolicyHelper.jsx', 'src/features/finance/CancellationPolicyCard.jsx']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/[–—]/.test(src), `${f}: en or em dash`);
    assert.ok(!/business OS/i.test(src), `${f}: "business OS"`);
    assert.ok(!/no transaction fees|zero percent|0% fees|take a cut|takes a cut/i.test(src), `${f}: fee claim`);
    assert.ok(!/openai|anthropic|claude|chatgpt|\bgpt\b|gemini|llama|mistral/i.test(src), `${f}: AI vendor name`);
  }
  const gen = fs.readFileSync(path.join(ROOT, 'src/features/finance/policyGenerator.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|import /.test(gen), 'the generator stays a pure module');
});

if (process.exitCode) {
  console.error('\npolicy-generator.test: FAILED');
  process.exit(1);
}
console.log(`\npolicy-generator.test: ${passed} tests passed.`);
process.exit(0);

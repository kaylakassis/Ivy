// Free tools at /tools: the cancellation policy generator's text, the
// deposit calculator's math and the intake templates. Pure functions, no
// database. Also lints the tools' source copy (no dashes as punctuation,
// no "business OS", no fee claims, no AI vendor names).
//
//   node tests/tools-generators.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUSINESS_TYPES, NOTICE_OPTIONS, FEE_ACTIONS, RESCHEDULE_OPTIONS, TONES, VOICES,
  DEFAULT_POLICY_OPTIONS, generatePolicy, normalizePolicyOptions, cleanAmount,
} from '../src/features/marketing/tools/policyGenerator.js';
import { computeDeposit, DEFAULT_DEPOSIT_INPUTS, fmtMoney, fmtNum } from '../src/features/marketing/tools/depositMath.js';
import { INTAKE_TEMPLATES, intakeTemplateText, intakeFileName } from '../src/features/marketing/tools/intakeTemplates.js';
import { TOOLS, TOOL_PAGES, TOOLS_HUB } from '../src/features/marketing/tools/toolsData.js';
import { VERTICALS } from '../src/features/marketing/verticalsData.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
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

test('default policy reads well and fits in Ivy (5000 chars)', () => {
  const t = generatePolicy(DEFAULT_POLICY_OPTIONS);
  assert.deepEqual(textProblems(t), []);
  assert.ok(t.startsWith('Cancellation policy\n'));
  assert.ok(t.includes("24 hours' notice"));
  assert.ok(t.includes('deposit'));
  assert.ok(t.length < 5000);
});

// Every combination of the choices (amounts rotate through valid, empty,
// junk and out-of-range values).
const AMOUNTS = ['', '40', '12.5', 'abc', '150', '-5', '$1,200'];
test('every option combination produces sensible text', () => {
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
    if (o.packages) assert.ok(t.includes('instead of a fee'), 'package rule');
  }
  assert.ok(n > 100000, `ran ${n} combinations`);
});

test('fees: amounts, percents, deposit counts toward the fee', () => {
  const base = { takesDeposit: true, lateAction: 'flat', lateAmount: '40', noShowAction: 'percent', noShowAmount: '100' };
  const t = generatePolicy(base);
  assert.ok(t.includes('For a late cancellation, I charge a fee of $40. Your deposit counts toward this fee.'));
  assert.ok(t.includes('For a no-show, I charge the full price of the appointment.'));
  assert.ok(t.includes('charged to the card on file'));
  assert.ok(generatePolicy({ ...base, lateAmount: '12.5' }).includes('$12.50'));
  assert.ok(generatePolicy({ ...base, lateAmount: '1200' }).includes('$1,200'));
  assert.ok(generatePolicy({ ...base, lateAmount: '' }).includes('I charge a fee. Your deposit'));
  assert.ok(generatePolicy({ ...base, noShowAmount: '50' }).includes('50% of the price of the appointment'));
  assert.ok(generatePolicy({ ...base, noShowAmount: '250' }).includes('the full price'), 'percent capped at 100');
  assert.ok(generatePolicy({ ...base, tone: 'gentle' }).includes('I may charge a fee of $40'));
  assert.ok(!generatePolicy({ ...base, takesDeposit: false }).includes('deposit'));
  const depOnly = generatePolicy({});
  assert.ok(!depOnly.includes('card on file'), 'no fee section when only the deposit is kept');
  assert.ok(depOnly.includes('refund your deposit or work something out'));
});

test('options are normalized safely', () => {
  const o = normalizePolicyOptions({ businessType: 'nope', voice: 'they', noticeHours: 5, tone: 'loud', lateAction: 'deposit', takesDeposit: false, businessName: '  A\u0007B  ' + 'x'.repeat(200) });
  assert.equal(o.businessType, 'other');
  assert.equal(o.voice, 'i');
  assert.equal(o.noticeHours, 24);
  assert.equal(o.tone, 'standard');
  assert.equal(o.lateAction, 'none');
  assert.ok(o.businessName.length <= 80 && !/\u0007/.test(o.businessName));
  assert.equal(cleanAmount('abc'), null);
  assert.equal(cleanAmount('0'), null);
  assert.equal(cleanAmount('$1,250.555'), 1250.56);
  assert.deepEqual(textProblems(generatePolicy(null)), []);
  assert.deepEqual(textProblems(generatePolicy(undefined)), []);
});

test('voice, tone and business type change the wording', () => {
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

console.log('deposit calculator');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

test('example numbers: every figure is correct', () => {
  const r = computeDeposit(DEFAULT_DEPOSIT_INPUTS); // $80, 20/week, 10%, 25%
  assert.equal(r.ok, true);
  close(r.bookingsPerMonth, 20 * 52 / 12, 'bookings a month');
  close(r.missedPerMonth, 20 * 52 / 12 * 0.1, 'missed a month');
  close(r.lostPerMonth, 20 * 52 / 12 * 0.1 * 80, 'lost a month');
  close(r.lostPerYear, 8320, 'lost a year');
  close(r.lostPerYear, r.lostPerMonth * 12, 'year = 12 months');
  close(r.depositAmount, 20, 'deposit');
  close(r.keptPerYear, 2080, 'kept a year');
  close(r.keptPerMonth * 12, r.keptPerYear, 'kept year = 12 months');
  close(r.stillLostPerYear, 6240, 'still lost');
  close(r.share, 0.25, 'share');
  assert.equal(r.suggestedLow, 20);
  assert.equal(r.suggestedHigh, 40);
  assert.equal(fmtMoney(r.lostPerMonth), '$693');
  assert.equal(fmtMoney(r.lostPerYear), '$8,320');
  assert.equal(fmtNum(r.missedPerMonth), '8.7');
});

test('flat deposits, caps and edge cases', () => {
  const flat = computeDeposit({ price: '150', perWeek: '8', rate: '5', depositMode: 'flat', deposit: '50' });
  close(flat.depositAmount, 50, 'flat deposit');
  close(flat.keptPerYear, 8 * 52 * 0.05 * 50, 'flat kept a year');
  close(flat.lostPerYear, 8 * 52 * 0.05 * 150, 'flat lost a year');
  assert.equal(flat.suggestedLow, 38); // 37.5 -> whole dollars under $50
  assert.equal(flat.suggestedHigh, 75);
  const capped = computeDeposit({ price: '60', perWeek: '10', rate: '10', depositMode: 'flat', deposit: '500' });
  close(capped.depositAmount, 60, 'deposit capped at price');
  assert.equal(capped.depositCapped, true);
  close(capped.share, 1, 'full price kept');
  const zero = computeDeposit({ price: '80', perWeek: '20', rate: '0', depositMode: 'percent', deposit: '25' });
  assert.equal(zero.ok, true);
  close(zero.lostPerYear, 0, 'zero rate');
  const noDep = computeDeposit({ price: '80', perWeek: '20', rate: '10', depositMode: 'percent', deposit: '' });
  close(noDep.keptPerYear, 0, 'no deposit keeps nothing');
  const over = computeDeposit({ price: '80', perWeek: '20', rate: '400', deposit: '25' });
  close(over.rate, 100, 'rate capped at 100%');
  const commas = computeDeposit({ price: '$1,200', perWeek: '2', rate: '10%', deposit: '25' });
  close(commas.price, 1200, 'parses $1,200');
  assert.equal(computeDeposit({ price: '1200', perWeek: '2', rate: '10', deposit: '25' }).suggestedLow, 300);
  assert.equal(computeDeposit({ price: '30', perWeek: '2', rate: '10', deposit: '25' }).suggestedLow, 8);
});

test('missing or invalid inputs ask for numbers instead of showing junk', () => {
  assert.deepEqual(computeDeposit({}).missing, ['price', 'perWeek', 'rate']);
  assert.deepEqual(computeDeposit({ price: 'abc', perWeek: '-3', rate: '' }).missing, ['price', 'perWeek', 'rate']);
  assert.equal(computeDeposit({ price: '0', perWeek: '10', rate: '5' }).ok, false);
  for (const v of Object.values(computeDeposit(DEFAULT_DEPOSIT_INPUTS))) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v));
  }
});

console.log('intake templates');

test('eight templates matching /for pages, with the right sections', () => {
  assert.equal(INTAKE_TEMPLATES.length, 8);
  for (const t of INTAKE_TEMPLATES) {
    assert.ok(VERTICALS[t.slug], `${t.slug} has a /for page`);
    assert.equal(t.sections[0].title, 'Contact details');
    const last = t.sections[t.sections.length - 1];
    assert.equal(last.title, 'Policies and agreement');
    assert.ok(last.questions.some((q) => q.includes('cancellation policy')));
    for (const s of t.sections) {
      if (/health|learning needs/i.test(s.title)) assert.ok(s.note && /private/i.test(s.note), `${t.slug}: ${s.title} has a privacy note`);
      assert.ok(s.questions.length >= 1);
      for (const q of s.questions) assert.deepEqual(textProblems(q), [], `${t.slug}: ${q}`);
    }
    const text = intakeTemplateText(t);
    assert.deepEqual(textProblems(text), [], t.slug);
    assert.ok(text.startsWith(t.title + '\n'));
    assert.match(intakeFileName(t), /^intake-form-[a-z-]+\.txt$/);
  }
  for (const s of ['massage-therapists', 'personal-trainers', 'estheticians']) {
    assert.ok(INTAKE_TEMPLATES.find((t) => t.slug === s).sections.some((x) => x.title === 'Health and safety'), `${s} has health questions`);
  }
});

console.log('pages and copy');

test('titles and descriptions fit search snippets and are unique', () => {
  const titles = new Set(); const descs = new Set();
  for (const p of TOOL_PAGES) {
    assert.ok(p.title.length <= 60, `${p.path} title ${p.title.length}`);
    assert.ok(p.description.length <= 160, `${p.path} description ${p.description.length}`);
    assert.ok(p.h1);
    titles.add(p.title); descs.add(p.description);
  }
  assert.equal(titles.size, TOOL_PAGES.length);
  assert.equal(descs.size, TOOL_PAGES.length);
  assert.equal(TOOLS_HUB.path, '/tools');
  for (const t of TOOLS) assert.equal(t.path, `/tools/${t.slug}`);
});

test('source copy follows the house rules', () => {
  const dir = path.join(ROOT, 'src/features/marketing/tools');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/[–—]/.test(src), `${f}: en or em dash`);
    assert.ok(!/business OS/i.test(src), `${f}: "business OS"`);
    assert.ok(!/no transaction fees|zero percent|0% fees|take a cut|takes a cut/i.test(src), `${f}: fee claim`);
    assert.ok(!/openai|anthropic|claude|chatgpt|\bgpt\b|gemini|llama|mistral/i.test(src), `${f}: AI vendor name`);
    assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|api\./.test(src.replace(/^\s*\/\/.*$/gm, '')), `${f}: tools must not send or store what people type`);
  }
});

if (process.exitCode) {
  console.error('\ntools-generators.test: FAILED');
  process.exit(1);
}
console.log(`\ntools-generators.test: ${passed} tests passed.`);
process.exit(0);

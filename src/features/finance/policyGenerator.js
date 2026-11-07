// Cancellation policy writer: the "Help me write it" panel on the
// Cancellation policy card (CancellationPolicyHelper.jsx) and Ivy's
// cancellation_policy draft / set_text actions (api/_lib/ivyAppTools.js).
// Pure: options in, plain text out. No network, no storage.
// Unit tests: tests/policy-generator.test.mjs.
//
// The wording follows how Ivy really applies the policy
// (api/_lib/bookingFees.js, api/_lib/cancellationPolicy.js):
//   - cancel in time: no fee; a deposit is refunded (the owner approves
//     each refund) unless the owner made deposits non-refundable
//   - cancel late or no-show: the deposit is kept and counts toward any fee
//   - fees are charged to the card on file; without card payments they
//     become an invoice
//   - package sessions used when booked: a late cancel (when there is a
//     late fee) or a no-show uses the session instead of a fee, never both;
//     used when completed: a cancel always gives the session back and the
//     normal fees apply
//   - the business cancels: never a fee, the session goes back
//   - inside the window clients contact the business to move a booking
// Copy rules: plain words, no dashes used as punctuation, no statistics.

export const BUSINESS_TYPES = [
  { value: 'massage', label: 'Massage therapy', noun: 'appointment', closeContact: true },
  { value: 'hair', label: 'Hair stylist or salon', noun: 'appointment', closeContact: true },
  { value: 'esthetics', label: 'Esthetics and skin care', noun: 'appointment', closeContact: true },
  { value: 'training', label: 'Personal training', noun: 'session', closeContact: true },
  { value: 'coaching', label: 'Coaching', noun: 'session', closeContact: false },
  { value: 'photography', label: 'Photography', noun: 'session', closeContact: false },
  { value: 'tutoring', label: 'Tutoring or lessons', noun: 'lesson', closeContact: false },
  { value: 'cleaning', label: 'Home cleaning', noun: 'visit', closeContact: false },
  { value: 'other', label: 'Another appointment-based business', noun: 'appointment', closeContact: false },
];

export const NOTICE_OPTIONS = [
  { value: 12, label: '12 hours' },
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
  { value: 72, label: '72 hours' },
  { value: 168, label: '7 days' },
];
// Any whole number of hours in this range is accepted too, so a policy can
// match a service's own cancellation window (for example 36 hours).
export const MIN_NOTICE_HOURS = 2;
export const MAX_NOTICE_HOURS = 720;

export const FEE_ACTIONS = [
  { value: 'deposit', label: 'Keep the deposit', needsDeposit: true },
  { value: 'flat', label: 'Charge a set fee ($)' },
  { value: 'percent', label: 'Charge a % of the price' },
  { value: 'none', label: 'No charge' },
];
// Ivy charges fixed dollar fees, so the app offers only these.
export const APP_FEE_ACTIONS = FEE_ACTIONS.filter((a) => a.value !== 'percent');

export const RESCHEDULE_OPTIONS = [
  { value: 'free', label: 'Free with notice, any time' },
  { value: 'once', label: 'One free move per booking' },
];

export const TONES = [
  { value: 'gentle', label: 'Gentle' },
  { value: 'standard', label: 'Standard' },
  { value: 'firm', label: 'Firm' },
];

export const VOICES = [
  { value: 'i', label: 'I (just me)' },
  { value: 'we', label: 'We (my business)' },
];

export const PACKAGE_USE = ['booking', 'completion'];

export const DEFAULT_POLICY_OPTIONS = Object.freeze({
  businessName: '',
  businessType: 'massage',
  voice: 'i',
  noticeHours: 24,
  takesDeposit: true,
  depositRefundable: true,
  lateAction: 'deposit',
  lateAmount: '',
  noShowAction: 'deposit',
  noShowAmount: '',
  reschedule: 'free',
  runningLate: true,
  packages: false,
  packageUse: 'booking',
  emergencies: true,
  graceFirst: false,
  cardFees: true,
  tone: 'standard',
});

const pick = (list, value, fallback) => (list.some((o) => o.value === value) ? value : fallback);

// A positive amount, or null when the field is empty or not a number.
export function cleanAmount(v, { max = 100000 } = {}) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n * 100) / 100, max);
}

function money(n) {
  return Number.isInteger(n) ? `$${n.toLocaleString('en-US')}` : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function noticeLabel(hours) {
  const h = Number(hours);
  if (h % 24 === 0 && h >= 96) return `${h / 24} days`;
  return `${h} hours`;
}

export function cleanNoticeHours(v, fallback = 24) {
  const n = Number(v);
  if (NOTICE_OPTIONS.some((o) => o.value === n)) return n;
  if (Number.isInteger(n) && n >= MIN_NOTICE_HOURS && n <= MAX_NOTICE_HOURS) return n;
  return fallback;
}

// Options from the panel, Ivy or anywhere, made safe and complete.
export function normalizePolicyOptions(input = {}) {
  const o = { ...DEFAULT_POLICY_OPTIONS, ...(input || {}) };
  const out = {
    // eslint-disable-next-line no-control-regex
    businessName: String(o.businessName || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
    businessType: pick(BUSINESS_TYPES, o.businessType, 'other'),
    voice: pick(VOICES, o.voice, 'i'),
    noticeHours: cleanNoticeHours(o.noticeHours),
    takesDeposit: !!o.takesDeposit,
    depositRefundable: o.depositRefundable !== false,
    lateAction: pick(FEE_ACTIONS, o.lateAction, 'none'),
    lateAmount: o.lateAmount,
    noShowAction: pick(FEE_ACTIONS, o.noShowAction, 'none'),
    noShowAmount: o.noShowAmount,
    reschedule: pick(RESCHEDULE_OPTIONS, o.reschedule, 'free'),
    runningLate: !!o.runningLate,
    packages: !!o.packages,
    packageUse: PACKAGE_USE.includes(o.packageUse) ? o.packageUse : 'booking',
    emergencies: !!o.emergencies,
    graceFirst: !!o.graceFirst,
    cardFees: o.cardFees !== false,
    tone: pick(TONES, o.tone, 'standard'),
  };
  // "Keep the deposit" only makes sense when there is one.
  if (!out.takesDeposit && out.lateAction === 'deposit') out.lateAction = 'none';
  if (!out.takesDeposit && out.noShowAction === 'deposit') out.noShowAction = 'none';
  return out;
}

function pronouns(voice) {
  return voice === 'we'
    ? { I: 'We', i: 'we', me: 'us', my: 'our', My: 'Our', Ive: "We've", ill: "we'll" }
    : { I: 'I', i: 'I', me: 'me', my: 'my', My: 'My', Ive: "I've", ill: "I'll" };
}


// What a late cancel or a no-show costs, as one or two sentences.
// `what` is "a late cancellation" or "a no-show".
function feeSentence({ action, amount, what, takesDeposit, noun, p, tone }) {
  const charge = `${p.i} ${tone === 'gentle' ? 'may charge' : 'charge'}`;
  const depositCounts = takesDeposit ? ' Your deposit counts toward this fee.' : '';
  if (action === 'deposit') {
    return tone === 'gentle'
      ? `For ${what}, ${p.i} keep the deposit you paid when you booked.`
      : `For ${what}, the deposit you paid when you booked is not refunded.`;
  }
  if (action === 'flat') {
    const amt = cleanAmount(amount);
    // No single amount (it differs by service): point at the fee the
    // client sees and agrees to when they book.
    return amt
      ? `For ${what}, ${charge} a fee of ${money(amt)}.${depositCounts}`
      : `For ${what}, ${charge} the fee shown when you book.${depositCounts}`;
  }
  if (action === 'percent') {
    const pct = cleanAmount(amount, { max: 100 });
    if (pct === 100) return `For ${what}, ${charge} the full price of the ${noun}.${depositCounts}`;
    return pct
      ? `For ${what}, ${charge} ${pct}% of the price of the ${noun}.${depositCounts}`
      : `For ${what}, ${charge} part of the price of the ${noun}.${depositCounts}`;
  }
  // none
  return tone === 'firm'
    ? `There is no fee for ${what}, but if it happens again, ${p.i} may ask you to prepay future ${noun}s.`
    : `There is no fee for ${what}. If it happens often, ${p.i} may ask you to prepay future ${noun}s.`;
}

const charges = (action) => action === 'flat' || action === 'percent';
const article = (noun) => (/^[aeiou]/.test(noun) ? 'an' : 'a');

export function generatePolicy(input) {
  const o = normalizePolicyOptions(input);
  const type = BUSINESS_TYPES.find((t) => t.value === o.businessType);
  const noun = type.noun;
  const p = pronouns(o.voice);
  const notice = `${noticeLabel(o.noticeHours)}' notice`;
  const tone = o.tone;
  // What "letting it go" means for this policy: a refund when the only
  // consequence is the deposit, otherwise waiving the fee.
  const onlyDeposit = [o.lateAction, o.noShowAction].every((a) => a === 'deposit' || a === 'none');
  const anyConsequence = o.lateAction !== 'none' || o.noShowAction !== 'none';
  const relief = onlyDeposit ? 'refund your deposit' : 'waive the fee';
  const lines = [];
  const section = (title, bullets) => {
    const items = bullets.filter(Boolean);
    if (!items.length) return;
    lines.push('', title, ...items.map((b) => `• ${b}`));
  };

  lines.push(o.businessName ? `${o.businessName}: cancellation policy` : 'Cancellation policy');
  lines.push('');
  if (tone === 'gentle') {
    lines.push(`${p.I} keep a small schedule so every client gets ${p.my} full attention. A spot cancelled at the last minute is hard to fill, so ${p.i} ask for a little notice when your plans change. Thank you for understanding.`);
  } else if (tone === 'firm') {
    lines.push(`Your ${noun} time is reserved for you alone, and a last-minute cancellation usually cannot be filled. Please read this policy before you book. Booking ${article(noun)} ${noun} means you agree to it.`);
  } else {
    lines.push(`When you book, that time is set aside just for you. This policy explains what happens if you need to cancel, reschedule or miss your ${noun}.`);
  }

  section('Cancelling or rescheduling', [
    `Please give at least ${notice} if you need to cancel or reschedule.`,
    !o.takesDeposit
      ? `With ${notice} or more, there is no charge.`
      : o.depositRefundable
        ? `With ${notice} or more, there is no charge. Your deposit is refunded, or carried over to your new time if you reschedule.`
        : `With ${notice} or more, there is no fee. Deposits are not refundable, but if you reschedule in time, your deposit moves to your new time.`,
    o.reschedule === 'once'
      ? `You can move each booking once for free with at least ${notice}. After that, a change counts as a cancellation.`
      : `You can reschedule for free as often as you need, as long as you give at least ${notice}.`,
    `To cancel or reschedule, reply to your booking confirmation or message ${p.me} directly.`,
  ]);

  section(`Late cancellations (less than ${notice})`, [
    `A cancellation or change with less than ${notice} is a late cancellation.`,
    feeSentence({ action: o.lateAction, amount: o.lateAmount, what: 'a late cancellation', takesDeposit: o.takesDeposit, noun, p, tone }),
    `If you need to move your ${noun} with less than ${notice}, contact ${p.me} directly and ${p.ill} do ${p.my} best to find another time.${tone === 'gentle' && o.lateAction !== 'none' ? ` If ${p.i} can fill your spot, ${p.i} may ${o.lateAction === 'deposit' ? 'refund your deposit' : 'waive the fee'}.` : ''}`,
  ]);

  section(`Missed ${noun}s (no-shows)`, [
    o.businessType === 'cleaning'
      ? `A no-show is a visit ${p.i} cannot carry out because ${p.i} cannot get into your home at the agreed time and you did not cancel.`
      : `A no-show is when you miss your ${noun} without letting ${p.me} know before it starts.`,
    feeSentence({ action: o.noShowAction, amount: o.noShowAmount, what: 'a no-show', takesDeposit: o.takesDeposit, noun, p, tone }),
    tone === 'firm' && o.noShowAction !== 'none' ? `After two no-shows, ${p.i} may ask you to prepay in full to book again.` : null,
  ]);

  if (charges(o.lateAction) || charges(o.noShowAction)) {
    section('How fees are paid', [
      o.cardFees
        ? 'Any fee is charged to the card on file for your booking. If there is no card on file, you will receive an invoice for it.'
        : 'If a fee applies, you will receive an invoice for it.',
      'You will never be charged more than the fee in the policy you agreed to when you booked.',
    ]);
  }

  if (o.runningLate && o.businessType !== 'cleaning') {
    section('Running late', [
      o.businessType === 'photography'
        ? `If you are running late, please let ${p.me} know. Your ${noun} may still need to end at the planned time, and the full price still applies.`
        : `If you are running late, please let ${p.me} know. Your ${noun} will still end on time so the next client is not kept waiting, and the full price still applies.`,
    ]);
  }

  if (o.packages) {
    const pkg = 'If you booked with a session from a package';
    if (o.packageUse === 'completion') {
      section('Packages and prepaid sessions', [
        `${pkg}, the session counts as used once your ${noun} takes place.`,
        'If you cancel, the session goes back into your package. The rules above for late cancellations still apply.',
        charges(o.noShowAction)
          ? 'A no-show uses the session, and the no-show fee above also applies.'
          : 'A no-show uses the session.',
      ]);
    } else {
      section('Packages and prepaid sessions', [
        charges(o.lateAction)
          ? `${pkg}, a late cancellation or a no-show uses that session instead of a fee. You are never charged a fee and a session for the same booking.`
          : `${pkg}, a no-show uses that session instead of a fee. You are never charged a fee and a session for the same booking.`,
        charges(o.lateAction)
          ? `With ${notice} or more, the session goes back into your package.`
          : 'If you cancel, the session goes back into your package.',
      ]);
    }
  }

  const kindness = [];
  if (o.graceFirst && o.lateAction !== 'none') {
    kindness.push(o.lateAction === 'deposit'
      ? `Your first late cancellation is on ${p.me}: your deposit is refunded, no questions. The policy applies from the second one.`
      : `Your first late cancellation is on ${p.me}: no fee, no questions. The policy applies from the second one.`);
  }
  if (o.emergencies) {
    const emergency = 'such as sudden illness, a family emergency or unsafe weather';
    if (!anyConsequence) {
      kindness.push(`In an emergency, ${emergency}, please let ${p.me} know as soon as you can so ${p.i} can offer your time to someone else.`);
    } else {
      kindness.push(tone === 'firm'
        ? `In a genuine emergency, ${emergency}, contact ${p.me} as soon as you can. ${p.I} may ${relief} at ${p.my} discretion.`
        : `Life happens. In an emergency, ${emergency}, let ${p.me} know as soon as you can and ${p.ill} ${relief} or work something out with you.`);
    }
  }
  if (type.closeContact) {
    kindness.push(tone === 'firm'
      ? `If you feel unwell or think you may be contagious, please reschedule and tell ${p.me} as soon as you can.`
      : `If you feel unwell or think you may be contagious, please reschedule. ${p.I} would rather see you when you feel better.`);
  }
  if (o.businessType === 'tutoring') {
    kindness.push('For students under 18, this policy applies to the parent or guardian who books.');
  }
  section(kindness.length && (o.emergencies || (o.graceFirst && o.lateAction !== 'none')) ? 'Emergencies and exceptions' : 'Good to know', kindness);

  section(`If ${p.i} need to cancel`, [
    `If ${p.i} ever have to cancel or move your ${noun}, ${p.ill} tell you as soon as possible and you will never be charged a fee.`,
    o.takesDeposit ? 'Any deposit is refunded or carried over to your new time, whichever you prefer.' : null,
    o.packages ? 'If you booked with a package session, the session goes back into your package.' : null,
  ]);

  lines.push('');
  lines.push(tone === 'gentle'
    ? `Thank you for respecting ${p.my} time. ${p.I} will always respect yours.`
    : tone === 'firm'
      ? 'By booking, you confirm you have read and agree to this policy.'
      : 'Thank you for understanding. Questions? Just ask before you book.');

  return lines.join('\n');
}

// ── Starting point from what Ivy already knows ──────────────────────────
// Business category (calendar_settings.category, the onboarding "What do
// you do?" answer) to the closest wording type. Service names refine it
// when the category is broad.
const CATEGORY_TYPES = {
  Wellness: 'massage', Beauty: 'hair', Fitness: 'training', Home: 'cleaning',
  Creative: 'photography', Education: 'tutoring', Professional: 'coaching',
};
const NAME_HINTS = [
  [/massage|bodywork|reflexology/i, 'massage'],
  [/facial|esthetic|skin|brow|lash|wax/i, 'esthetics'],
  [/hair|cut|color|colour|blowout|braid|barber/i, 'hair'],
  [/training|workout|pilates|yoga|fitness/i, 'training'],
  [/coach/i, 'coaching'],
  [/photo|shoot|portrait/i, 'photography'],
  [/tutor|lesson|class/i, 'tutoring'],
  [/clean/i, 'cleaning'],
];
export function businessTypeFor({ category, serviceNames = [] } = {}) {
  const names = (Array.isArray(serviceNames) ? serviceNames : []).map((n) => String(n || '')).join(' ');
  const byName = names ? (NAME_HINTS.find(([re]) => re.test(names)) || [])[1] : null;
  const byCategory = CATEGORY_TYPES[String(category || '')] || null;
  if (byCategory === 'hair' && byName === 'esthetics') return 'esthetics';
  return byCategory || byName || 'other';
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

function feeChoice(amounts, takesDeposit) {
  const fees = amounts.filter((a) => Number(a) > 0).map(Number);
  if (!fees.length) return { action: takesDeposit ? 'deposit' : 'none', amount: '' };
  const same = fees.every((a) => a === fees[0]);
  return { action: 'flat', amount: same ? String(fees[0]) : '' };
}

// The panel's and Ivy's starting options, from the business's real
// settings, so the words match how Ivy will behave:
//   services: [{ name, depositType, depositAmount, lateCancelFee, windowHours, noShowFee }]
//   settings: { refundDepositOutsideWindow }
//   packages: { any, useOn }   cardPayments: bool
// Returns { options, notes } where notes says what came from where.
export function policyOptionsFromIvy({ businessName = '', category = null, services = [], settings = {}, packages = {}, cardPayments = true } = {}) {
  const list = Array.isArray(services) ? services : [];
  const hasDeposit = (s) => s.depositType && s.depositType !== 'none' && (s.depositType === 'full' || Number(s.depositAmount) > 0);
  const takesDeposit = list.some(hasDeposit);
  const withRules = list.filter((s) => Number(s.lateCancelFee) > 0 || Number(s.noShowFee) > 0 || hasDeposit(s));
  const windows = (withRules.length ? withRules : list)
    .map((s) => Number(s.windowHours)).filter((h) => Number.isInteger(h) && h >= MIN_NOTICE_HOURS && h <= MAX_NOTICE_HOURS);
  const noticeHours = cleanNoticeHours(mostCommon(windows), 24);
  const late = feeChoice(list.map((s) => s.lateCancelFee), takesDeposit);
  const noShow = feeChoice(list.map((s) => s.noShowFee), takesDeposit);
  const options = normalizePolicyOptions({
    ...DEFAULT_POLICY_OPTIONS,
    businessName,
    businessType: businessTypeFor({ category, serviceNames: list.map((s) => s.name) }),
    noticeHours,
    takesDeposit,
    depositRefundable: settings?.refundDepositOutsideWindow !== false,
    lateAction: late.action, lateAmount: late.amount,
    noShowAction: noShow.action, noShowAmount: noShow.amount,
    packages: !!packages?.any,
    packageUse: packages?.useOn === 'completion' ? 'completion' : 'booking',
    cardFees: cardPayments !== false,
  });
  const notes = {
    fromServices: list.length > 0,
    mixedWindows: new Set(windows).size > 1,
    mixedLateFees: late.action === 'flat' && !late.amount,
    mixedNoShowFees: noShow.action === 'flat' && !noShow.amount,
  };
  return { options, notes };
}

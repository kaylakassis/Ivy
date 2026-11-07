// Cancellation policy generator (/tools/cancellation-policy-generator).
// Pure: options in, plain text out. Runs only in the visitor's browser;
// nothing they pick is sent anywhere. Unit tests: tests/tools-generators.test.mjs.
//
// The wording follows how Ivy's own cancellation policy works
// (api/_lib/bookingFees.js, api/_lib/cancellationPolicy.js):
//   - cancel in time: no fee, and a deposit is refunded
//   - cancel late or no-show: the deposit is kept and counts toward any fee
//   - package sessions: a late cancel or no-show uses the session instead
//     of a fee, never both
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

export const FEE_ACTIONS = [
  { value: 'deposit', label: 'Keep the deposit', needsDeposit: true },
  { value: 'flat', label: 'Charge a set fee ($)' },
  { value: 'percent', label: 'Charge a % of the price' },
  { value: 'none', label: 'No charge' },
];

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

export const DEFAULT_POLICY_OPTIONS = Object.freeze({
  businessName: '',
  businessType: 'massage',
  voice: 'i',
  noticeHours: 24,
  takesDeposit: true,
  lateAction: 'deposit',
  lateAmount: '',
  noShowAction: 'deposit',
  noShowAmount: '',
  reschedule: 'free',
  runningLate: true,
  packages: false,
  emergencies: true,
  graceFirst: false,
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

function noticeText(hours) {
  return hours === 168 ? '7 days' : `${hours} hours`;
}

// Options from the form (or anywhere) made safe and complete.
export function normalizePolicyOptions(input = {}) {
  const o = { ...DEFAULT_POLICY_OPTIONS, ...(input || {}) };
  const out = {
    // eslint-disable-next-line no-control-regex
    businessName: String(o.businessName || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
    businessType: pick(BUSINESS_TYPES, o.businessType, 'other'),
    voice: pick(VOICES, o.voice, 'i'),
    noticeHours: pick(NOTICE_OPTIONS, Number(o.noticeHours), 24),
    takesDeposit: !!o.takesDeposit,
    lateAction: pick(FEE_ACTIONS, o.lateAction, 'none'),
    lateAmount: o.lateAmount,
    noShowAction: pick(FEE_ACTIONS, o.noShowAction, 'none'),
    noShowAmount: o.noShowAmount,
    reschedule: pick(RESCHEDULE_OPTIONS, o.reschedule, 'free'),
    runningLate: !!o.runningLate,
    packages: !!o.packages,
    emergencies: !!o.emergencies,
    graceFirst: !!o.graceFirst,
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
    return `For ${what}, ${charge} a fee${amt ? ` of ${money(amt)}` : ''}.${depositCounts}`;
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
  const notice = `${noticeText(o.noticeHours)}' notice`;
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
    o.takesDeposit
      ? `With ${notice} or more, there is no charge. Your deposit is refunded, or carried over to your new time if you reschedule.`
      : `With ${notice} or more, there is no charge.`,
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
      'Any fee is charged to the card on file for your booking. If there is no card on file, you will receive an invoice for it.',
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
    section('Packages and prepaid sessions', [
      'If you booked with a session from a package, a late cancellation or a no-show uses that session instead of a fee. You are never charged a fee and a session for the same booking.',
      `With ${notice} or more, the session goes back into your package.`,
    ]);
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
  ]);

  lines.push('');
  lines.push(tone === 'gentle'
    ? `Thank you for respecting ${p.my} time. ${p.I} will always respect yours.`
    : tone === 'firm'
      ? 'By booking, you confirm you have read and agree to this policy.'
      : 'Thank you for understanding. Questions? Just ask before you book.');

  return lines.join('\n');
}

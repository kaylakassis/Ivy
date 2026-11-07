// Booking deposit calculator (/tools/deposit-calculator). Pure math on the
// visitor's own numbers, in their browser. No industry averages: every
// result is their price x their bookings x their own no-show estimate.
// Unit tests: tests/tools-generators.test.mjs.

// 52 weeks / 12 months.
export const WEEKS_PER_MONTH = 52 / 12;

// Example numbers the page starts with, labeled on the page as an example
// to replace with your own.
export const DEFAULT_DEPOSIT_INPUTS = Object.freeze({
  price: '80',
  perWeek: '20',
  rate: '10',
  depositMode: 'percent', // 'percent' | 'flat'
  deposit: '25',
});

// Suggested deposit as a share of the price: a starting range, explained
// on the page, not a statistic.
export const SUGGESTED_LOW = 0.25;
export const SUGGESTED_HIGH = 0.5;

function num(v, { min = 0, max = Infinity } = {}) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  if (!Number.isFinite(n) || n < min) return null;
  return Math.min(n, max);
}

// Round to whole dollars, or to $5 above $50, for a friendly suggestion.
function friendly(n) {
  if (n <= 0) return 0;
  if (n < 50) return Math.max(1, Math.round(n));
  return Math.round(n / 5) * 5;
}

// Returns { ok: false, missing: [...] } until price, bookings and rate are
// all valid; then every figure the page shows.
export function computeDeposit(input = {}) {
  const price = num(input.price, { max: 1_000_000 });
  const perWeek = num(input.perWeek, { max: 1000 });
  const rate = num(input.rate, { max: 100 });
  const mode = input.depositMode === 'flat' ? 'flat' : 'percent';
  const rawDeposit = num(input.deposit, { max: mode === 'percent' ? 100 : 1_000_000 });

  const missing = [];
  if (!price) missing.push('price');
  if (!perWeek) missing.push('perWeek');
  if (rate == null) missing.push('rate');
  if (missing.length) return { ok: false, missing };

  const bookingsPerMonth = perWeek * WEEKS_PER_MONTH;
  const bookingsPerYear = perWeek * 52;
  const missedPerMonth = bookingsPerMonth * (rate / 100);
  const missedPerYear = bookingsPerYear * (rate / 100);
  const lostPerMonth = missedPerMonth * price;
  const lostPerYear = missedPerYear * price;

  // A deposit can never be more than the price.
  const depositAmount = rawDeposit == null ? 0
    : mode === 'percent' ? price * (rawDeposit / 100) : Math.min(rawDeposit, price);
  const keptPerMonth = missedPerMonth * depositAmount;
  const keptPerYear = missedPerYear * depositAmount;
  const share = price > 0 ? depositAmount / price : 0;

  return {
    ok: true,
    price, perWeek, rate, mode,
    depositInput: rawDeposit,
    depositAmount,
    depositCapped: mode === 'flat' && rawDeposit != null && rawDeposit > price,
    bookingsPerMonth, bookingsPerYear,
    missedPerMonth, missedPerYear,
    lostPerMonth, lostPerYear,
    keptPerMonth, keptPerYear,
    stillLostPerMonth: lostPerMonth - keptPerMonth,
    stillLostPerYear: lostPerYear - keptPerYear,
    share, // fraction of today's no-show losses the deposit keeps
    suggestedLow: friendly(price * SUGGESTED_LOW),
    suggestedHigh: friendly(price * SUGGESTED_HIGH),
  };
}

export function fmtMoney(n) {
  const v = Number(n) || 0;
  const whole = Math.abs(v) >= 100 || Number.isInteger(v);
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

export function fmtNum(n, digits = 1) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

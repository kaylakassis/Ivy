// When may the iPhone app ask for an App Store rating? Pure logic, no
// imports, so it is unit-tested on its own (tests/rating-gate.test.mjs) and
// the runtime (ratingPrompt.js) only adds storage and the Apple call.
//
// We ask only after a real win, and only when the moment is exactly the
// milestone (the first paid invoice, not every paid invoice), so a win
// kind can never ask twice by itself:
//   invoice_paid        the 1st invoice marked paid
//   booking_completed   the 10th completed booking
//   website_published   the 1st website publish
//   partner_cleared     the accountability partner has been on for a week
//                       and the 3rd "needs you" item has been cleared
// On top of that: owners only (never helpers or clients, never while an
// admin is viewing as the owner), never during onboarding, never on a
// paywall or crash screen, and at most once per 120 days counting both
// this phone's last ask and the server's (so a reinstall does not ask
// sooner). Apple itself shows the window at most three times a year;
// 120 days keeps us under that on its own.

export const RATING_INTERVAL_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WIN_RULES = {
  invoice_paid:      { count: 1 },
  booking_completed: { count: 10 },
  website_published: { count: 1 },
  partner_cleared:   { count: 3, partnerOnDays: 7 },
};

export const WIN_KINDS = Object.keys(WIN_RULES);

function toMs(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
}

// Is this the milestone moment for `kind`, given the counts so far
// (including this win)?
export function isWinMoment(kind, counts = {}, { partnerOnAt = null, now = Date.now() } = {}) {
  const rule = WIN_RULES[kind];
  if (!rule) return false;
  const n = Number(counts[kind]) || 0;
  if (n !== rule.count) return false;
  if (rule.partnerOnDays) {
    const on = toMs(partnerOnAt);
    if (on == null) return false;
    if (toMs(now) - on < rule.partnerOnDays * DAY_MS) return false;
  }
  return true;
}

// The latest ask we know of, from this phone or the server.
export function lastAsk(lastAskedAt, serverPromptedAt) {
  const a = toMs(lastAskedAt);
  const b = toMs(serverPromptedAt);
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

export function askedRecently({ lastAskedAt = null, serverPromptedAt = null, now = Date.now() } = {}) {
  const at = lastAsk(lastAskedAt, serverPromptedAt);
  if (at == null) return false;
  return toMs(now) - at < RATING_INTERVAL_DAYS * DAY_MS;
}

// The whole decision. Returns { ask, reason } so callers (and tests) can
// see why not.
export function ratingGate({
  kind, counts = {}, role = null, pathname = '', blocked = false,
  lastAskedAt = null, serverPromptedAt = null, partnerOnAt = null, now = Date.now(),
} = {}) {
  if (role !== 'owner') return { ask: false, reason: 'not-owner' };
  if (typeof pathname === 'string' && /^\/onboarding(\/|$)/.test(pathname)) return { ask: false, reason: 'onboarding' };
  if (blocked) return { ask: false, reason: 'blocked' };
  if (!isWinMoment(kind, counts, { partnerOnAt, now })) return { ask: false, reason: 'not-a-win' };
  if (askedRecently({ lastAskedAt, serverPromptedAt, now })) return { ask: false, reason: 'asked-recently' };
  return { ask: true, reason: 'win' };
}

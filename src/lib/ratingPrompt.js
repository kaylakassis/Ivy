// App Store rating prompt for the iPhone app, asked at a happy moment.
//
// Screens report wins with useRatingWin(): `win('booking_completed')` after
// a Complete, `win('invoice_paid')` after a paid invoice, and so on. This
// file counts them on the phone (@capacitor/preferences), runs the pure
// gate in ratingGate.js, and when it says yes:
//   1. remembers the ask on the phone and on the server
//      (POST /api/me/rating-prompt → users.rating_prompted_at, so a
//      reinstall does not ask again inside 120 days), then
//   2. opens Apple's rating window (SKStoreReviewController) a moment
//      later, after the screen's own "done" toast has landed.
// Apple decides whether the window actually shows; we never add our own.
// On the web every call is a no-op.
import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { isNative } from './platform.js';
import { api } from './api.js';
import { ratingGate, WIN_KINDS } from './ratingGate.js';
import { useUserContext } from './userContext.jsx';
import { useAuth } from './auth.jsx';

export const KEY_WINS = 'ivy_rating_wins';
export const KEY_ASKED = 'ivy_rating_asked_at';
const ASK_DELAY_MS = 1200;

// Returned as plain functions: a Capacitor plugin proxy must never be the
// value of an async function (the promise machinery would probe its .then).
async function prefs() {
  const { Preferences } = await import('@capacitor/preferences');
  return { get: (o) => Preferences.get(o), set: (o) => Preferences.set(o) };
}

async function readWins(P) {
  try {
    const { value } = await P.get({ key: KEY_WINS });
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

// Anything on screen that says "this is not a happy moment".
function screenBlocked() {
  if (typeof document === 'undefined') return true;
  const b = document.body;
  if (b.classList.contains('app-walled')) return true;          // paywall
  if (document.querySelector('[data-route-crash]')) return true; // crash fallback
  return false;
}

export async function requestAppleRating() {
  const { InAppReview } = await import('@capacitor-community/in-app-review');
  await InAppReview.requestReview();
}

// Count one win of `kind` and ask if this is the moment. Returns the gate
// result so the harness and tests can see what happened.
export async function recordRatingWin(kind, { role = null, pathname = '', partnerOnAt = null, setCount = null } = {}) {
  if (!isNative()) return { ask: false, reason: 'web' };
  if (!WIN_KINDS.includes(kind)) return { ask: false, reason: 'unknown-kind' };
  try {
    const P = await prefs();
    const wins = await readWins(P);
    // Server-counted wins (the partner's cleared items) set the count
    // outright; everything else is counted on this phone.
    wins[kind] = setCount != null ? Number(setCount) || 0 : (Number(wins[kind]) || 0) + 1;
    await P.set({ key: KEY_WINS, value: JSON.stringify(wins) });
    const lastAskedAt = (await P.get({ key: KEY_ASKED })).value || null;
    const now = Date.now();
    const base = { kind, counts: wins, role, pathname, partnerOnAt, now, lastAskedAt, blocked: screenBlocked() };
    let gate = ratingGate(base);
    if (!gate.ask) return gate;
    // The phone says yes: check the server's last ask before committing
    // (a fresh install has no local date).
    let serverPromptedAt = null;
    try { serverPromptedAt = (await api.get('/me/rating-prompt'))?.ratingPromptedAt || null; } catch { /* offline: trust the phone */ }
    gate = ratingGate({ ...base, serverPromptedAt });
    if (!gate.ask) {
      if (serverPromptedAt) await P.set({ key: KEY_ASKED, value: String(serverPromptedAt) });
      return gate;
    }
    const iso = new Date(now).toISOString();
    await P.set({ key: KEY_ASKED, value: iso });
    api.post('/me/rating-prompt', {}).catch(() => {});
    setTimeout(() => { requestAppleRating().catch(() => {}); }, ASK_DELAY_MS);
    return gate;
  } catch (e) {
    console.warn('[rating] skipped:', e?.message || e); // eslint-disable-line no-console
    return { ask: false, reason: 'error' };
  }
}

// Partner win: the server knows when the partner was turned on and how
// many items it named were cleared since. Checked from the dashboard once
// it loads with the partner on; cheap and only ever on the phone.
export async function checkPartnerRatingWin({ role, pathname }) {
  if (!isNative() || role !== 'owner') return { ask: false, reason: 'not-owner' };
  try {
    const r = await api.get('/me/rating-prompt');
    const partner = r?.partner;
    if (!partner?.onSince) return { ask: false, reason: 'partner-off' };
    return recordRatingWin('partner_cleared', { role, pathname, partnerOnAt: partner.onSince, setCount: partner.clearedCount });
  } catch {
    return { ask: false, reason: 'error' };
  }
}

export function roleOf(ctx, impersonating) {
  if (impersonating) return 'admin-view';
  if (ctx?.isOwner) return 'owner';
  if (ctx?.isClient) return 'client';
  return null;
}

// `win(kind)` for screens. Safe anywhere under AppShell; outside the user
// context it reports no role and the gate says no.
export function useRatingWin() {
  const { ctx } = useUserContext() || {};
  const { impersonating } = useAuth();
  const { pathname } = useLocation();
  const role = roleOf(ctx, impersonating);
  return useCallback((kind) => recordRatingWin(kind, { role, pathname }), [role, pathname]);
}

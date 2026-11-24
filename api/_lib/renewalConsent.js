// A record that a person asked to start a plan that renews by itself.
//
// The Terms say a subscription starts when someone buys it and agrees to
// recurring charges. The screens that lead to checkout say what renews, how
// often, at what price and how to cancel; pressing the button is the
// agreement. This keeps Ivy's own proof of that moment (who, when, from
// where, which plan, whether a free trial came first, and which screen they
// were on), next to their acceptance of the Terms in legal_acceptances.
// Stripe keeps its own record of the payment authorization.
//
// It never blocks a checkout: a failure to write is logged and skipped.
import { sql } from './db.js';
import { getClientIp } from './rate-limit.js';

// Bump when the wording on the subscribe screens changes in substance.
export const RENEWAL_TERMS_VERSION = '2026-11-24';

const SCREENS = new Set(['paywall', 'account-confirm']);

export function renewalConsentVersion({ plan, trialDays, shown }) {
  const screen = SCREENS.has(String(shown || '')) ? String(shown) : 'not-stated';
  return [
    RENEWAL_TERMS_VERSION,
    plan === 'annual' ? 'annual' : 'weekly',
    trialDays ? `trial-${Number(trialDays)}d` : 'no-trial',
    screen,
  ].join(':');
}

export async function recordRenewalConsent({ userId, req, plan, trialDays, shown }) {
  if (!userId) return false;
  try {
    const ua = req?.headers?.['user-agent']?.toString().slice(0, 500) || null;
    await sql`
      INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
      VALUES (${userId}, 'auto_renewal', ${renewalConsentVersion({ plan, trialDays, shown })}, ${req ? getClientIp(req) : null}, ${ua})
    `;
    return true;
  } catch (err) {
    console.error('[renewalConsent] could not record:', err?.message);
    return false;
  }
}

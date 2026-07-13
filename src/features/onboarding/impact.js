// Pure projection behind the onboarding "Here's what Ivy sees for you"
// proof step. React-free so it can be unit-tested directly.
//
// A brand-new workspace has NO real data at signup, so this is an honest
// projection seeded from the answers the owner already gave on the About
// step (business stage, stated challenges, what they sell). It reuses the
// SAME conservative assumptions as the marketing ROI calculator
// (pricing.js) so the two numbers can never drift. It is always framed to
// the user as "typical for a business like yours" - never presented as a
// scan of their real account.
import {
  STACK_TOTAL, IVY_PRICE, BILLABLE_RATE, ADMIN_AUTOMATED,
  NO_SHOW_RATE, WEEKS_PER_MONTH,
} from '../../lib/pricing.js';

// Rough monthly client volume implied by business stage. Used only to
// scale the (already conservative) no-show recovery estimate. Held modest
// so a brand-new owner never sees a fantasy number.
const STAGE_CLIENTS = {
  starting:    12,
  side_hustle: 20,
  established: 45,
  scaling:     80,
};
const DEFAULT_CLIENTS = 20;

// Typical admin hours/week a solo owner spends before automation. Flat
// (not stage-scaled) because early-stage admin burden is fairly constant.
const ADMIN_HOURS_PER_WEEK = 6;

// Seed a conservative monthly upside from onboarding answers.
// Returns plain numbers + an `emphasis` hint the UI uses to highlight the
// stat that maps to the owner's stated pain.
export function computeImpact({ challengeIds = [], stageIds = [], businessType = 'both' } = {}) {
  const challenges = Array.isArray(challengeIds) ? challengeIds : [];
  const stages = Array.isArray(stageIds) ? stageIds : [];

  const clientsPerMonth = STAGE_CLIENTS[stages[0]] || DEFAULT_CLIENTS;

  // Admin hours Ivy reclaims per month, and what that time is worth.
  const reclaimedHours = Math.round(ADMIN_HOURS_PER_WEEK * WEEKS_PER_MONTH * ADMIN_AUTOMATED);
  const hoursRevenue = reclaimedHours * BILLABLE_RATE;

  // No-shows recovered per month (reminders + card on file). Product-only
  // businesses don't take appointments, so no-show recovery doesn't apply.
  const takesAppointments = businessType !== 'product';
  const noShowsPrevented = takesAppointments ? Math.round(clientsPerMonth * NO_SHOW_RATE) : 0;
  const noShowRevenue = noShowsPrevented * BILLABLE_RATE;

  const recovered = hoursRevenue + noShowRevenue;
  const toolSavings = Math.max(0, Math.round(STACK_TOTAL - IVY_PRICE));
  const totalUpside = recovered + toolSavings;

  // Which stat to visually emphasize, keyed off the owner's stated pain:
  //   getting_paid / no_shows → they feel the money leak most → recovered $
  //   organized               → they feel the time drain most → hours back
  //   otherwise               → the universal value: replaces the stack
  let emphasis = 'total';
  if (challenges.includes('getting_paid') || challenges.includes('no_shows')) emphasis = 'recovered';
  else if (challenges.includes('organized')) emphasis = 'hours';

  return {
    clientsPerMonth,
    reclaimedHours,
    noShowsPrevented,
    recovered,
    toolSavings,
    totalUpside,
    emphasis,
    takesAppointments,
  };
}

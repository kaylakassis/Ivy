// The payoff, in one sentence: what came in over the last 7 days and how
// much of it arrived after a reminder Ivy sent. Mirrors payoffLine in
// api/_lib/weeklyRecap.js (the weekly email says the same thing). Returns
// null when nothing was collected, so nothing is ever claimed.
import { fmtMoney } from './format.js';

export function payoffParts(week, currency) {
  const paid = Number(week?.revenuePaid || 0);
  if (!(paid > 0)) return null;
  const after = Math.min(Number(week?.revenueAfterReminder || 0), paid);
  const headline = `You collected ${fmtMoney(paid, currency)} in the last 7 days`;
  const detail = !(after > 0) ? null
    : after >= paid ? 'All of it after a reminder Ivy sent'
    : `${fmtMoney(after, currency)} of it after a reminder Ivy sent`;
  return { headline, detail };
}

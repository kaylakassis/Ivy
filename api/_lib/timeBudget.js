// Keeping scheduled jobs inside the platform's 5-minute function limit.
// A run that is cut off records nothing and leaves its work half done, so
// the notification jobs stop early on their own and let the next run pick
// up where they left off (their sends are claimed one by one, so nothing
// is sent twice and nothing is skipped).
export const CRON_BUDGET_MS = 4 * 60 * 1000;

export function makeDeadline(ms = CRON_BUDGET_MS) {
  const end = Date.now() + ms;
  return { passed: () => Date.now() > end };
}

// Resolves to the promise's value, or to `fallback` if it has not settled
// within `ms`. The slow work is not cancelled; we just stop waiting for it.
export function withTimeout(promise, ms, fallback = null) {
  let timer;
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), t]);
}

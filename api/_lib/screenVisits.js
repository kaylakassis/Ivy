// Which screens an owner opens, so the operator can see where new accounts
// stop.
//
// One row per owner, per screen, per day: how many times it was opened and
// when it was first and last opened that day. Nothing about what is on the
// screen, no client data, no free text: the screen must be one of the names
// below or the visit is dropped. Kept 180 days (api/cron/db-prune.js), and
// removed with the account.
//
// Admin > First week reads firstWeekReport(): for accounts that signed up
// recently, how many reached each screen in their first seven days, how many
// days they came back, and the last screen seen by the ones who went quiet.
import { sql } from './db.js';

export const SCREENS = {
  dashboard: 'Home',
  progress: 'Progress',
  calendar: 'Calendar',
  clients: 'Clients',
  'clients-rewards': 'Clients: Rewards',
  'clients-reminders': 'Clients: Reminders',
  finance: 'Money',
  ivy: 'Ivy',
  messages: 'Messages',
  programs: 'Programs',
  automation: 'Automation',
  reviews: 'Reviews',
  website: 'Website',
  shops: 'Shop',
  documents: 'Documents',
  account: 'Account',
  more: 'More',
};
export const FIRST_WEEK_DAYS = 7;
export const QUIET_AFTER_DAYS = 7;
export const WINDOWS = [30, 60, 90];

// Records one visit. Returns false (and writes nothing) for an unknown
// screen or a missing owner.
export async function recordScreenVisit({ userId, workspaceId, screen }) {
  if (!userId || !workspaceId || !Object.prototype.hasOwnProperty.call(SCREENS, screen)) return false;
  await sql`
    INSERT INTO screen_visits (user_id, workspace_id, screen, day, visits, first_at, last_at)
    VALUES (${userId}, ${workspaceId}, ${screen}, (NOW() AT TIME ZONE 'UTC')::date, 1, NOW(), NOW())
    ON CONFLICT (user_id, screen, day) DO UPDATE
      SET visits = screen_visits.visits + 1, last_at = NOW()`;
  return true;
}

// Real customers only: no testers, comped, beta, affiliate or operator
// accounts, and only accounts that signed up after counting began (an older
// account's first week was never recorded, so it would look like a drop-off
// that did not happen).
export async function firstWeekReport({ days = 30 } = {}) {
  const win = WINDOWS.includes(Number(days)) ? Number(days) : 30;
  const started = (await sql`SELECT MIN(first_at) AS at FROM screen_visits`).rows[0]?.at || null;
  if (!started) return { days: win, countingSince: null, cohort: 0, screens: [], daysActive: null, wentQuiet: { accounts: 0, lastScreens: [] } };

  const cohortSql = `
    SELECT u.id, u.created_at
      FROM users u JOIN workspaces w ON w.owner_id = u.id
     WHERE u.deleted_at IS NULL
       AND u.user_type = 'regular' AND u.is_tester = FALSE
       AND u.created_at >= $1::timestamptz
       AND u.created_at >= NOW() - ($2 || ' days')::interval`;
  const args = [started, String(win)];

  const [cohortQ, screensQ, activeQ, quietQ] = await Promise.all([
    sql.query(`SELECT COUNT(*)::int AS n FROM (${cohortSql}) c`, args),
    sql.query(
      `SELECT v.screen, COUNT(DISTINCT c.id)::int AS accounts
         FROM (${cohortSql}) c
         JOIN screen_visits v ON v.user_id = c.id
          AND v.first_at < c.created_at + INTERVAL '${FIRST_WEEK_DAYS} days'
        GROUP BY v.screen`, args),
    // Different days each account opened the app in its first week.
    sql.query(
      `SELECT COALESCE(d.n, 0)::int AS active_days, COUNT(*)::int AS accounts
         FROM (${cohortSql}) c
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT v.day) AS n FROM screen_visits v
            WHERE v.user_id = c.id AND v.first_at < c.created_at + INTERVAL '${FIRST_WEEK_DAYS} days'
         ) d ON TRUE
        GROUP BY 1`, args),
    // Accounts old enough to judge that have not opened anything for a
    // week, and the last screen each one saw.
    sql.query(
      `SELECT l.screen, COUNT(*)::int AS accounts
         FROM (${cohortSql}) c
         JOIN LATERAL (
           SELECT v.screen, v.last_at FROM screen_visits v
            WHERE v.user_id = c.id ORDER BY v.last_at DESC LIMIT 1
         ) l ON TRUE
        WHERE c.created_at < NOW() - INTERVAL '${QUIET_AFTER_DAYS} days'
          AND l.last_at < NOW() - INTERVAL '${QUIET_AFTER_DAYS} days'
        GROUP BY l.screen`, args),
  ]);

  const cohort = cohortQ.rows[0]?.n || 0;
  const pct = (n) => (cohort ? Math.round((n / cohort) * 100) : 0);
  const label = (s) => SCREENS[s] || s;
  const screens = screensQ.rows
    .map((r) => ({ screen: r.screen, label: label(r.screen), accounts: r.accounts, pct: pct(r.accounts) }))
    .sort((a, b) => b.accounts - a.accounts || a.label.localeCompare(b.label));
  const byDays = Object.fromEntries(activeQ.rows.map((r) => [r.active_days, r.accounts]));
  const sum = (from, to) => Object.entries(byDays).reduce((s, [k, v]) => (Number(k) >= from && Number(k) <= to ? s + v : s), 0);
  const lastScreens = quietQ.rows
    .map((r) => ({ screen: r.screen, label: label(r.screen), accounts: r.accounts }))
    .sort((a, b) => b.accounts - a.accounts || a.label.localeCompare(b.label));
  return {
    days: win,
    countingSince: started,
    cohort,
    screens,
    daysActive: { never: sum(0, 0), oneDay: sum(1, 1), twoToThree: sum(2, 3), fourOrMore: sum(4, 99) },
    wentQuiet: { accounts: lastScreens.reduce((s, r) => s + r.accounts, 0), lastScreens },
  };
}

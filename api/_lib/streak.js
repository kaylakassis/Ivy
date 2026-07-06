// Daily-return streak (habit loop). touchStreak advances the owner's
// consecutive-active-days count and is called once per daily dashboard load.
// The day boundary is the WORKSPACE timezone (so "a new day" matches what the
// owner sees), and it's idempotent within a day — loading the dashboard twice
// the same day doesn't double-count. Streak state lives on the workspace.
import { sql } from './db.js';
import { workspaceTimeZone } from './calendar.js';

const MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365];

function toISO(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// Read the streak counters WITHOUT advancing them — for surfaces that only
// display the streak (Ivy's briefing/chat context) and must never mutate it.
// (touchStreak does the day-boundary UPDATE, so calling it for a mere read would
// corrupt the habit loop.) Best-effort → zeros on any error.
export async function readStreak(workspaceId) {
  if (!workspaceId) return { days: 0, best: 0 };
  try {
    const { rows } = await sql`
      SELECT streak_days, streak_best FROM workspaces WHERE id = ${workspaceId}`;
    const r = rows[0] || {};
    return { days: Number(r.streak_days || 0), best: Number(r.streak_best || 0) };
  } catch {
    return { days: 0, best: 0 };
  }
}

// Returns { days, best, isNewDay, milestone } — milestone is the threshold just
// crossed today (for a one-time celebration) or null; best is the longest streak
// ever reached (a "beat your record" hook once a streak breaks).
export async function touchStreak(workspaceId) {
  if (!workspaceId) return { days: 0, best: 0, isNewDay: false, milestone: null };
  try {
    const tz = await workspaceTimeZone(workspaceId);
    const { rows } = await sql`
      SELECT streak_days, streak_last_day, streak_best, (NOW() AT TIME ZONE ${tz})::date AS today
        FROM workspaces WHERE id = ${workspaceId}`;
    const r = rows[0];
    if (!r) return { days: 0, best: 0, isNewDay: false, milestone: null };
    const bestSoFar = Number(r.streak_best || 0);
    const today = toISO(r.today);
    const last = toISO(r.streak_last_day);
    if (last === today) {
      return { days: r.streak_days || 0, best: Math.max(bestSoFar, r.streak_days || 0), isNewDay: false, milestone: null };
    }
    // First active day of a new calendar day: extend if yesterday, else reset.
    let days;
    if (last) {
      const gapDays = Math.round((Date.parse(today) - Date.parse(last)) / 86400000);
      days = gapDays === 1 ? (Number(r.streak_days || 0) + 1) : 1;
    } else {
      days = 1;
    }
    const best = Math.max(bestSoFar, days);
    await sql`UPDATE workspaces
                SET streak_days = ${days}, streak_last_day = ${today}::date, streak_best = ${best}
              WHERE id = ${workspaceId}`;
    return { days, best, isNewDay: true, milestone: MILESTONES.includes(days) ? days : null };
  } catch {
    // A streak hiccup must never break the dashboard load.
    return { days: 0, best: 0, isNewDay: false, milestone: null };
  }
}

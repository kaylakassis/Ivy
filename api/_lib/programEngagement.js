// Programs: points, leaderboard, streaks and badges.
//
// Points are COMPUTED from the activity rows that already exist, never
// stored a second time, so they cannot drift or double count:
//   lesson completed           10   program_progress (one row per lesson)
//   post started                3   program_posts, top level, in the feed
//   reply / lesson comment      1   program_posts with a parent or a lesson
//   reaction received           1   program_post_reactions on the member's
//                                   posts from someone else, at most 20 a day
//   live session attended       5   RSVP 'going' to a session that has ended
//   check-in submitted          5   program_checkin_responses
//   module finished            25   every live lesson in the module done
//   program finished          100   every live lesson in the program done
// Only members earn points (the owner's posts carry no client id). Days,
// weeks and months are the business's own (calendar_settings.timezone).
//
// Badges are the one thing kept: once earned they stay (program_badges,
// unique per member and badge), and seen_at lets the app celebrate each
// exactly once.
import { sql } from './db.js';
import { zonedTimeToUtcMs } from './tz.js';
import { workspaceTimezone } from './programCommerce.js';
import { activeMembers, profilesFor } from './programCommunity.js';

export const POINTS = { lesson: 10, post: 3, reply: 1, reaction: 1, event: 5, checkin: 5, module: 25, program: 100 };
export const REACTION_DAILY_CAP = 20;
export const LEADERBOARD_SIZE = 20;
export const PERIODS = ['week', 'month', 'all'];

export const BADGES = {
  complete_25: { label: '25% complete', emoji: '🌱' },
  complete_50: { label: 'Halfway there', emoji: '🌿' },
  complete_75: { label: '75% complete', emoji: '🌳' },
  complete_100: { label: 'Finished the program', emoji: '🏁' },
  first_post: { label: 'First post', emoji: '💬' },
  streak_7: { label: '7-day streak', emoji: '🔥' },
  streak_30: { label: '30-day streak', emoji: '⭐' },
};
export const BADGE_ORDER = Object.keys(BADGES);
export const serializeBadge = (b) => ({ badge: b.badge, ...(BADGES[b.badge] || { label: b.badge, emoji: '🏅' }), earnedAt: b.earned_at, seen: !!b.seen_at });

// ── local days ──────────────────────────────────────────────────────
const fmtCache = new Map();
export function localDay(tz, at) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); fmtCache.set(tz, f); }
  return f.format(at instanceof Date ? at : new Date(at));
}
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
// Monday that starts the week holding `iso`.
export const weekStart = (iso) => addDays(iso, -((weekdayOf(iso) + 6) % 7));

// First instant of the period in the business's timezone (null = all time).
export function periodStart(period, tz, now = new Date()) {
  if (period === 'all') return null;
  const today = localDay(tz, now);
  const startIso = period === 'month' ? `${today.slice(0, 8)}01` : weekStart(today);
  return new Date(zonedTimeToUtcMs(startIso, 0, tz));
}

// ── activity ────────────────────────────────────────────────────────
// Everything that earns points in a program (optionally for one member):
// [{ clientId, kind, points, at }]. Module / program completion is derived
// from the lesson rows.
export async function pointEvents({ program, clientId = null, tz, now = new Date() }) {
  const pid = program.id;
  const one = clientId || null;
  const [lessons, live, mods, posts, reactions, events, checkins] = await Promise.all([
    sql`SELECT pp.client_id, pp.item_id, pp.completed_at FROM program_progress pp
          JOIN program_items i ON i.id = pp.item_id AND i.deleted_at IS NULL
         WHERE pp.program_id = ${pid} AND (${one}::uuid IS NULL OR pp.client_id = ${one}::uuid)`,
    sql`SELECT id, module_id FROM program_items WHERE program_id = ${pid} AND deleted_at IS NULL`,
    sql`SELECT id FROM program_modules WHERE program_id = ${pid} AND deleted_at IS NULL`,
    sql`SELECT author_client_id AS client_id, parent_id, item_id, created_at FROM program_posts
         WHERE program_id = ${pid} AND deleted_at IS NULL AND NOT is_owner AND author_client_id IS NOT NULL
           AND (${one}::uuid IS NULL OR author_client_id = ${one}::uuid)`,
    sql`SELECT p.author_client_id AS client_id, r.created_at FROM program_post_reactions r
          JOIN program_posts p ON p.id = r.post_id AND p.deleted_at IS NULL AND NOT p.is_owner AND p.author_client_id IS NOT NULL
         WHERE r.program_id = ${pid} AND (p.author_user_id IS NULL OR r.user_id <> p.author_user_id)
           AND (${one}::uuid IS NULL OR p.author_client_id = ${one}::uuid)`,
    sql`SELECT r.client_id, e.starts_at + make_interval(mins => e.duration_min) AS ended_at FROM program_event_rsvps r
          JOIN program_events e ON e.id = r.event_id AND e.program_id = r.program_id AND e.cancelled_at IS NULL
         WHERE r.program_id = ${pid} AND r.status = 'going'
           AND e.starts_at + make_interval(mins => e.duration_min) <= ${now.toISOString()}
           AND (${one}::uuid IS NULL OR r.client_id = ${one}::uuid)`,
    sql`SELECT client_id, submitted_at FROM program_checkin_responses
         WHERE program_id = ${pid} AND (${one}::uuid IS NULL OR client_id = ${one}::uuid)`,
  ]);
  const out = [];
  for (const r of lessons.rows) out.push({ clientId: r.client_id, kind: 'lesson', points: POINTS.lesson, at: new Date(r.completed_at) });
  for (const r of posts.rows) {
    const reply = !!r.parent_id || !!r.item_id;
    out.push({ clientId: r.client_id, kind: reply ? 'reply' : 'post', points: reply ? POINTS.reply : POINTS.post, at: new Date(r.created_at) });
  }
  // Reactions received: capped per member per local day.
  const perDay = new Map();
  for (const r of reactions.rows) {
    const at = new Date(r.created_at);
    const k = `${r.client_id}|${localDay(tz, at)}`;
    const cur = perDay.get(k) || { clientId: r.client_id, n: 0, at };
    cur.n += 1; if (at < cur.at) cur.at = at;
    perDay.set(k, cur);
  }
  for (const d of perDay.values()) out.push({ clientId: d.clientId, kind: 'reaction', points: Math.min(d.n, REACTION_DAILY_CAP) * POINTS.reaction, at: d.at });
  for (const r of events.rows) out.push({ clientId: r.client_id, kind: 'event', points: POINTS.event, at: new Date(r.ended_at) });
  for (const r of checkins.rows) out.push({ clientId: r.client_id, kind: 'checkin', points: POINTS.checkin, at: new Date(r.submitted_at) });

  // Finished modules and the whole program, from the lesson rows.
  const liveMods = new Set(mods.rows.map((m) => m.id));
  const byModule = new Map();
  for (const i of live.rows) {
    if (i.module_id && liveMods.has(i.module_id)) { if (!byModule.has(i.module_id)) byModule.set(i.module_id, []); byModule.get(i.module_id).push(i.id); }
  }
  const doneBy = new Map();
  for (const r of lessons.rows) {
    if (!doneBy.has(r.client_id)) doneBy.set(r.client_id, new Map());
    doneBy.get(r.client_id).set(r.item_id, new Date(r.completed_at));
  }
  for (const [cid, done] of doneBy) {
    for (const ids of byModule.values()) {
      if (ids.length && ids.every((id) => done.has(id))) out.push({ clientId: cid, kind: 'module', points: POINTS.module, at: new Date(Math.max(...ids.map((id) => done.get(id).getTime()))) });
    }
    const all = live.rows.map((i) => i.id);
    if (all.length && all.every((id) => done.has(id))) out.push({ clientId: cid, kind: 'program', points: POINTS.program, at: new Date(Math.max(...all.map((id) => done.get(id).getTime()))) });
  }
  return out;
}

export function sumPoints(events, since = null) {
  const totals = new Map();
  for (const e of events) {
    if (since && e.at.getTime() < since.getTime()) continue;
    totals.set(e.clientId, (totals.get(e.clientId) || 0) + e.points);
  }
  return totals;
}

// ── streaks ─────────────────────────────────────────────────────────
// A day counts when the member finished a lesson, posted or replied
// (lesson comments too) or submitted a check-in in this program.
export async function activityDays({ programId, clientId, tz }) {
  const r = await sql`
    SELECT completed_at AS at FROM program_progress WHERE program_id = ${programId} AND client_id = ${clientId}
    UNION ALL
    SELECT created_at FROM program_posts WHERE program_id = ${programId} AND author_client_id = ${clientId} AND NOT is_owner AND deleted_at IS NULL
    UNION ALL
    SELECT submitted_at FROM program_checkin_responses WHERE program_id = ${programId} AND client_id = ${clientId}`;
  return new Set(r.rows.map((x) => localDay(tz, new Date(x.at))));
}

// { current, best, activeNow } in days ('daily') or weeks ('weekly'). The
// current streak survives until the end of the day (week) after the last
// active one, so it does not read 0 every morning before the member acts.
export function computeStreak(days, mode = 'daily', today) {
  const step = mode === 'weekly' ? 7 : 1;
  const units = new Set(mode === 'weekly' ? [...days].map(weekStart) : [...days]);
  const sorted = [...units].sort();
  let best = 0; let run = 0; let prev = null;
  for (const u of sorted) {
    run = prev && addDays(prev, step) === u ? run + 1 : 1;
    if (run > best) best = run;
    prev = u;
  }
  const nowUnit = mode === 'weekly' ? weekStart(today) : today;
  let cursor = units.has(nowUnit) ? nowUnit : addDays(nowUnit, -step);
  let current = 0;
  while (units.has(cursor)) { current++; cursor = addDays(cursor, -step); }
  return { current, best, activeNow: units.has(nowUnit), unit: mode === 'weekly' ? 'week' : 'day' };
}

// ── badges ──────────────────────────────────────────────────────────
// Awards what the member has earned and returns the newly earned ones.
export async function awardBadges({ program, clientId, tz, now = new Date(), days = null }) {
  if (!clientId) return [];
  const prog = (await sql`
    SELECT (SELECT COUNT(*)::int FROM program_items WHERE program_id = ${program.id} AND deleted_at IS NULL) AS total,
           (SELECT COUNT(*)::int FROM program_progress pp JOIN program_items i ON i.id = pp.item_id AND i.deleted_at IS NULL
             WHERE pp.program_id = ${program.id} AND pp.client_id = ${clientId}) AS done,
           EXISTS (SELECT 1 FROM program_posts WHERE program_id = ${program.id} AND author_client_id = ${clientId} AND NOT is_owner AND deleted_at IS NULL) AS posted`).rows[0];
  const want = [];
  const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
  for (const t of [25, 50, 75, 100]) if (prog.total && pct >= t) want.push(`complete_${t}`);
  if (prog.posted) want.push('first_post');
  const daySet = days || await activityDays({ programId: program.id, clientId, tz });
  const best = computeStreak(daySet, 'daily', localDay(tz, now)).best;
  if (best >= 7) want.push('streak_7');
  if (best >= 30) want.push('streak_30');
  if (!want.length) return [];
  const r = await sql.query(
    `INSERT INTO program_badges (workspace_id, program_id, client_id, badge)
     SELECT $1, $2, $3, b FROM unnest($4::text[]) AS b
     ON CONFLICT (program_id, client_id, badge) DO NOTHING RETURNING badge, earned_at, seen_at`,
    [program.workspace_id, program.id, clientId, want],
  );
  return r.rows.map(serializeBadge);
}

export async function badgesFor(programId, clientIds) {
  if (!clientIds.length) return new Map();
  const r = await sql.query(`SELECT client_id, badge, earned_at, seen_at FROM program_badges WHERE program_id = $1 AND client_id = ANY($2::uuid[]) ORDER BY earned_at ASC`, [programId, clientIds]);
  const map = new Map();
  for (const b of r.rows) { if (!map.has(b.client_id)) map.set(b.client_id, []); map.get(b.client_id).push(serializeBadge(b)); }
  return map;
}

// A member's own summary: points by period, streak, badges (awarding any
// newly earned ones first).
export async function memberSummary({ program, clientId, now = new Date() }) {
  const tz = await workspaceTimezone(program.workspace_id);
  const days = await activityDays({ programId: program.id, clientId, tz });
  await awardBadges({ program, clientId, tz, now, days });
  const events = await pointEvents({ program, clientId, tz, now });
  const points = {};
  for (const p of PERIODS) points[p] = sumPoints(events, periodStart(p, tz, now)).get(clientId) || 0;
  const streak = computeStreak(days, program.streak_mode === 'weekly' ? 'weekly' : 'daily', localDay(tz, now));
  const badges = (await badgesFor(program.id, [clientId])).get(clientId) || [];
  return { points, streak, badges, timezone: tz };
}

// ── leaderboard ─────────────────────────────────────────────────────
// Top 20 members by points for the period plus the viewer's own place.
// Members who hid themselves still earn points but are not listed (and do
// not take a place from anyone); a hidden viewer still sees where they
// would stand. Names and photos only: never an email or a phone number.
export async function leaderboard({ program, period = 'week', viewerClientId = null, now = new Date() }) {
  const p = PERIODS.includes(period) ? period : 'week';
  const tz = await workspaceTimezone(program.workspace_id);
  const events = await pointEvents({ program, tz, now });
  const totals = sumPoints(events, periodStart(p, tz, now));
  const members = (await activeMembers(program.id)).filter((m) => m.user_id);
  const profs = await profilesFor(program.workspace_id, members.map((m) => m.user_id));
  const rows = members.map((m) => {
    const prof = profs.get(m.user_id);
    return {
      clientId: m.client_id, name: prof?.display_name || m.name || 'Member',
      avatarUrl: prof?.avatar_url || (/^https:\/\//i.test(m.photo_url || '') ? m.photo_url : null),
      points: totals.get(m.client_id) || 0, hidden: !!prof?.hide_from_leaderboard,
    };
  });
  const byPoints = (a, b) => b.points - a.points || a.name.localeCompare(b.name);
  const visible = rows.filter((r) => !r.hidden && r.points > 0).sort(byPoints);
  // Standard competition ranking: equal points share a place.
  let rank = 0; let last = null;
  visible.forEach((r, i) => { if (r.points !== last) { rank = i + 1; last = r.points; } r.rank = rank; });
  const badgeMap = await badgesFor(program.id, visible.slice(0, LEADERBOARD_SIZE).map((r) => r.clientId));
  const top = visible.slice(0, LEADERBOARD_SIZE).map((r) => ({
    rank: r.rank, key: r.clientId, name: r.name, avatarUrl: r.avatarUrl, points: r.points,
    isMe: r.clientId === viewerClientId, badges: (badgeMap.get(r.clientId) || []).map((b) => b.badge),
  }));
  let me = null;
  if (viewerClientId) {
    const mine = rows.find((r) => r.clientId === viewerClientId);
    if (mine) {
      const ahead = visible.filter((r) => r.clientId !== viewerClientId && r.points > mine.points).length;
      me = { points: mine.points, rank: mine.points > 0 ? ahead + 1 : null, hidden: mine.hidden, listed: !mine.hidden && mine.points > 0 };
    }
  }
  return { period: p, timezone: tz, rows: top, me, totalRanked: visible.length };
}

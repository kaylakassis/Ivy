// Programs phase 3: points, leaderboard, streaks, badges, check-ins and
// cohorts, through the real handlers against local Postgres. Resend is
// mocked by replacing globalThis.fetch.
//
//   [1] defaults: leaderboard on for new programs (off for existing ones)
//   [2] points math + idempotency (lessons, posts, replies, reactions with
//       the daily cap, live sessions, check-ins, module / program finished;
//       the owner earns nothing)
//   [3] leaderboard periods (week / month / all), privacy toggles, access
//   [4] streaks: day boundaries in a non-UTC timezone, weekly mode
//   [5] badges awarded once, celebrated once, shown in the directory
//   [6] check-ins: builder validation, one submission per period, edits,
//       privacy (other members / outsiders), owner inbox, reply, trend,
//       reminder cron dedupe
//   [7] cohorts: drip anchor, before-start content, capacity, close date,
//       moving members, lesson comments follow the cohort anchor
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/programs-engagement.test.mjs
process.env.SECRETS_KEY = process.env.SECRETS_KEY || 'a'.repeat(64);
process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron_engagement_secret';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { SCHEMA_SQL } from '../api/_lib/schema.js';
import programsIndex from '../api/programs/index.js';
import programById from '../api/programs/[id].js';
import programItems from '../api/programs/[id]/items.js';
import programModules from '../api/programs/[id]/modules.js';
import programMembers from '../api/programs/[id]/members.js';
import programPosts from '../api/programs/[id]/posts.js';
import programReactions from '../api/programs/[id]/reactions.js';
import programDirectory from '../api/programs/[id]/directory.js';
import engagement from '../api/programs/[id]/engagement.js';
import checkins from '../api/programs/[id]/checkins.js';
import cohorts from '../api/programs/[id]/cohorts.js';
import meProgram from '../api/me/programs/[id].js';
import meProgress from '../api/me/programs/[id]/progress.js';
import checkinCron from '../api/cron/program-checkins.js';
import { pointEvents, sumPoints, computeStreak, localDay, periodStart, memberSummary, awardBadges, weekStart, POINTS } from '../api/_lib/programEngagement.js';
import { currentPeriod } from '../api/_lib/programCheckins.js';
import { runCheckinReminders } from '../api/_lib/programCheckinNotify.js';
import { dripAnchorFor, courseGateFor, lessonUnlocksAt } from '../api/_lib/programCourse.js';
import { openCohorts, pickCohort } from '../api/_lib/programCommerce.js';
import { zonedTimeToUtcMs } from '../api/_lib/tz.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
globalThis.fetch = async (url, init = {}) => {
  if (/api\.resend\.com/.test(String(url))) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return new Response(JSON.stringify({ id: `em_${emails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mailsTo = (addr, re = /./) => emails.filter((e) => [].concat(e.to || []).some((t) => String(t).toLowerCase().includes(addr.toLowerCase())) && re.test(e.subject || ''));

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
const HOST = 'www.joinivy.ai';
const IPB = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
function req({ method = 'GET', cookie, query = {}, body, headers = {} } = {}) {
  return { method, url: '/t', query, body,
    headers: { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': `${IPB}.9`, 'user-agent': 'test', ...(cookie ? { cookie } : {}), ...headers } };
}
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;

const STAMP = Date.now();
const T = `pg${STAMP}`;
const users = [];
const TZ = 'America/Los_Angeles';
async function mkOwner(label, tz = TZ) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`${T}-${label}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${wid}, ${`${label} Studio`}, ${`${T}-${label}`}, ${tz})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}, timezone = ${tz}`;
  users.push(u);
  return { uid: u, wid, cookie: cookieFor(u) };
}
async function mkClientUser(label, wid) {
  const email = `${T}-${label}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const cid = (await sql`INSERT INTO clients (workspace_id, user_id, name, email, stage) VALUES (${wid}, ${u}, ${label}, ${email}, 'active') RETURNING id`).rows[0].id;
  users.push(u);
  return { uid: u, cid, email, cookie: cookieFor(u) };
}
const blob = (wid, name) => `https://abc123store.public.blob.vercel-storage.com/ws/${wid}/programs/${name}`;
const hasEmail = (o) => /@example\.com/.test(JSON.stringify(o));

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const B = await mkOwner('beta', 'UTC');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] defaults');
  let r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: `Engage ${T}`, priceCents: 0 } }));
  const P = r.body.program;
  assert(r.statusCode === 201 && P.leaderboardEnabled === true && P.streakMode === 'daily' && P.delivery === 'evergreen', 'a new program has the leaderboard on, daily streaks, evergreen');
  const addCol = SCHEMA_SQL.indexOf('ADD COLUMN IF NOT EXISTS leaderboard_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  const flip = SCHEMA_SQL.indexOf('ALTER COLUMN leaderboard_enabled SET DEFAULT TRUE');
  assert(addCol > 0 && flip > addCol, 'existing programs get the leaderboard OFF (added with FALSE, default flipped to TRUE after)');
  const col = (await sql`SELECT column_default FROM information_schema.columns WHERE table_name = 'programs' AND column_name = 'leaderboard_enabled'`).rows[0];
  assert(/true/i.test(col?.column_default || ''), 'column default is TRUE for new rows');
  await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { status: 'published' } }));

  // Course: module M1 (2 lessons), module M2 (1 lesson), 1 top-level lesson.
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Part 1' } }));
  const M1 = r.body.module;
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Part 2' } }));
  const M2 = r.body.module;
  const lesson = async (title, moduleId) => (await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { type: 'post', title, body: `${title} body`, moduleId, notify: false } }))).body.item;
  const L1 = await lesson('L1', M1.id); const L2 = await lesson('L2', M1.id); const L3 = await lesson('L3', M2.id); const L0 = await lesson('Welcome', null);

  const m1 = await mkClientUser('mia', A.wid);
  const m2 = await mkClientUser('noah', A.wid);
  const m3 = await mkClientUser('ola', A.wid);
  const outsider = await mkClientUser('pat', A.wid);
  for (const m of [m1, m2, m3]) {
    r = await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { clientId: m.cid } }));
  }
  assert(r.statusCode === 201, 'members added');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] points math + idempotency');
  const done = (m, itemId) => call(meProgress, req({ method: 'POST', cookie: m.cookie, query: { id: P.id }, body: { itemId, done: true } }));
  await done(m1, L1.id);
  r = await done(m1, L1.id);
  assert(r.statusCode === 200, 'marking the same lesson twice is fine');
  const prog = (await sql`SELECT * FROM programs WHERE id = ${P.id}`).rows[0];
  let ev = await pointEvents({ program: prog, tz: TZ });
  assert(sumPoints(ev).get(m1.cid) === POINTS.lesson, `one lesson = 10 points, once (${sumPoints(ev).get(m1.cid)})`);
  await done(m1, L2.id);
  ev = await pointEvents({ program: prog, tz: TZ });
  assert(sumPoints(ev).get(m1.cid) === 2 * POINTS.lesson + POINTS.module, `finishing Part 1 adds the module bonus (${sumPoints(ev).get(m1.cid)})`);
  r = await call(programPosts, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { kind: 'post', body: 'Hello group' } }));
  const post1 = r.body.post;
  await call(programPosts, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { kind: 'post', body: 'Replying to myself', parentId: post1.id } }));
  await call(programPosts, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { kind: 'post', body: 'Nice lesson', itemId: L1.id } }));
  await call(programPosts, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { kind: 'post', body: 'Coach post' } }));
  // Self reaction earns nothing; reactions from others count, capped at 20 a day.
  await call(programReactions, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { postId: post1.id, emoji: 'heart' } }));
  const reactors = [m2, m3, { cookie: A.cookie }];
  for (const who of reactors) for (const emoji of ['heart', 'clap', 'fire', 'laugh', '100']) {
    await call(programReactions, req({ method: 'POST', cookie: who.cookie, query: { id: P.id }, body: { postId: post1.id, emoji } }));
  }
  // Two more people (not members, inserted directly) push the day past 20.
  for (const label of ['extra1', 'extra2']) {
    const x = await mkClientUser(label, A.wid);
    for (const emoji of ['heart', 'clap', 'fire']) {
      await sql`INSERT INTO program_post_reactions (post_id, program_id, workspace_id, user_id, emoji) VALUES (${post1.id}, ${P.id}, ${A.wid}, ${x.uid}, ${emoji})`;
    }
  }
  const reactCount = (await sql`SELECT COUNT(*)::int AS n FROM program_post_reactions WHERE post_id = ${post1.id} AND user_id <> ${m1.uid}`).rows[0].n;
  ev = await pointEvents({ program: prog, tz: TZ });
  const react = ev.filter((e) => e.clientId === m1.cid && e.kind === 'reaction').reduce((a, e) => a + e.points, 0);
  assert(reactCount === 21 && react === 20, `21 reactions from others in one day → capped at 20 points (${react})`);
  // Live session: RSVP going + ended = 5; future session or not going = 0.
  const evPast = (await sql`INSERT INTO program_events (program_id, workspace_id, title, starts_at, duration_min) VALUES (${P.id}, ${A.wid}, 'Past call', NOW() - INTERVAL '3 hours', 60) RETURNING id`).rows[0].id;
  const evFuture = (await sql`INSERT INTO program_events (program_id, workspace_id, title, starts_at, duration_min) VALUES (${P.id}, ${A.wid}, 'Next call', NOW() + INTERVAL '2 days', 60) RETURNING id`).rows[0].id;
  const evPast2 = (await sql`INSERT INTO program_events (program_id, workspace_id, title, starts_at, duration_min) VALUES (${P.id}, ${A.wid}, 'Old call', NOW() - INTERVAL '5 hours', 30) RETURNING id`).rows[0].id;
  await sql`INSERT INTO program_event_rsvps (event_id, program_id, workspace_id, client_id, status) VALUES (${evPast}, ${P.id}, ${A.wid}, ${m1.cid}, 'going'), (${evFuture}, ${P.id}, ${A.wid}, ${m1.cid}, 'going'), (${evPast2}, ${P.id}, ${A.wid}, ${m1.cid}, 'not_going')`;
  ev = await pointEvents({ program: prog, tz: TZ });
  const m1Events = ev.filter((e) => e.clientId === m1.cid && e.kind === 'event');
  assert(m1Events.length === 1 && m1Events[0].points === 5, 'only the ended session they said yes to earns 5');
  const expectedM1 = 2 * 10 + 25 + 3 + 1 + 1 + 20 + 5;
  assert(sumPoints(ev).get(m1.cid) === expectedM1, `member total ${sumPoints(ev).get(m1.cid)} = ${expectedM1}`);
  assert(!ev.some((e) => e.clientId == null), 'the owner earns no points');
  // Finish everything → module 2 + program bonus.
  await done(m1, L3.id); await done(m1, L0.id);
  ev = await pointEvents({ program: prog, tz: TZ });
  assert(sumPoints(ev).get(m1.cid) === expectedM1 + 20 + 25 + 100, `whole program done adds Part 2 and the program bonus (${sumPoints(ev).get(m1.cid)})`);
  // Undo a lesson: the completion bonuses go with it (computed, not stored).
  await call(meProgress, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { itemId: L0.id, done: false } }));
  ev = await pointEvents({ program: prog, tz: TZ });
  assert(sumPoints(ev).get(m1.cid) === expectedM1 + 10 + 25, 'undoing a lesson removes its points and the program bonus');
  await done(m1, L0.id);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] leaderboard periods, privacy, access');
  // m2: a lesson now. m3: two lessons 40 days ago (all time only).
  await done(m2, L1.id);
  await sql`INSERT INTO program_progress (workspace_id, program_id, client_id, item_id, completed_at) VALUES
            (${A.wid}, ${P.id}, ${m3.cid}, ${L1.id}, NOW() - INTERVAL '40 days'), (${A.wid}, ${P.id}, ${m3.cid}, ${L2.id}, NOW() - INTERVAL '40 days')`;
  r = await call(engagement, req({ cookie: m2.cookie, query: { id: P.id, view: 'leaderboard', period: 'week' } }));
  assert(r.statusCode === 200 && r.body.enabled && r.body.rows[0]?.key === m1.cid && r.body.rows[0].rank === 1, 'week: the most active member is first');
  assert(!r.body.rows.some((x) => x.key === m3.cid), 'week: activity from 40 days ago does not count');
  assert(r.body.me?.rank === 2 && r.body.me.points === 10 && r.body.rows.find((x) => x.isMe)?.key === m2.cid, 'my rank and points');
  assert(!hasEmail(r.body), 'no email addresses in the leaderboard');
  r = await call(engagement, req({ cookie: m2.cookie, query: { id: P.id, view: 'leaderboard', period: 'all' } }));
  const m3row = r.body.rows.find((x) => x.key === m3.cid);
  assert(m3row?.points === 45, `all time counts old activity (${m3row?.points})`);
  const tz = TZ; const now = new Date();
  const mStart = periodStart('month', tz, now); const wStart = periodStart('week', tz, now);
  assert(localDay(tz, mStart).endsWith('-01') && localDay(tz, wStart) === weekStart(localDay(tz, now)) && new Date(wStart).getTime() <= now.getTime(), 'month starts on the 1st and week on Monday, local time');
  // Hide m2: still earns, not listed, nobody shifts up past a hidden member.
  r = await call(engagement, req({ method: 'PATCH', cookie: m2.cookie, query: { id: P.id }, body: { hideFromLeaderboard: true } }));
  assert(r.statusCode === 200 && r.body.hideFromLeaderboard === true, 'member hides from the leaderboard');
  r = await call(engagement, req({ cookie: m2.cookie, query: { id: P.id, view: 'leaderboard', period: 'all' } }));
  assert(!r.body.rows.some((x) => x.key === m2.cid) && r.body.me.hidden === true && r.body.me.points === 10 && r.body.me.rank === 3, 'hidden: not listed, still has points and sees where they would stand');
  r = await call(engagement, req({ cookie: m2.cookie, query: { id: P.id } }));
  assert(r.body.points.all === 10 && r.body.hideFromLeaderboard === true, 'hidden member still earns points');
  r = await call(engagement, req({ method: 'PATCH', cookie: m2.cookie, query: { id: P.id }, body: { leaderboardEnabled: false } }));
  assert(r.statusCode === 403, 'a member cannot switch the leaderboard off');
  r = await call(engagement, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { leaderboardEnabled: false } }));
  assert(r.statusCode === 200 && r.body.leaderboardEnabled === false, 'owner switches the leaderboard off');
  r = await call(engagement, req({ cookie: m1.cookie, query: { id: P.id, view: 'leaderboard' } }));
  assert(r.statusCode === 200 && r.body.enabled === false && r.body.rows.length === 0, 'off: members get nothing');
  r = await call(engagement, req({ cookie: A.cookie, query: { id: P.id, view: 'leaderboard' } }));
  assert(r.statusCode === 200 && r.body.enabled === false && r.body.rows.length > 0, 'off: the owner can still preview it');
  await call(engagement, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { leaderboardEnabled: true } }));
  r = await call(engagement, req({ cookie: outsider.cookie, query: { id: P.id, view: 'leaderboard' } }));
  assert(r.statusCode === 404, 'a client who is not a member → 404');
  r = await call(engagement, req({ cookie: B.cookie, query: { id: P.id, view: 'leaderboard' } }));
  assert(r.statusCode === 404, 'another business → 404');
  r = await call(engagement, req({ query: { id: P.id, view: 'leaderboard' } }));
  assert(r.statusCode === 401, 'signed out → 401');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] streaks in a non-UTC timezone');
  // now = Oct 31 12:00 in Los Angeles. Activity at 01:00 Oct 31, 23:00 Oct 30
  // and 13:00 Oct 29 LA. In UTC the first two are both Oct 31.
  const fixedNow = new Date('2026-10-31T19:00:00Z');
  const s4 = await mkClientUser('sam', A.wid);
  await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { clientId: s4.cid } }));
  await sql`INSERT INTO program_progress (workspace_id, program_id, client_id, item_id, completed_at) VALUES
    (${A.wid}, ${P.id}, ${s4.cid}, ${L1.id}, '2026-10-31T08:00:00Z'), (${A.wid}, ${P.id}, ${s4.cid}, ${L2.id}, '2026-10-31T06:00:00Z'),
    (${A.wid}, ${P.id}, ${s4.cid}, ${L3.id}, '2026-10-29T20:00:00Z')`;
  let sum = await memberSummary({ program: prog, clientId: s4.cid, now: fixedNow });
  assert(sum.streak.current === 3 && sum.streak.best === 3 && sum.streak.activeNow, `local days make a 3-day streak (${sum.streak.current})`);
  const utcDays = new Set(['2026-10-31T08:00:00Z', '2026-10-31T06:00:00Z', '2026-10-29T20:00:00Z'].map((x) => localDay('UTC', new Date(x))));
  assert(computeStreak(utcDays, 'daily', '2026-10-31').current === 1, 'the same activity read in UTC would only be 1 day');
  sum = await memberSummary({ program: prog, clientId: s4.cid, now: new Date('2026-11-01T19:00:00Z') });
  assert(sum.streak.current === 3 && !sum.streak.activeNow, 'the streak survives the next day until it ends');
  sum = await memberSummary({ program: prog, clientId: s4.cid, now: new Date('2026-11-02T19:00:00Z') });
  assert(sum.streak.current === 0 && sum.streak.best === 3, 'a missed day ends it; the best is kept');
  const weekly = computeStreak(new Set(['2026-10-13', '2026-10-21', '2026-10-27', '2026-10-31']), 'weekly', '2026-10-31');
  assert(weekly.current === 3 && weekly.unit === 'week', `weekly mode counts weeks (${weekly.current})`);
  assert(computeStreak(new Set(['2026-10-13', '2026-10-27']), 'weekly', '2026-10-31').current === 1, 'a skipped week breaks a weekly streak');
  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { streakMode: 'weekly' } }));
  assert(r.statusCode === 200 && r.body.program.streakMode === 'weekly', 'owner switches to weekly streaks');
  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { streakMode: 'hourly' } }));
  assert(r.statusCode === 400, 'unknown streak mode → 400');
  r = await call(engagement, req({ cookie: m1.cookie, query: { id: P.id } }));
  assert(r.body.streak?.unit === 'week' && r.body.streak.current >= 1, 'member sees a weekly streak');
  await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { streakMode: 'daily' } }));

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[5] badges: once, celebrated once, shown in the directory');
  const progRow = (await sql`SELECT * FROM programs WHERE id = ${P.id}`).rows[0];
  r = await call(engagement, req({ cookie: m1.cookie, query: { id: P.id } }));
  const got = r.body.badges.map((b) => b.badge);
  assert(['complete_25', 'complete_50', 'complete_75', 'complete_100', 'first_post'].every((b) => got.includes(b)), `finished member has the progress badges and first post (${got.join(',')})`);
  assert(r.body.newBadges.length === got.length, 'all new, so the app celebrates them');
  const again = await awardBadges({ program: progRow, clientId: m1.cid, tz: TZ });
  assert(again.length === 0, 'awarding again returns nothing new');
  const rows = (await sql`SELECT badge, COUNT(*)::int AS n FROM program_badges WHERE program_id = ${P.id} AND client_id = ${m1.cid} GROUP BY badge`).rows;
  assert(rows.every((x) => x.n === 1), 'each badge stored once');
  r = await call(engagement, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { action: 'seen-badges' } }));
  assert(r.statusCode === 200 && r.body.seen === got.length, 'celebrated → marked seen');
  r = await call(engagement, req({ cookie: m1.cookie, query: { id: P.id } }));
  assert(r.body.newBadges.length === 0, 'nothing to celebrate the second time');
  // 7-day streak badge from seven consecutive local days of check-ins.
  const s7 = await mkClientUser('tia', A.wid);
  await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { clientId: s7.cid } }));
  for (let d = 0; d < 7; d++) {
    await sql`INSERT INTO program_posts (program_id, workspace_id, author_client_id, author_user_id, author_name, body, created_at)
              VALUES (${P.id}, ${A.wid}, ${s7.cid}, ${s7.uid}, 'tia', ${`day ${d}`},
                      -- Noon local on each of the last 7 local days. (NOW() minus whole
                      -- days lands two posts on one local date around a DST change
                      -- when the suite runs late in the evening.)
                      ((date_trunc('day', NOW() AT TIME ZONE ${TZ}) - make_interval(days => ${d}) + INTERVAL '12 hours') AT TIME ZONE ${TZ}))`;
  }
  const s7b = await awardBadges({ program: progRow, clientId: s7.cid, tz: TZ });
  assert(s7b.some((b) => b.badge === 'streak_7') && !s7b.some((b) => b.badge === 'streak_30'), '7 days in a row → 7-day streak badge (not 30)');
  r = await call(meProgress, req({ method: 'POST', cookie: s7.cookie, query: { id: P.id }, body: { itemId: L1.id, done: true } }));
  assert(Array.isArray(r.body.newBadges) && r.body.newBadges.some((b) => b.badge === 'complete_25'), 'completing a lesson returns the badge it just earned');
  r = await call(programDirectory, req({ cookie: m2.cookie, query: { id: P.id } }));
  const card = r.body.members.find((m) => m.key === m1.cid);
  assert(card && card.badges.some((b) => b.badge === 'complete_100'), 'badges show on the directory card');
  assert(!hasEmail(r.body), 'directory still never carries an email');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[6] check-ins');
  const q = (type, label, extra = {}) => ({ type, label, ...extra });
  r = await call(checkins, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { action: 'create-form', title: 'Weekly', frequency: 'weekly', weekday: 1, questions: [] } }));
  assert(r.statusCode === 400, 'no questions → 400');
  r = await call(checkins, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { action: 'create-form', title: 'Too many', frequency: 'daily', questions: Array.from({ length: 11 }, (_, i) => q('short', `Q${i}`)) } }));
  assert(r.statusCode === 400 && /10/.test(r.body.error), '11 questions → 400');
  r = await call(checkins, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { action: 'create-form', title: 'Bad', frequency: 'daily', questions: [q('weight', 'Weight')] } }));
  assert(r.statusCode === 400, 'unknown question type → 400');
  r = await call(checkins, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { action: 'create-form', title: 'Bad', frequency: 'daily', questions: [q('choice', 'Pick', { options: ['Only one'] })] } }));
  assert(r.statusCode === 400, 'multiple choice with one option → 400');
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { action: 'create-form', title: 'Mine', frequency: 'daily', questions: [q('short', 'x')] } }));
  assert(r.statusCode === 404, 'a member cannot create a check-in form (no such form → 404)');
  const questions = [q('short', 'One word for today', { required: true }), q('long', 'What went well?'), q('number', 'Hours spent'), q('scale', 'Energy (1-10)'),
    q('yesno', 'Did you finish the lesson?'), q('choice', 'Mood', { options: ['Great', 'Okay', 'Rough'] }), q('photo', 'A photo of your work')];
  r = await call(checkins, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { action: 'create-form', title: 'Daily check-in', frequency: 'daily', questions } }));
  assert(r.statusCode === 201 && r.body.form.questions.length === 7 && r.body.form.questions.every((x) => x.id), 'owner creates a daily check-in with every question type');
  const F = r.body.form;
  const qid = (i) => F.questions[i].id;
  r = await call(checkins, req({ cookie: m1.cookie, query: { id: P.id } }));
  assert(r.statusCode === 200 && r.body.forms[0]?.status === 'due', 'member sees the check-in as due');
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, answers: { [qid(1)]: 'no title' } } }));
  assert(r.statusCode === 400, 'a required answer missing → 400');
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, answers: { [qid(0)]: 'Good', [qid(3)]: 11 } } }));
  assert(r.statusCode === 400, 'scale out of 1-10 → 400');
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, answers: { [qid(0)]: 'Good', [qid(6)]: blob(B.wid, 'x.jpg') } } }));
  assert(r.statusCode === 400, "a photo from someone else's storage → 400");
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, answers: { [qid(0)]: 'Good', [qid(2)]: 2.5, [qid(3)]: 7, [qid(4)]: true, [qid(5)]: 'Great' } } }));
  assert(r.statusCode === 201 && r.body.response.answers[qid(3)] === 7, 'member submits');
  const resp1 = r.body.response;
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, answers: { [qid(0)]: 'Better', [qid(2)]: 3, [qid(3)]: 8 } } }));
  assert(r.statusCode === 200 && r.body.edited === true && r.body.response.id === resp1.id, 'a second submit in the same period edits the same check-in');
  const n1 = (await sql`SELECT COUNT(*)::int AS n FROM program_checkin_responses WHERE form_id = ${F.id} AND client_id = ${m1.cid}`).rows[0].n;
  assert(n1 === 1, 'one submission per period');
  r = await call(checkins, req({ method: 'POST', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, periodKey: '2020-01-01', answers: { [qid(0)]: 'Old' } } }));
  assert(r.statusCode === 403, 'a period that has ended cannot be edited');
  // A past period's answers (yesterday) for the trend.
  await sql`INSERT INTO program_checkin_responses (form_id, program_id, workspace_id, client_id, period_key, answers, submitted_at)
            VALUES (${F.id}, ${P.id}, ${A.wid}, ${m1.cid}, '2026-01-01', ${JSON.stringify({ [qid(0)]: 'Earlier', [qid(2)]: 1, [qid(3)]: 4 })}::jsonb, NOW() - INTERVAL '2 days')`;
  // Privacy.
  r = await call(checkins, req({ cookie: m2.cookie, query: { id: P.id } }));
  assert(r.statusCode === 200 && r.body.role === 'member' && r.body.history.length === 0 && r.body.forms[0].status === 'due' && !JSON.stringify(r.body).includes('Better'), "another member never sees m1's answers");
  r = await call(checkins, req({ cookie: m2.cookie, query: { id: P.id, clientId: m1.cid } }));
  assert(r.body.role === 'member' && !JSON.stringify(r.body).includes('Better'), 'a member asking for someone else still only gets their own');
  r = await call(checkins, req({ method: 'POST', cookie: m2.cookie, query: { id: P.id }, body: { action: 'reply', responseId: resp1.id, body: 'hi' } }));
  assert(r.statusCode === 404 && !/Better/.test(JSON.stringify(r.body)), 'a member cannot reply on (or reach) another member\'s check-in');
  r = await call(checkins, req({ cookie: outsider.cookie, query: { id: P.id } }));
  assert(r.statusCode === 404, 'a non-member → 404');
  r = await call(checkins, req({ cookie: B.cookie, query: { id: P.id } }));
  assert(r.statusCode === 404, 'another business → 404');
  // Owner inbox, filters, reply, trend.
  r = await call(checkins, req({ cookie: A.cookie, query: { id: P.id } }));
  assert(r.statusCode === 200 && r.body.role === 'owner' && r.body.responses.some((x) => x.id === resp1.id && x.memberName && x.answers[qid(0)] === 'Better'), 'owner sees the response in the inbox');
  r = await call(checkins, req({ cookie: A.cookie, query: { id: P.id, clientId: m2.cid } }));
  assert(r.body.responses.length === 0, 'owner filter by member');
  r = await call(checkins, req({ cookie: A.cookie, query: { id: P.id, formId: F.id, clientId: m1.cid } }));
  assert(r.body.responses.length === 2, 'owner filter by form and member');
  const before = emails.length;
  r = await call(checkins, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { action: 'reply', responseId: resp1.id, body: 'Proud of you. Keep going!' } }));
  assert(r.statusCode === 200 && r.body.response.replies.length === 1, 'owner replies privately');
  await new Promise((x) => setTimeout(x, 300));
  assert(mailsTo(m1.email, /reply/i).length === 1 && emails.length === before + 1, 'the member is emailed about the reply (once)');
  r = await call(checkins, req({ cookie: m1.cookie, query: { id: P.id } }));
  assert(r.body.unreadReplies === 1 && r.body.history.find((x) => x.id === resp1.id)?.replies[0].body === 'Proud of you. Keep going!', 'member reads the reply');
  r = await call(checkins, req({ cookie: m1.cookie, query: { id: P.id } }));
  assert(r.body.unreadReplies === 0, 'and it is marked read');
  r = await call(checkins, req({ cookie: A.cookie, query: { id: P.id, view: 'trend', clientId: m1.cid } }));
  const energy = r.body.series?.find((s) => s.questionId === qid(3));
  assert(r.statusCode === 200 && energy?.points.map((p) => p.value).join(',') === '4,8' && r.body.series.some((s) => s.questionId === qid(2)), 'trend for number and scale answers');
  r = await call(checkins, req({ cookie: m1.cookie, query: { id: P.id, view: 'trend', clientId: m2.cid } }));
  assert(r.body.role === 'member' && !r.body.series, 'members get no trend view of others');
  r = await call(checkins, req({ method: 'PATCH', cookie: m1.cookie, query: { id: P.id }, body: { formId: F.id, title: 'x' } }));
  assert(r.statusCode === 403, 'a member cannot edit a form');
  ev = await pointEvents({ program: prog, clientId: m1.cid, tz: TZ });
  assert(ev.filter((e) => e.kind === 'checkin').length === 2, 'each submitted check-in earns 5 points (edits do not add more)');
  // Weekly period math.
  const wf = { frequency: 'weekly', weekday: 1 };
  const per = currentPeriod(wf, TZ, new Date('2026-10-31T19:00:00Z'));
  assert(per.key === '2026-10-26' && !per.dueToday, 'weekly on Monday: Saturday Oct 31 belongs to the week of Oct 26');
  assert(currentPeriod(wf, TZ, new Date('2026-11-02T18:00:00Z')).dueToday, 'Monday is the due day');
  assert(currentPeriod({ frequency: 'daily' }, TZ, new Date('2026-11-01T06:30:00Z')).key === '2026-10-31', 'daily periods use local midnight');
  // Reminder cron: 10am LA today, m2 / m3 / s4 / s7 not submitted, m1 done.
  const todayLA = localDay(TZ, new Date());
  const tenLocal = new Date(zonedTimeToUtcMs(todayLA, 10 * 60, TZ)); // 10am today in Los Angeles
  const e0 = emails.length;
  const rem = await runCheckinReminders({ now: tenLocal, workspaceId: A.wid });
  await new Promise((x) => setTimeout(x, 300));
  const remMails = emails.slice(e0).filter((e) => /check-in/i.test(e.subject || ''));
  assert(rem.sent >= 3 && mailsTo(m2.email, /check-in/i).length === 1 && mailsTo(m1.email, /due/i).length === 0, `reminders go to members who have not checked in (${rem.sent})`);
  const rem2 = await runCheckinReminders({ now: tenLocal, workspaceId: A.wid });
  assert(rem2.sent === 0 && remMails.length === rem.sent, 'a second run sends nothing');
  const early = await runCheckinReminders({ now: new Date(tenLocal.getTime() + 20 * 3600_000), workspaceId: A.wid }); // 6am the next day
  assert(early.sent === 0, 'nothing before 9am local');
  r = await call(checkinCron, req({ headers: { authorization: 'Bearer nope' } }));
  assert(r.statusCode === 401, 'cron needs auth');
  r = await call(checkins, req({ method: 'DELETE', cookie: A.cookie, query: { id: P.id, formId: F.id } }));
  assert(r.statusCode === 200, 'owner archives the form');
  r = await call(checkins, req({ cookie: m1.cookie, query: { id: P.id } }));
  assert(r.body.forms.length === 0 && r.body.history.length === 2, 'archived form leaves the list; history stays');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[7] cohorts');
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: `Cohort ${T}`, priceCents: 0, delivery: 'cohort' } }));
  const C = r.body.program;
  assert(C.delivery === 'cohort', 'cohort program created');
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { title: 'Welcome', availableBeforeStart: true } }));
  const W0 = r.body.module;
  assert(W0.availableBeforeStart === true, 'module marked available before start');
  const W1 = (await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { title: 'Week 1' } }))).body.module;
  const W2 = (await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { title: 'Week 2', unlockAfterDays: 7 } }))).body.module;
  const cl = async (title, moduleId) => (await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { type: 'post', title, body: `${title} SECRET`, moduleId, notify: false } }))).body.item;
  const CL0 = await cl('Hello', W0.id); const CL1 = await cl('Day one', W1.id); const CL2 = await cl('Day eight', W2.id); const CLtop = await cl('Loose', null);
  const day = (n) => { const d = new Date(Date.now() + n * 86400_000); return d.toISOString().slice(0, 10); };
  r = await call(cohorts, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { name: 'Spring', startDate: day(10) } }));
  assert(r.statusCode === 201, 'future cohort created');
  const spring = r.body.cohortId;
  r = await call(cohorts, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { name: 'Winter', startDate: day(-10), enrollmentClosesOn: day(5), capacity: 1 } }));
  const winter = r.body.cohortId;
  r = await call(cohorts, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { name: 'Closed', startDate: day(-30), enrollmentClosesOn: day(-20) } }));
  const closed = r.body.cohortId;
  r = await call(cohorts, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { name: '', startDate: day(3) } }));
  assert(r.statusCode === 400, 'cohort without a name → 400');
  r = await call(cohorts, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { name: 'X', startDate: 'soon' } }));
  assert(r.statusCode === 400, 'bad start date → 400');
  r = await call(cohorts, req({ cookie: B.cookie, query: { id: C.id } }));
  assert(r.statusCode === 404, "another business can't see the cohorts");
  r = await call(cohorts, req({ cookie: m1.cookie, query: { id: C.id } }));
  assert(r.statusCode !== 200, 'members cannot manage cohorts');
  const startsAt = (await sql`SELECT starts_at FROM program_cohorts WHERE id = ${spring}`).rows[0].starts_at;
  assert(localDay(TZ, new Date(startsAt)) === day(10) && localDay(TZ, new Date(new Date(startsAt).getTime() - 1000)) !== day(10), 'cohort starts at local midnight in the business timezone');
  const cprog = (await sql`SELECT * FROM programs WHERE id = ${C.id}`).rows[0];
  let open = await openCohorts(cprog);
  assert(open.map((c) => c.id).join(',') === [winter, spring].join(','), 'open cohorts: soonest first; a closed one is not offered');
  // Members: c1 picks spring (future), c2 winter (started).
  const c1 = await mkClientUser('cara', A.wid); const c2 = await mkClientUser('dev', A.wid); const c3 = await mkClientUser('eli', A.wid);
  r = await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { clientId: c1.cid, cohortId: spring } }));
  assert(r.statusCode === 201 && r.body.cohortId === spring, 'owner adds a member to a chosen cohort');
  r = await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { clientId: c2.cid } }));
  assert(r.body.cohortId === winter, 'no cohort named: the next open one');
  open = await openCohorts(cprog);
  assert(!open.some((c) => c.id === winter), 'a full cohort (capacity 1) is no longer offered');
  const full = await pickCohort(cprog, winter);
  assert(!!full.error, 'picking a full cohort is refused');
  assert(!!(await pickCohort(cprog, closed)).error, 'picking a cohort whose enrollment closed is refused');
  // Before the start: only the welcome module.
  r = await call(meProgram, req({ cookie: c1.cookie, query: { id: C.id } }));
  const byId = (id) => r.body.lessons.find((l) => l.id === id);
  assert(r.body.cohort?.name === 'Spring' && r.body.cohort.started === false, 'member sees their cohort and that it has not started');
  assert(!byId(CL0.id).locked && byId(CL0.id).body?.includes('SECRET'), 'welcome module is open before the start');
  assert(byId(CL1.id).locked && byId(CLtop.id).locked && byId(CL2.id).locked, 'everything else waits for the start');
  assert(!JSON.stringify(r.body).includes('Day one SECRET') && !JSON.stringify(r.body).includes('Loose SECRET'), 'locked content is never sent');
  assert(new Date(byId(CL1.id).unlocksAt).getTime() === new Date(startsAt).getTime() && new Date(byId(CL2.id).unlocksAt).getTime() === new Date(startsAt).getTime() + 7 * 86400_000, 'unlock dates count from the cohort start');
  assert(r.body.items.every((i) => i.id === CL0.id), 'legacy items list only has what is open');
  r = await call(meProgress, req({ method: 'POST', cookie: c1.cookie, query: { id: C.id }, body: { itemId: CL1.id, done: true } }));
  assert(r.statusCode === 403, 'cannot complete a lesson before the cohort starts');
  // Started cohort: week 1 open, week 2 open (10 days > 7).
  r = await call(meProgram, req({ cookie: c2.cookie, query: { id: C.id } }));
  assert(r.body.cohort?.started === true && r.body.lessons.every((l) => !l.locked), 'started cohort 10 days ago: all of it is open');
  // Move c1 into winter → opens; back to spring → locked again.
  const e1 = (await sql`SELECT id FROM program_enrollments WHERE program_id = ${C.id} AND client_id = ${c1.cid}`).rows[0].id;
  r = await call(cohorts, req({ method: 'PATCH', cookie: A.cookie, query: { id: C.id }, body: { action: 'move', enrollmentId: e1, cohortId: winter } }));
  assert(r.statusCode === 200 && r.body.moved, 'owner moves a member to another cohort');
  r = await call(meProgram, req({ cookie: c1.cookie, query: { id: C.id } }));
  assert(r.body.cohort?.name === 'Winter' && !r.body.lessons.find((l) => l.id === CL2.id).locked, 'the drip now follows the new cohort');
  r = await call(cohorts, req({ method: 'PATCH', cookie: B.cookie, query: { id: C.id }, body: { action: 'move', enrollmentId: e1, cohortId: spring } }));
  assert(r.statusCode === 404, 'another business cannot move members');
  r = await call(cohorts, req({ method: 'PATCH', cookie: A.cookie, query: { id: C.id }, body: { action: 'move', enrollmentId: e1, cohortId: spring } }));
  r = await call(cohorts, req({ method: 'DELETE', cookie: A.cookie, query: { id: C.id, cohortId: spring } }));
  assert(r.statusCode === 400, 'a cohort with members cannot be removed');
  r = await call(cohorts, req({ cookie: A.cookie, query: { id: C.id } }));
  assert(r.statusCode === 200 && r.body.cohorts.find((c) => c.id === spring)?.members === 1 && r.body.cohorts.find((c) => c.id === winter)?.members === 1, 'member counts per cohort');
  // Anchor unit checks.
  const enr = { granted_at: '2026-01-01T00:00:00Z', cohort_starts_at: '2026-03-01T08:00:00Z' };
  assert(dripAnchorFor(enr, { delivery: 'cohort' }).toISOString() === '2026-03-01T08:00:00.000Z' && dripAnchorFor(enr, { delivery: 'evergreen' }).toISOString() === '2026-01-01T00:00:00.000Z', 'dripAnchorFor: cohort start for cohort programs, join date otherwise');
  assert(courseGateFor(enr, { delivery: 'evergreen' }) === null && lessonUnlocksAt({ available_before_start: true, unlock_after_days: 3 }, { anchor: new Date(enr.cohort_starts_at), gate: new Date(enr.cohort_starts_at), now: new Date('2026-02-01') }) === null, 'gate only for cohorts; available-before-start is open early');

  // Lesson comments follow the same rule (drip + cohort anchor).
  console.log('\n[7b] lesson comments on a dripped lesson');
  r = await call(programPosts, req({ cookie: c3.cookie, query: { id: C.id, itemId: CL2.id } }));
  assert(r.statusCode === 404, 'not a member yet → 404');
  await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { clientId: c3.cid, cohortId: spring } }));
  r = await call(programPosts, req({ cookie: c3.cookie, query: { id: C.id, itemId: CL2.id } }));
  assert(r.statusCode === 403, 'member: comments on a still-locked lesson are refused (read)');
  r = await call(programPosts, req({ method: 'POST', cookie: c3.cookie, query: { id: C.id }, body: { kind: 'post', body: 'early?', itemId: CL2.id } }));
  assert(r.statusCode === 403, 'member: comments on a still-locked lesson are refused (write)');
  r = await call(programPosts, req({ cookie: A.cookie, query: { id: C.id, itemId: CL2.id } }));
  assert(r.statusCode === 200, 'owner can always read lesson comments');
  r = await call(programPosts, req({ method: 'POST', cookie: A.cookie, query: { id: C.id }, body: { kind: 'post', body: 'See you in week 2', itemId: CL2.id } }));
  assert(r.statusCode === 201, 'owner can comment on a locked lesson');
  r = await call(programPosts, req({ cookie: c3.cookie, query: { id: C.id, itemId: CL0.id } }));
  assert(r.statusCode === 200, 'the welcome lesson is open for comments before the start');
  // Cohort start + 7 days has passed (winter started 10 days ago).
  const e3 = (await sql`SELECT id FROM program_enrollments WHERE program_id = ${C.id} AND client_id = ${c3.cid}`).rows[0].id;
  await call(cohorts, req({ method: 'PATCH', cookie: A.cookie, query: { id: C.id }, body: { action: 'move', enrollmentId: e3, cohortId: winter } }));
  r = await call(programPosts, req({ cookie: c3.cookie, query: { id: C.id, itemId: CL2.id } }));
  assert(r.statusCode === 200 && r.body.posts.some((p) => p.body === 'See you in week 2'), 'once cohort start + unlock days has passed, the member can read the comments');
  r = await call(programPosts, req({ method: 'POST', cookie: c3.cookie, query: { id: C.id }, body: { kind: 'post', body: 'Here now', itemId: CL2.id } }));
  assert(r.statusCode === 201, '... and comment');
  // Evergreen: a dripped lesson relative to the join date.
  const W9 = (await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Later', unlockAfterDays: 30 } }))).body.module;
  const L9 = await lesson('Day 30', W9.id);
  r = await call(programPosts, req({ cookie: m2.cookie, query: { id: P.id, itemId: L9.id } }));
  assert(r.statusCode === 403, 'evergreen: a lesson that opens on day 30 is closed for comments on day 0');
  r = await call(programPosts, req({ cookie: A.cookie, query: { id: P.id, itemId: L9.id } }));
  assert(r.statusCode === 200, 'evergreen: the owner reads it');

  // ── cleanup ──
  for (const u of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${u}`.catch(() => {});
  }
  for (const u of users) await sql`DELETE FROM users WHERE id = ${u}`.catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });

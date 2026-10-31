// Points, leaderboard, streaks and badges of a program.
//   GET                               → member: my points (week / month / all
//                                       time), streak, badges (newly earned
//                                       ones awarded first), check-ins due, my
//                                       cohort. Owner: the settings.
//   GET ?view=leaderboard&period=week|month|all
//                                     → top 20 + my place. Members get
//                                       { enabled: false } when the owner
//                                       switched the leaderboard off.
//   PATCH { hideFromLeaderboard }     → member: keep earning, stop being listed
//   PATCH { leaderboardEnabled?, streakMode? } → owner
//   POST  { action: 'seen-badges' }   → member: the app celebrated them
// Owner or enrolled member only (anyone else: 404). Never an email.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { communityAccess, profilesFor } from '../../_lib/programCommunity.js';
import { memberEnrollment } from '../../_lib/programCourse.js';
import { leaderboard, memberSummary, PERIODS } from '../../_lib/programEngagement.js';
import { loadForms, currentPeriod } from '../../_lib/programCheckins.js';
import { badRequest, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

async function checkinsDue(program, clientId, tz, now = new Date()) {
  const forms = await loadForms(program.id, program.workspace_id);
  if (!forms.length) return { forms: 0, due: 0 };
  const mine = (await sql`SELECT form_id, period_key FROM program_checkin_responses WHERE program_id = ${program.id} AND client_id = ${clientId}`).rows;
  const done = new Set(mine.map((r) => `${r.form_id}|${r.period_key}`));
  const due = forms.filter((f) => !done.has(`${f.id}|${currentPeriod(f, tz, now).key}`)).length;
  return { forms: forms.length, due };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const access = await communityAccess(user, String(req.query.id || ''));
    if (!access) return notFound(res, 'Program not found');
    const { program } = access;
    const isOwner = access.role === 'owner';

    if (req.method === 'GET') {
      if (req.query.view === 'leaderboard') {
        const period = PERIODS.includes(String(req.query.period)) ? String(req.query.period) : 'week';
        if (!program.leaderboard_enabled && !isOwner) return ok(res, { enabled: false, period, rows: [], me: null });
        const board = await leaderboard({ program, period, viewerClientId: isOwner ? null : access.clientId });
        return ok(res, { enabled: !!program.leaderboard_enabled, role: access.role, ...board });
      }
      if (isOwner) {
        return ok(res, { role: 'owner', leaderboardEnabled: !!program.leaderboard_enabled, streakMode: program.streak_mode === 'weekly' ? 'weekly' : 'daily' });
      }
      const summary = await memberSummary({ program, clientId: access.clientId });
      const enrollment = await memberEnrollment(program.id, access.clientId);
      const cohort = program.delivery === 'cohort' && enrollment?.cohort_starts_at
        ? { name: enrollment.cohort_name, startDate: enrollment.cohort_start_date, startsAt: enrollment.cohort_starts_at, started: new Date(enrollment.cohort_starts_at).getTime() <= Date.now() }
        : null;
      const prof = (await profilesFor(program.workspace_id, [user.id])).get(user.id);
      return ok(res, {
        role: 'member',
        leaderboardEnabled: !!program.leaderboard_enabled,
        streakMode: program.streak_mode === 'weekly' ? 'weekly' : 'daily',
        hideFromLeaderboard: !!prof?.hide_from_leaderboard,
        points: summary.points, streak: summary.streak, badges: summary.badges,
        newBadges: summary.badges.filter((b) => !b.seen),
        checkins: await checkinsDue(program, access.clientId, summary.timezone),
        cohort,
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (isOwner) {
        const sets = {};
        if (body.leaderboardEnabled !== undefined) sets.leaderboard_enabled = !!body.leaderboardEnabled;
        if (body.streakMode !== undefined) {
          if (!['daily', 'weekly'].includes(String(body.streakMode))) return badRequest(res, 'Streaks count days or weeks.');
          sets.streak_mode = String(body.streakMode);
        }
        if (body.hideFromLeaderboard !== undefined) return badRequest(res, 'As the coach you are never on the leaderboard.');
        const lb = sets.leaderboard_enabled ?? !!program.leaderboard_enabled;
        const sm = sets.streak_mode ?? (program.streak_mode || 'daily');
        await sql`UPDATE programs SET leaderboard_enabled = ${lb}, streak_mode = ${sm}, updated_at = NOW() WHERE id = ${program.id} AND workspace_id = ${program.workspace_id}`;
        return ok(res, { leaderboardEnabled: lb, streakMode: sm });
      }
      if (body.leaderboardEnabled !== undefined || body.streakMode !== undefined) return forbidden(res, 'Only the coach can change this.');
      if (body.hideFromLeaderboard === undefined) return badRequest(res, 'Nothing to change.');
      const hide = !!body.hideFromLeaderboard;
      await sql`
        INSERT INTO program_member_profiles (workspace_id, user_id, hide_from_leaderboard) VALUES (${program.workspace_id}, ${user.id}, ${hide})
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET hide_from_leaderboard = EXCLUDED.hide_from_leaderboard, updated_at = NOW()`;
      return ok(res, { hideFromLeaderboard: hide });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.action !== 'seen-badges') return badRequest(res, 'Unknown action.');
      if (isOwner) return ok(res, { seen: 0 });
      const r = await sql`UPDATE program_badges SET seen_at = NOW() WHERE program_id = ${program.id} AND client_id = ${access.clientId} AND seen_at IS NULL RETURNING id`;
      return ok(res, { seen: r.rows.length });
    }
    return methodNotAllowed(res, ['GET', 'PATCH', 'POST']);
  } catch (err) { return serverError(res, err); }
}

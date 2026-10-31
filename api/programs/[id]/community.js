// Community settings and the caller's place in it.
//   GET                                   → summary: role, what is switched on
//                                           (community, directory, live sessions),
//                                           whether I am muted, my profile here;
//                                           the owner also gets the muted list
//   PATCH { profile: { displayName, bio, avatarUrl, hideFromDirectory } }
//                                         → my profile for this business
//   PATCH { directoryEnabled }            → owner: member directory on/off
//   POST  { action: 'report', postId, reason, details? } → member reports a post
//                                           (operator queue + the owner is told)
//   POST  { action: 'mute' | 'unmute', clientId }       → owner only
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isUuid } from '../../_lib/programs.js';
import { communityAccess, isMuted, profilesFor, serializeProfile, safeBlobUrl, uploadWorkspacesFor, BIO_MAX } from '../../_lib/programCommunity.js';
import { normalizeReportInput, createReport } from '../../_lib/moderation.js';
import { notifyOwnerOfReport } from '../../_lib/programCommunityNotify.js';
import { badRequest, created, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

async function summary(access, user) {
  const { program } = access;
  const isOwner = access.role === 'owner';
  const prof = (await profilesFor(program.workspace_id, [user.id])).get(user.id);
  const ev = (await sql`
    SELECT COUNT(*) FILTER (WHERE starts_at + (duration_min || ' minutes')::interval > NOW() AND cancelled_at IS NULL)::int AS upcoming,
           COUNT(*) FILTER (WHERE cancelled_at IS NULL)::int AS total
      FROM program_events WHERE program_id = ${program.id}`).rows[0];
  const out = {
    role: access.role,
    communityEnabled: !!program.community_enabled,
    directoryEnabled: program.directory_enabled !== false,
    hasEvents: (ev?.total || 0) > 0,
    upcomingEvents: ev?.upcoming || 0,
    muted: !isOwner && await isMuted(program.id, access.clientId),
    profile: { ...serializeProfile(prof), defaultName: isOwner ? (user.name || '') : ((await sql`SELECT name FROM clients WHERE id = ${access.clientId}`).rows[0]?.name || user.name || '') },
  };
  if (isOwner) {
    out.mutedMembers = (await sql`
      SELECT m.client_id, COALESCE(mp.display_name, c.name) AS name, m.created_at
        FROM program_member_mutes m JOIN clients c ON c.id = m.client_id AND c.workspace_id = m.workspace_id
        LEFT JOIN program_member_profiles mp ON mp.workspace_id = c.workspace_id AND mp.user_id = c.user_id
       WHERE m.program_id = ${program.id} ORDER BY m.created_at DESC`).rows
      .map((r) => ({ clientId: r.client_id, name: r.name || 'Member', mutedAt: r.created_at }));
  }
  return out;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const programId = String(req.query.id || '');
    const access = await communityAccess(user, programId);
    if (!access) return notFound(res, 'Program not found');
    const { program } = access;
    const isOwner = access.role === 'owner';

    if (req.method === 'GET') return ok(res, await summary(access, user));

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.directoryEnabled !== undefined) {
        if (!isOwner) return forbidden(res, 'Only the coach can change this.');
        await sql`UPDATE programs SET directory_enabled = ${body.directoryEnabled !== false}, updated_at = NOW() WHERE id = ${programId} AND workspace_id = ${program.workspace_id}`;
        program.directory_enabled = body.directoryEnabled !== false;
      }
      if (body.profile && typeof body.profile === 'object') {
        const p = body.profile;
        const cur = (await profilesFor(program.workspace_id, [user.id])).get(user.id) || {};
        const displayName = p.displayName !== undefined ? String(p.displayName || '').trim().slice(0, 80) || null : (cur.display_name || null);
        const bio = p.bio !== undefined ? String(p.bio || '').trim() || null : (cur.bio || null);
        if (bio && bio.length > BIO_MAX) return badRequest(res, `Keep your bio to ${BIO_MAX} characters.`);
        let avatar = cur.avatar_url || null;
        if (p.avatarUrl !== undefined) {
          if (!p.avatarUrl) avatar = null;
          else {
            avatar = safeBlobUrl(String(p.avatarUrl), uploadWorkspacesFor(access));
            if (!avatar) return badRequest(res, 'That photo could not be used. Please upload it again.');
          }
        }
        const hide = p.hideFromDirectory !== undefined ? !!p.hideFromDirectory : !!cur.hide_from_directory;
        await sql`
          INSERT INTO program_member_profiles (workspace_id, user_id, display_name, bio, avatar_url, hide_from_directory)
          VALUES (${program.workspace_id}, ${user.id}, ${displayName}, ${bio}, ${avatar}, ${hide})
          ON CONFLICT (workspace_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, bio = EXCLUDED.bio,
            avatar_url = EXCLUDED.avatar_url, hide_from_directory = EXCLUDED.hide_from_directory, updated_at = NOW()`;
      }
      return ok(res, await summary(access, user));
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || '');
      if (action === 'report') {
        if (isOwner) return badRequest(res, 'As the coach you can remove the post or mute the member instead.');
        const postId = String(body.postId || '');
        if (!isUuid(postId)) return notFound(res, 'Post not found');
        const post = (await sql`SELECT id FROM program_posts WHERE id = ${postId} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0];
        if (!post) return notFound(res, 'Post not found');
        const v = normalizeReportInput({ reason: body.reason, details: body.details, targetId: postId });
        if (v.error) return badRequest(res, v.error);
        const dup = (await sql`SELECT id FROM abuse_reports WHERE target_type = 'program_post' AND target_id = ${postId} AND reporter_user_id = ${user.id} LIMIT 1`).rows[0];
        if (dup) return ok(res, { reported: true, duplicate: true });
        const report = await createReport({
          workspaceId: program.workspace_id, clientId: access.clientId, reporterUserId: user.id, reporterRole: 'client',
          targetType: 'program_post', targetId: postId, reason: v.reason, details: v.details,
        });
        await notifyOwnerOfReport({ program });
        return created(res, { reported: true, reportId: report.id });
      }
      if (action === 'mute' || action === 'unmute') {
        if (!isOwner) return forbidden(res, 'Only the coach can mute members.');
        const clientId = String(body.clientId || '');
        if (!isUuid(clientId)) return notFound(res, 'Member not found');
        const member = (await sql`SELECT 1 FROM program_enrollments WHERE program_id = ${programId} AND client_id = ${clientId} AND workspace_id = ${program.workspace_id} LIMIT 1`).rows[0];
        if (!member) return notFound(res, 'Member not found');
        if (action === 'mute') {
          await sql`INSERT INTO program_member_mutes (program_id, workspace_id, client_id) VALUES (${programId}, ${program.workspace_id}, ${clientId}) ON CONFLICT (program_id, client_id) DO NOTHING`;
        } else {
          await sql`DELETE FROM program_member_mutes WHERE program_id = ${programId} AND client_id = ${clientId}`;
        }
        return ok(res, { muted: action === 'mute', clientId });
      }
      return badRequest(res, 'Unknown action.');
    }
    return methodNotAllowed(res, ['GET', 'PATCH', 'POST']);
  } catch (err) { return serverError(res, err); }
}

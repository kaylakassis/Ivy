// Who is in a program, as other members see it.
//   GET                       → the member directory: the coach first, then
//                               members (avatar, name, bio, joined date).
//                               Members who hid themselves are left out; when
//                               the owner switched the directory off, members
//                               get { enabled: false, members: [] }.
//   GET ?view=mentionables&q= → who can be @mentioned (names only)
// Never returns an email address or a phone number.
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { communityAccess, myKey, activeMembers, profilesFor, coachIdentity, mentionTargets } from '../../_lib/programCommunity.js';
import { forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const httpsOrNull = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const access = await communityAccess(user, String(req.query.id || ''));
    if (!access) return notFound(res, 'Program not found');
    const { program } = access;
    const isOwner = access.role === 'owner';
    const selfKey = myKey(access);

    if (req.query.view === 'mentionables') {
      if (!program.community_enabled && !isOwner) return forbidden(res, 'The community is switched off for this program.');
      const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
      const list = (await mentionTargets(program))
        .filter((t) => t.key !== selfKey && (t.key === 'owner' || !t.hidden))
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((t) => ({ key: t.key, name: t.name }));
      return ok(res, { members: list });
    }

    // The directory is part of the community: off when either is off.
    const enabled = program.directory_enabled !== false && !!program.community_enabled;
    if (!enabled && !isOwner) return ok(res, { enabled: false, members: [] });
    const coach = await coachIdentity(program);
    const members = (await activeMembers(program.id)).sort((a, b) => new Date(a.granted_at) - new Date(b.granted_at));
    const profs = await profilesFor(program.workspace_id, members.map((m) => m.user_id));
    const out = [{
      key: 'owner', isOwner: true, isMe: isOwner, name: coach.name, bio: coach.bio, avatarUrl: coach.avatarUrl, joinedAt: null,
    }];
    let meHidden = false;
    for (const m of members) {
      // Only people who have signed in to the portal are part of the community.
      if (!m.user_id) continue;
      const p = profs.get(m.user_id);
      if (p?.hide_from_directory) { if (m.client_id === selfKey) meHidden = true; continue; }
      out.push({
        key: m.client_id, isOwner: false, isMe: m.client_id === selfKey,
        name: p?.display_name || m.name || 'Member', bio: p?.bio || '',
        avatarUrl: p?.avatar_url || httpsOrNull(m.photo_url), joinedAt: m.granted_at,
      });
    }
    return ok(res, { enabled, members: out, meHidden, role: access.role });
  } catch (err) { return serverError(res, err); }
}

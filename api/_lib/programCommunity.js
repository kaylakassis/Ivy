// Programs community: shared rules for the feed, lesson comments,
// reactions, member profiles, the directory and mentions.
//
// Access always goes through programAccess() (owner of the program's
// workspace, or a client with a live enrollment). Anyone else gets a 404,
// so a program in another business is indistinguishable from one that
// does not exist. Member data that leaves this module never carries an
// email address or a phone number.
import { sql } from './db.js';
import { programAccess, serializePost, isUuid } from './programs.js';
import { blobPathnameForWorkspace, isBlobHost } from './blobScope.js';

export const REACTIONS = ['heart', 'clap', 'fire', 'laugh', '100'];
export const MAX_IMAGES = 6;
export const MAX_PINNED = 3;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const PAGE_SIZE = 30;
export const BIO_MAX = 280;

export async function ownerWorkspaceOf(user) {
  const r = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} LIMIT 1`;
  return r.rows[0]?.id || null;
}

// { role, program, clientId, ownerWorkspaceId } or null (caller answers 404).
export async function communityAccess(user, programId) {
  if (!isUuid(programId)) return null;
  const ownerWs = await ownerWorkspaceOf(user);
  const access = await programAccess(user, programId, ownerWs);
  if (!access.program || !access.role) return null;
  return { ...access, ownerWorkspaceId: ownerWs };
}

// The person behind the request, as a stable key inside one program:
// 'owner' for the coach, the clients.id for a member.
export const myKey = (access) => (access.role === 'owner' ? 'owner' : access.clientId);

// Drip / locked lessons are owned by the course builder. Comments on a
// lesson must be refused while it is locked for this member.
// TODO(merge): replace the body with the course builder's dripAnchorFor()
// based unlock check (api/_lib/programs.js), e.g.
//   const anchor = await dripAnchorFor(access, item); return !anchor || anchor <= now;
// Owners always see everything.
// eslint-disable-next-line no-unused-vars
export async function isItemUnlockedFor(access, item) {
  if (access.role === 'owner') return true;
  return true;
}

// A lesson (program item) of THIS program that is still live, or null.
export async function findProgramItem(programId, itemId) {
  if (!isUuid(itemId)) return null;
  const r = await sql`SELECT * FROM program_items WHERE id = ${itemId} AND program_id = ${programId} AND deleted_at IS NULL`;
  return r.rows[0] || null;
}

export async function isMuted(programId, clientId) {
  if (!clientId) return false;
  const r = await sql`SELECT 1 FROM program_member_mutes WHERE program_id = ${programId} AND client_id = ${clientId} LIMIT 1`;
  return r.rows.length > 0;
}

// Uploaded images: only https URLs on the Blob host, inside a ws/<id>/
// prefix the uploader could have written to (their own workspace, or the
// program's workspace when the owner posts). The stored value is rebuilt
// from the parsed URL, never the raw string. Returns { urls } or { error }.
export function cleanImageUrls(raw, allowedWorkspaceIds, max = MAX_IMAGES) {
  if (raw == null) return { urls: [] };
  if (!Array.isArray(raw)) return { error: 'Images must be a list.' };
  if (raw.length > max) return { error: `Up to ${max} photos per post.` };
  const out = [];
  for (const item of raw) {
    const s = typeof item === 'string' ? item : item?.url;
    const url = safeBlobUrl(s, allowedWorkspaceIds);
    if (!url) return { error: 'That photo could not be used. Please upload it again.' };
    if (!out.includes(url)) out.push(url);
  }
  return { urls: out };
}

export function safeBlobUrl(s, allowedWorkspaceIds) {
  if (typeof s !== 'string' || s.length > 1000) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !isBlobHost(u.hostname) || u.username || u.password || u.port) return null;
  for (const ws of allowedWorkspaceIds.filter(Boolean)) {
    const pathname = blobPathnameForWorkspace(`https://${u.hostname}${u.pathname}`, ws);
    if (pathname) return `https://${u.hostname.toLowerCase()}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  }
  return null;
}

// Workspaces an upload from this person may come from.
export function uploadWorkspacesFor(access) {
  return access.role === 'owner' ? [access.program.workspace_id] : [access.ownerWorkspaceId];
}

// Only https links are stored for anything a person pastes.
export function cleanHttpsUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    return u.toString().slice(0, 1000);
  } catch { return undefined; }
}

// Active members of a program (one row per client), with their login.
export async function activeMembers(programId) {
  const { rows } = await sql`
    SELECT DISTINCT ON (e.client_id) e.client_id, e.granted_at, c.user_id, c.name, c.photo_url
      FROM program_enrollments e
      JOIN clients c ON c.id = e.client_id AND c.workspace_id = e.workspace_id
     WHERE e.program_id = ${programId} AND e.status IN ('active','past_due')
       AND (e.expires_at IS NULL OR e.expires_at > NOW())
     ORDER BY e.client_id, e.granted_at ASC`;
  return rows;
}

export async function profilesFor(workspaceId, userIds) {
  const list = [...new Set((userIds || []).filter(Boolean))];
  if (!list.length) return new Map();
  const { rows } = await sql.query(
    `SELECT * FROM program_member_profiles WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])`,
    [workspaceId, list],
  );
  return new Map(rows.map((r) => [r.user_id, r]));
}

export function serializeProfile(p) {
  return {
    displayName: p?.display_name || '',
    bio: p?.bio || '',
    avatarUrl: p?.avatar_url || null,
    hideFromDirectory: !!p?.hide_from_directory,
  };
}

const httpsOrNull = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

// The coach as members see them: their per-business profile, falling back
// to their name and the business logo.
export async function coachIdentity(program) {
  const r = (await sql`
    SELECT u.id AS user_id, u.name, cs.biz_name, cs.brand_logo_url
      FROM workspaces w JOIN users u ON u.id = w.owner_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
     WHERE w.id = ${program.workspace_id}`).rows[0] || {};
  const prof = r.user_id ? (await profilesFor(program.workspace_id, [r.user_id])).get(r.user_id) : null;
  return {
    userId: r.user_id || null,
    name: prof?.display_name || r.name || r.biz_name || 'Coach',
    bio: prof?.bio || '',
    avatarUrl: prof?.avatar_url || httpsOrNull(r.brand_logo_url),
  };
}

// Everyone who can be @mentioned: the coach plus active members.
// Returns [{ key, name, userId, clientId, hidden }] (server-side only).
export async function mentionTargets(program) {
  const coach = await coachIdentity(program);
  const members = await activeMembers(program.id);
  const profs = await profilesFor(program.workspace_id, members.map((m) => m.user_id));
  const out = [{ key: 'owner', name: coach.name, userId: coach.userId, clientId: null, hidden: false }];
  for (const m of members) {
    const p = m.user_id ? profs.get(m.user_id) : null;
    out.push({ key: m.client_id, name: p?.display_name || m.name || 'Member', userId: m.user_id || null, clientId: m.client_id, hidden: !!p?.hide_from_directory });
  }
  return out;
}

// Keeps the mentions that name a real program member AND whose @Name is
// still in the text, so a crafted request cannot ping people silently.
export async function cleanMentions(program, raw, text, selfKey) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const wanted = new Set(raw.slice(0, 20).map((m) => String(typeof m === 'string' ? m : m?.key || '')));
  const targets = await mentionTargets(program);
  const out = [];
  for (const t of targets) {
    if (!wanted.has(t.key) || t.key === selfKey) continue;
    if (!String(text || '').includes(`@${t.name}`)) continue;
    out.push({ key: t.key, name: t.name });
  }
  return out;
}

// Reaction counts + the caller's own reactions for a set of posts.
export async function reactionsFor(postIds, userId) {
  const map = new Map();
  if (!postIds.length) return map;
  const { rows } = await sql.query(
    `SELECT post_id, emoji, COUNT(*)::int AS n, BOOL_OR(user_id = $2) AS mine
       FROM program_post_reactions WHERE post_id = ANY($1::uuid[]) GROUP BY post_id, emoji`,
    [postIds, userId],
  );
  for (const r of rows) {
    const cur = map.get(r.post_id) || { counts: {}, mine: [] };
    cur.counts[r.emoji] = r.n;
    if (r.mine) cur.mine.push(r.emoji);
    map.set(r.post_id, cur);
  }
  return map;
}

export function emptyReactions() { return { counts: {}, mine: [] }; }

// Full community shape: everything serializePost had (old app builds read
// those fields) plus the new ones.
export function serializeCommunityPost(r, { access, reactions, profiles, reports, now = Date.now() }) {
  const base = serializePost(r);
  const prof = r.author_user_id ? profiles?.get(r.author_user_id) : null;
  const mine = !!r.mine;
  const created = new Date(r.created_at).getTime();
  const out = {
    ...base,
    authorName: prof?.display_name || base.authorName,
    authorAvatar: prof?.avatar_url || (!r.is_owner ? httpsOrNull(r.author_photo_url) : null),
    itemId: r.item_id || null,
    images: Array.isArray(r.images) ? r.images : [],
    mentions: Array.isArray(r.mentions) ? r.mentions : [],
    pinned: !!r.pinned_at,
    isAnnouncement: !!r.is_announcement,
    editedAt: r.edited_at || null,
    editableUntil: mine ? new Date(created + EDIT_WINDOW_MS).toISOString() : null,
    canEdit: mine && now - created < EDIT_WINDOW_MS,
    reactions: reactions?.get(r.id) || emptyReactions(),
  };
  if (access?.role === 'owner') {
    // The owner moderates: who wrote it (to mute) and open reports.
    out.authorKey = r.is_owner ? 'owner' : (r.author_client_id || null);
    out.reportCount = reports?.get(r.id) || 0;
  }
  return out;
}

export async function openReportCounts(workspaceId, postIds) {
  if (!postIds.length) return new Map();
  const { rows } = await sql.query(
    `SELECT target_id, COUNT(*)::int AS n FROM abuse_reports
      WHERE workspace_id = $1 AND target_type = 'program_post' AND status = 'open' AND target_id = ANY($2::uuid[])
      GROUP BY target_id`,
    [workspaceId, postIds],
  );
  return new Map(rows.map((r) => [r.target_id, r.n]));
}

// Rows → API posts, with reactions, profiles and (owner) reports.
export async function decoratePosts(rows, access, userId) {
  const ids = rows.map((r) => r.id);
  const reactions = await reactionsFor(ids, userId);
  const profiles = await profilesFor(access.program.workspace_id, rows.map((r) => r.author_user_id));
  const reports = access.role === 'owner' ? await openReportCounts(access.program.workspace_id, ids) : new Map();
  const now = Date.now();
  return rows.map((r) => serializeCommunityPost(r, { access, reactions, profiles, reports, now }));
}

// SELECT list shared by every post read: `mine` for the caller plus the
// author's client photo (fallback avatar). $1 = user id, $2 = client id.
export const POST_COLUMNS = `p.*, (p.author_user_id = $1 OR (p.author_client_id IS NOT NULL AND p.author_client_id = $2)) AS mine,
  ac.photo_url AS author_photo_url,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;
export const POST_FROM = `program_posts p LEFT JOIN clients ac ON ac.id = p.author_client_id AND ac.workspace_id = p.workspace_id`;

export function encodeCursor(row) {
  return Buffer.from(`${row.cursor_ts}|${row.id}`).toString('base64url');
}
export function decodeCursor(s) {
  if (!s) return null;
  try {
    const [ts, id] = Buffer.from(String(s), 'base64url').toString('utf8').split('|');
    if (!isUuid(id) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(ts || '')) return null;
    return { ts, id };
  } catch { return null; }
}

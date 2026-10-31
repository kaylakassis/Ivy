// Reactions on a community post, reply or lesson comment.
//   POST { postId, emoji } → toggles the caller's reaction; returns the
//                            post's fresh { counts, mine }
// emoji is one of heart, clap, fire, laugh, 100. Members who are muted can
// still react (muting stops posting, not reading or cheering).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isUuid } from '../../_lib/programs.js';
import { communityAccess, REACTIONS, reactionsFor, emptyReactions, findProgramItem, isItemUnlockedFor } from '../../_lib/programCommunity.js';
import { badRequest, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const programId = String(req.query.id || '');
    const access = await communityAccess(user, programId);
    if (!access) return notFound(res, 'Program not found');
    if (!access.program.community_enabled && access.role !== 'owner') return forbidden(res, 'The community is switched off for this program.');
    const body = await readBody(req);
    const emoji = String(body.emoji || '');
    if (!REACTIONS.includes(emoji)) return badRequest(res, 'Unknown reaction.');
    const postId = String(body.postId || '');
    if (!isUuid(postId)) return notFound(res, 'Post not found');
    const post = (await sql`SELECT id, item_id FROM program_posts WHERE id = ${postId} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0];
    if (!post) return notFound(res, 'Post not found');
    if (post.item_id) {
      const item = await findProgramItem(programId, post.item_id);
      if (!item || !(await isItemUnlockedFor(access, item))) return forbidden(res, 'This lesson is not open yet.');
    }
    const del = await sql`DELETE FROM program_post_reactions WHERE post_id = ${postId} AND user_id = ${user.id} AND emoji = ${emoji} RETURNING id`;
    let reacted = false;
    if (!del.rows.length) {
      await sql`
        INSERT INTO program_post_reactions (post_id, program_id, workspace_id, user_id, client_id, emoji)
        VALUES (${postId}, ${programId}, ${access.program.workspace_id}, ${user.id}, ${access.clientId}, ${emoji})
        ON CONFLICT (post_id, user_id, emoji) DO NOTHING`;
      reacted = true;
    }
    const map = await reactionsFor([postId], user.id);
    return ok(res, { postId, emoji, reacted, reactions: map.get(postId) || emptyReactions() });
  } catch (err) { return serverError(res, err); }
}

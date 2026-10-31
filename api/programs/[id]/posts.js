// Community feed of a program, and the comment threads under its lessons.
// Owner and enrolled members can read, post and reply; anyone else gets a
// 404. A post can be removed by its author or the owner.
//
//   GET    ?cursor=                 → feed page: pinned first (first page
//                                      only), then 30 top-level posts, newest
//                                      first, each with its replies
//   GET    ?itemId=&cursor=         → comments under one lesson (never in
//                                      the feed; the feed filters item_id IS NULL)
//   POST   { kind, body, parentId?, images?, mentions?, itemId?, announce? }
//   PATCH  { postId, body? }        → author edits within 15 minutes
//   PATCH  { postId, pinned }       → owner pins (max 3) / unpins
//   PATCH  { postId, announce:true } → owner marks an announcement (notifies once)
//   DELETE ?postId=
//
// Response fields from before (posts[].id/parentId/kind/body/authorName/
// isOwner/mine/createdAt, role) are kept for the iPhone build in the store.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { POST_KINDS, isUuid } from '../../_lib/programs.js';
import {
  communityAccess, myKey, isMuted, findProgramItem, isItemUnlockedFor, cleanImageUrls, uploadWorkspacesFor,
  cleanMentions, decoratePosts, activeMembers, POST_COLUMNS, POST_FROM, PAGE_SIZE, MAX_PINNED, EDIT_WINDOW_MS,
  encodeCursor, decodeCursor,
} from '../../_lib/programCommunity.js';
import { notifyPostActivity, notifyOwnerOfQuestion, notifyOwnerOfLessonComment } from '../../_lib/programCommunityNotify.js';
import { badRequest, created, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const MUTED_MESSAGE = 'The coach has paused your posting in this community. You can still read along.';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const programId = String(req.query.id || '');
    const access = await communityAccess(user, programId);
    if (!access) return notFound(res, 'Program not found');
    const isOwner = access.role === 'owner';
    if (!access.program.community_enabled && !isOwner) return forbidden(res, 'The community is switched off for this program.');
    const program = access.program;
    const selfKey = myKey(access);

    if (req.method === 'GET') {
      const itemId = req.query.itemId ? String(req.query.itemId) : null;
      let item = null;
      if (itemId) {
        item = await findProgramItem(programId, itemId);
        if (!item) return notFound(res, 'Lesson not found');
        if (!(await isItemUnlockedFor(access, item))) return forbidden(res, 'This lesson is not open yet.');
      }
      const cursor = decodeCursor(req.query.cursor);
      const params = [user.id, access.clientId, programId];
      let where = `p.program_id = $3 AND p.parent_id IS NULL AND p.deleted_at IS NULL`;
      if (item) { params.push(item.id); where += ` AND p.item_id = $${params.length}`; } else where += ' AND p.item_id IS NULL';
      let pinned = [];
      if (!item) {
        if (!cursor) {
          pinned = (await sql.query(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE ${where} AND p.pinned_at IS NOT NULL ORDER BY p.pinned_at DESC`, params)).rows;
        }
        where += ' AND p.pinned_at IS NULL';
      }
      if (cursor) { params.push(cursor.ts, cursor.id); where += ` AND (p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
      params.push(PAGE_SIZE + 1);
      const page = (await sql.query(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`, params)).rows;
      const hasMore = page.length > PAGE_SIZE;
      const top = [...pinned, ...page.slice(0, PAGE_SIZE)];
      const topIds = top.map((p) => p.id);
      const replies = topIds.length ? (await sql.query(
        `SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE p.parent_id = ANY($3::uuid[]) AND p.program_id = $4 AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 2000`,
        [user.id, access.clientId, topIds, programId],
      )).rows : [];
      const posts = await decoratePosts([...top, ...replies], access, user.id);
      const muted = !isOwner && await isMuted(programId, access.clientId);
      return ok(res, {
        posts, role: access.role, hasMore, nextCursor: hasMore ? encodeCursor(page[PAGE_SIZE - 1]) : null,
        muted, itemId: item?.id || null, pinnedCount: pinned.length,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!isOwner && await isMuted(programId, access.clientId)) return forbidden(res, MUTED_MESSAGE);
      const text = String(body.body || '').trim().slice(0, 4000);
      const imgs = cleanImageUrls(body.images, uploadWorkspacesFor(access));
      if (imgs.error) return badRequest(res, imgs.error);
      if (!text && imgs.urls.length === 0) return badRequest(res, 'Write something first.');
      let item = null;
      if (body.itemId) {
        item = await findProgramItem(programId, String(body.itemId));
        if (!item) return notFound(res, 'Lesson not found');
        if (!(await isItemUnlockedFor(access, item))) return forbidden(res, 'This lesson is not open yet.');
      }
      let root = null;
      if (body.parentId) {
        const parentId = String(body.parentId);
        if (!isUuid(parentId)) return notFound(res, 'That post is gone.');
        const parent = (await sql`SELECT * FROM program_posts WHERE id = ${parentId} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0];
        if (!parent) return notFound(res, 'That post is gone.');
        root = parent.parent_id
          ? (await sql`SELECT * FROM program_posts WHERE id = ${parent.parent_id} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0]
          : parent;
        if (!root) return notFound(res, 'That post is gone.');
        // A reply lives in the same place as its post: the feed or one lesson.
        if ((root.item_id || null) !== (item?.id || null)) {
          if (item || !root.item_id) return badRequest(res, 'That reply does not belong here.');
          item = await findProgramItem(programId, root.item_id);
          if (!item) return notFound(res, 'Lesson not found');
          if (!(await isItemUnlockedFor(access, item))) return forbidden(res, 'This lesson is not open yet.');
        }
      }
      const announce = body.announce === true;
      if (announce && (!isOwner || root || item)) return forbidden(res, 'Only the coach can post announcements in the feed.');
      const kind = root || item ? 'post' : (POST_KINDS.has(String(body.kind)) ? String(body.kind) : 'post');
      const authorName = isOwner ? (user.name || 'Coach') : ((await sql`SELECT name FROM clients WHERE id = ${access.clientId}`).rows[0]?.name || user.name || 'Member');
      const mentions = await cleanMentions(program, body.mentions, text, selfKey);
      const { rows } = await sql`
        INSERT INTO program_posts (program_id, workspace_id, parent_id, item_id, author_user_id, author_client_id, author_name, is_owner, kind, body, images, mentions, is_announcement)
        VALUES (${programId}, ${program.workspace_id}, ${root?.id || null}, ${item?.id || null}, ${user.id}, ${access.clientId}, ${authorName}, ${isOwner}, ${kind}, ${text},
                ${JSON.stringify(imgs.urls)}::jsonb, ${JSON.stringify(mentions)}::jsonb, ${announce})
        RETURNING *`;
      const post = rows[0];
      const memberKeys = announce ? (await activeMembers(programId)).map((m) => m.client_id) : null;
      await notifyPostActivity({ program, post, root, authorKey: selfKey, mentions, isNew: true, activeMemberKeys: memberKeys });
      if (!isOwner && !root) {
        if (item) await notifyOwnerOfLessonComment({ program, post, authorName, itemTitle: item.title });
        else if (kind === 'question') await notifyOwnerOfQuestion({ program, post, authorName });
      }
      const [out] = await decoratePosts([{ ...post, mine: true }], access, user.id);
      return created(res, { post: out });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const postId = String(body.postId || '');
      if (!isUuid(postId)) return notFound(res, 'Post not found');
      const post = (await sql`SELECT * FROM program_posts WHERE id = ${postId} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0];
      if (!post) return notFound(res, 'Post not found');
      const mine = post.author_user_id === user.id || (!!post.author_client_id && post.author_client_id === access.clientId);
      const feedTop = !post.parent_id && !post.item_id;

      if (body.pinned !== undefined) {
        if (!isOwner) return forbidden(res, 'Only the coach can pin posts.');
        if (!feedTop) return badRequest(res, 'Only posts in the feed can be pinned.');
        if (body.pinned) {
          if (!post.pinned_at) {
            const upd = await sql`
              UPDATE program_posts SET pinned_at = NOW()
               WHERE id = ${postId} AND pinned_at IS NULL
                 AND (SELECT COUNT(*) FROM program_posts WHERE program_id = ${programId} AND pinned_at IS NOT NULL AND deleted_at IS NULL AND item_id IS NULL AND parent_id IS NULL) < ${MAX_PINNED}
               RETURNING id`;
            if (!upd.rows.length) return badRequest(res, `You can pin up to ${MAX_PINNED} posts. Unpin one first.`);
          }
        } else {
          await sql`UPDATE program_posts SET pinned_at = NULL WHERE id = ${postId}`;
        }
      }
      if (body.announce === true) {
        if (!isOwner) return forbidden(res, 'Only the coach can post announcements.');
        if (!feedTop) return badRequest(res, 'Only posts in the feed can be announcements.');
        if (!post.is_announcement) {
          const upd = await sql`UPDATE program_posts SET is_announcement = TRUE WHERE id = ${postId} AND is_announcement = FALSE RETURNING *`;
          if (upd.rows[0]) {
            const memberKeys = (await activeMembers(programId)).map((m) => m.client_id);
            await notifyPostActivity({ program, post: upd.rows[0], authorKey: post.is_owner ? 'owner' : post.author_client_id, isNew: true, activeMemberKeys: memberKeys });
          }
        }
      }
      if (body.body !== undefined) {
        if (!mine) return forbidden(res, 'You can only edit your own posts.');
        if (Date.now() - new Date(post.created_at).getTime() > EDIT_WINDOW_MS) return forbidden(res, 'Posts can be edited for 15 minutes after posting.');
        if (!isOwner && await isMuted(programId, access.clientId)) return forbidden(res, MUTED_MESSAGE);
        const text = String(body.body || '').trim().slice(0, 4000);
        const hasImages = Array.isArray(post.images) && post.images.length > 0;
        if (!text && !hasImages) return badRequest(res, 'Write something first.');
        const mentions = await cleanMentions(program, body.mentions ?? post.mentions, text, selfKey);
        const upd = await sql`
          UPDATE program_posts SET body = ${text}, mentions = ${JSON.stringify(mentions)}::jsonb, edited_at = NOW()
           WHERE id = ${postId} RETURNING *`;
        const root = post.parent_id ? (await sql`SELECT * FROM program_posts WHERE id = ${post.parent_id}`).rows[0] : null;
        // Only people newly mentioned hear about it (the notice key dedupes).
        await notifyPostActivity({ program, post: upd.rows[0], root, authorKey: selfKey, mentions, isNew: false });
      }
      const fresh = (await sql.query(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE p.id = $3`, [user.id, access.clientId, postId])).rows[0];
      const [out] = await decoratePosts([fresh], access, user.id);
      return ok(res, { post: out });
    }

    if (req.method === 'DELETE') {
      const postId = String(req.query.postId || '');
      if (!isUuid(postId)) return notFound(res, 'Post not found');
      const post = (await sql`SELECT * FROM program_posts WHERE id = ${postId} AND program_id = ${programId}`).rows[0];
      if (!post) return notFound(res, 'Post not found');
      const mine = post.author_user_id === user.id || (post.author_client_id && post.author_client_id === access.clientId);
      if (!isOwner && !mine) return forbidden(res, 'You can only remove your own posts.');
      await sql`UPDATE program_posts SET deleted_at = NOW(), pinned_at = NULL WHERE program_id = ${programId} AND (id = ${postId} OR parent_id = ${postId})`;
      return ok(res, { deleted: true });
    }
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}

// Programs phase 2: community + live sessions, through the real handlers
// against local Postgres. Email goes to a mocked Resend (recorded); push
// lands in the notifications feed table, which is what we read back.
//
//   [1]  access: other workspace + non-members get 404 everywhere
//   [2]  feed basics + old response fields + pagination (30 per page)
//   [3]  reactions toggle and counts
//   [4]  photos: https Blob URLs inside the uploader's own prefix only
//   [5]  mentions: only program members are suggestable; notify once
//   [6]  replies: author notified; one email per thread per hour (batched)
//   [7]  questions push the owner
//   [8]  pinning: owner only, max 3, pinned first
//   [9]  announcements: owner only, everyone notified once
//   [10] muting: muted member can read and react, not post
//   [11] edit window: own posts, 15 minutes
//   [12] reports: reuse abuse_reports, owner sees the flag
//   [13] lesson comments: never in the feed, scoped to the program + item
//   [14] profiles + directory: hidden members, directory off, no email/phone
//   [15] live sessions: CRUD owner-only, RSVP members-only, join window,
//        .ics, recording notice once, owner calendar entries
//   [16] reminder cron: 24h / 1h, remind everyone, dedupe, reschedule
//   [17] blob-prune keeps community photos + avatars
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/programs-community.test.mjs
process.env.SECRETS_KEY = process.env.SECRETS_KEY || 'a'.repeat(64);
process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron_programs_community_secret';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import postsHandler from '../api/programs/[id]/posts.js';
import reactionsHandler from '../api/programs/[id]/reactions.js';
import directoryHandler from '../api/programs/[id]/directory.js';
import communityHandler from '../api/programs/[id]/community.js';
import eventsHandler from '../api/programs/[id]/events.js';
import calendarHandler from '../api/calendar/index.js';
import eventsCron from '../api/cron/program-events.js';
import { cleanImageUrls } from '../api/_lib/programCommunity.js';
import { joinWindowOpen } from '../api/_lib/programEvents.js';
import { collectReferencedPathnames } from '../api/cron/blob-prune.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Resend mock ──────────────────────────────────────────────────────
const emails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (/api\.resend\.com/.test(String(url))) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return new Response(JSON.stringify({ id: `em_${emails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
const mailsTo = (addr, re = null) => emails.filter((e) => (e.to || []).includes(addr) && (!re || re.test(e.subject || '')));

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, req: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const HOST = 'www.joinivy.ai';
function req({ method = 'GET', cookie, query = {}, body, origin = `https://${HOST}`, headers = {} } = {}) {
  return { method, url: '/t', query, body, headers: { 'content-type': 'application/json', host: HOST, origin, 'user-agent': 'test', ...(cookie ? { cookie } : {}), ...headers } };
}
async function call(handler, r) { const res = mkRes(); res.req = r; await handler(r, res); return res; }
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;
const as = (who) => ({
  get: (h, programId, query = {}) => call(h, req({ cookie: who.cookie, query: { id: programId, ...query } })),
  post: (h, programId, body, query = {}) => call(h, req({ method: 'POST', cookie: who.cookie, query: { id: programId, ...query }, body })),
  patch: (h, programId, body) => call(h, req({ method: 'PATCH', cookie: who.cookie, query: { id: programId }, body })),
  del: (h, programId, query) => call(h, req({ method: 'DELETE', cookie: who.cookie, query: { id: programId, ...query } })),
});
const runCron = () => call(eventsCron, { method: 'GET', url: '/api/cron/program-events', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, host: 'localhost' } });
const notes = async (userId, tagLike) => (await sql`SELECT * FROM notifications WHERE user_id = ${userId} AND tag LIKE ${tagLike}`).rows;
const notices = async (kind, refId) => (await sql`SELECT * FROM program_community_notices WHERE kind = ${kind} AND ref_id = ${refId}`).rows;

// ── fixtures ─────────────────────────────────────────────────────────
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
async function mkOwner(label) {
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pc-${label}-${S}@example.com`}, 'x', ${`${label} Coach`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${wid}, ${`${label} Studio`}, ${`pc-${label}-${S}`}, 'America/New_York')
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = EXCLUDED.biz_name, slug = EXCLUDED.slug, timezone = EXCLUDED.timezone`;
  return { uid, wid, email: `pc-${label}-${S}@example.com`, cookie: cookieFor(uid) };
}
async function mkClient(label, wid, { phone = null } = {}) {
  const email = `pc-${label}-${S}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const cid = (await sql`INSERT INTO clients (workspace_id, user_id, name, email, phone, stage) VALUES (${wid}, ${uid}, ${label}, ${email}, ${phone}, 'active') RETURNING id`).rows[0].id;
  return { uid, cid, email, name: label, cookie: cookieFor(uid) };
}
async function mkProgram(wid, title, extra = {}) {
  return (await sql`INSERT INTO programs (workspace_id, title, status, community_enabled) VALUES (${wid}, ${title}, 'published', ${extra.community !== false}) RETURNING *`).rows[0];
}
const enroll = (programId, wid, cid) => sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, status) VALUES (${programId}, ${wid}, ${cid}, 'manual', 'active')`;

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const B = await mkOwner('beta');
  const M1 = await mkClient(`Mia${S.slice(-4)}`, A.wid, { phone: '+15555550123' });
  const M2 = await mkClient(`Noah${S.slice(-4)}`, A.wid);
  const M3 = await mkClient(`Lena${S.slice(-4)}`, A.wid);
  const N = await mkClient(`Nonmember${S.slice(-4)}`, A.wid);
  const CB = await mkClient(`Beta client${S.slice(-4)}`, B.wid);
  // M1 has their own (personal) workspace: where their uploads are scoped.
  const M1ws = (await sql`INSERT INTO workspaces (owner_id, name) VALUES (${M1.uid}, 'Mia personal') RETURNING id`).rows[0].id;
  const P = await mkProgram(A.wid, `Community Lab ${S}`);
  const P2 = await mkProgram(A.wid, `Second Program ${S}`);
  const PB = await mkProgram(B.wid, `Beta Program ${S}`);
  for (const m of [M1, M2, M3]) await enroll(P.id, A.wid, m.cid);
  await enroll(P2.id, A.wid, N.cid);
  await enroll(PB.id, B.wid, CB.cid);
  const item = (await sql`INSERT INTO program_items (program_id, workspace_id, type, title, body) VALUES (${P.id}, ${A.wid}, 'post', 'Lesson one', 'Read me') RETURNING *`).rows[0];
  const item2 = (await sql`INSERT INTO program_items (program_id, workspace_id, type, title, body) VALUES (${P.id}, ${A.wid}, 'post', 'Lesson two', 'Read me too') RETURNING *`).rows[0];
  const itemP2 = (await sql`INSERT INTO program_items (program_id, workspace_id, type, title, body) VALUES (${P2.id}, ${A.wid}, 'post', 'Other lesson', 'x') RETURNING *`).rows[0];
  const owner = as(A), m1 = as(M1), m2 = as(M2), m3 = as(M3), n = as(N), ob = as(B), cb = as(CB);

  try {
    // ════════════════════════════════════════════════════════════════
    console.log('\n[1] access: other workspace + non-members → 404');
    const probes = [
      ['posts GET', postsHandler, (w) => w.get(postsHandler, P.id)],
      ['posts POST', postsHandler, (w) => w.post(postsHandler, P.id, { body: 'hi' })],
      ['reactions', reactionsHandler, (w) => w.post(reactionsHandler, P.id, { postId: P.id, emoji: 'heart' })],
      ['directory', directoryHandler, (w) => w.get(directoryHandler, P.id)],
      ['mentionables', directoryHandler, (w) => w.get(directoryHandler, P.id, { view: 'mentionables' })],
      ['community', communityHandler, (w) => w.get(communityHandler, P.id)],
      ['events GET', eventsHandler, (w) => w.get(eventsHandler, P.id)],
      ['events POST', eventsHandler, (w) => w.post(eventsHandler, P.id, { title: 'x', startsAt: new Date().toISOString() })],
    ];
    for (const [label, , fn] of probes) {
      assert((await fn(ob)).statusCode === 404, `other owner: ${label} → 404`);
      assert((await fn(cb)).statusCode === 404, `other business's client: ${label} → 404`);
      assert((await fn(n)).statusCode === 404, `same business, not a member: ${label} → 404`);
    }
    assert((await call(postsHandler, req({ query: { id: P.id } }))).statusCode === 401, 'signed out → 401');
    assert((await owner.get(postsHandler, 'not-a-uuid')).statusCode === 404, 'garbage id → 404');
    let r = await call(postsHandler, req({ method: 'POST', cookie: M1.cookie, query: { id: P.id }, body: { body: 'x' }, origin: 'https://evil.example' }));
    assert(r.statusCode === 403, 'cross-site POST refused');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[2] feed basics, old fields, pagination');
    r = await m1.post(postsHandler, P.id, { kind: 'win', body: 'Finished week one!' });
    assert(r.statusCode === 201 && r.body.post.kind === 'win' && r.body.post.mine === true, 'member posts a win');
    const win = r.body.post;
    for (const k of ['id', 'parentId', 'kind', 'body', 'authorName', 'isOwner', 'mine', 'createdAt']) assert(k in win, `post keeps old field ${k}`);
    r = await m2.get(postsHandler, P.id);
    assert(r.statusCode === 200 && r.body.role === 'member' && r.body.posts.some((p) => p.id === win.id && p.mine === false), 'other member reads it (role + mine kept)');
    assert(!JSON.stringify(r.body).includes(M1.email), 'feed never carries a member email');
    // A dedicated program to page through.
    const PP = await mkProgram(A.wid, `Paging ${S}`);
    await enroll(PP.id, A.wid, M1.cid);
    for (let i = 0; i < 32; i++) {
      await sql`INSERT INTO program_posts (program_id, workspace_id, author_user_id, author_client_id, author_name, kind, body, created_at)
        VALUES (${PP.id}, ${A.wid}, ${M1.uid}, ${M1.cid}, 'Mia', 'post', ${`post ${i}`}, NOW() - (${i} || ' minutes')::interval)`;
    }
    r = await m1.get(postsHandler, PP.id);
    assert(r.body.posts.length === 30 && r.body.hasMore === true && !!r.body.nextCursor, 'first page: 30 + hasMore');
    const page2 = await m1.get(postsHandler, PP.id, { cursor: r.body.nextCursor });
    const ids1 = new Set(r.body.posts.map((p) => p.id));
    assert(page2.body.posts.length === 2 && page2.body.hasMore === false && page2.body.posts.every((p) => !ids1.has(p.id)), 'second page: the remaining 2, no overlap');
    assert(r.body.posts[0].body === 'post 0' && page2.body.posts[1].body === 'post 31', 'newest first across pages');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[3] reactions');
    r = await m1.post(reactionsHandler, P.id, { postId: win.id, emoji: 'heart' });
    assert(r.statusCode === 200 && r.body.reactions.counts.heart === 1 && r.body.reactions.mine.includes('heart'), 'M1 hearts: 1, mine');
    r = await m2.post(reactionsHandler, P.id, { postId: win.id, emoji: 'heart' });
    assert(r.body.reactions.counts.heart === 2 && r.body.reactions.mine.join() === 'heart', 'M2 hearts: 2');
    r = await owner.post(reactionsHandler, P.id, { postId: win.id, emoji: 'fire' });
    assert(r.body.reactions.counts.fire === 1, 'owner reacts fire');
    r = await m1.post(reactionsHandler, P.id, { postId: win.id, emoji: 'heart' });
    assert(r.body.reacted === false && r.body.reactions.counts.heart === 1 && !r.body.reactions.mine.includes('heart'), 'M1 toggles heart off: 1, not mine');
    r = await m1.post(reactionsHandler, P.id, { postId: win.id, emoji: 'thumbsdown' });
    assert(r.statusCode === 400, 'unknown emoji → 400');
    r = await m1.get(postsHandler, P.id);
    const seen = r.body.posts.find((p) => p.id === win.id);
    assert(seen.reactions.counts.heart === 1 && seen.reactions.counts.fire === 1 && seen.reactions.mine.length === 0, 'feed shows counts + my reactions');
    const foreignPost = (await sql`INSERT INTO program_posts (program_id, workspace_id, author_user_id, author_name, is_owner, body) VALUES (${PB.id}, ${B.wid}, ${B.uid}, 'B', TRUE, 'beta') RETURNING id`).rows[0].id;
    r = await m1.post(reactionsHandler, P.id, { postId: foreignPost, emoji: 'heart' });
    assert(r.statusCode === 404, "reacting to another program's post through this program → 404");
    const dup = await sql`SELECT COUNT(*)::int AS n FROM program_post_reactions WHERE post_id = ${win.id} AND user_id = ${M2.uid} AND emoji = 'heart'`;
    assert(dup.rows[0].n === 1, 'one row per (post, user, emoji)');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[4] photos');
    const blob = (ws, name = 'a.jpg') => `https://store1.public.blob.vercel-storage.com/ws/${ws}/programs/community/${name}`;
    r = await owner.post(postsHandler, P.id, { body: 'Look', images: [blob(A.wid), `${blob(A.wid, 'b.png')}?download=1#x`] });
    assert(r.statusCode === 201 && r.body.post.images.length === 2 && r.body.post.images.every((u) => u.startsWith('https://store1.public.blob.vercel-storage.com/ws/')) && !r.body.post.images[1].includes('?'), 'owner posts 2 photos (stored without query)');
    r = await owner.post(postsHandler, P.id, { body: 'x', images: [blob(A.wid).replace('https:', 'http:')] });
    assert(r.statusCode === 400, 'http photo → 400');
    r = await owner.post(postsHandler, P.id, { body: 'x', images: [`https://evil.example.com/ws/${A.wid}/a.jpg`] });
    assert(r.statusCode === 400, 'non-Blob host → 400');
    r = await owner.post(postsHandler, P.id, { body: 'x', images: [blob(B.wid)] });
    assert(r.statusCode === 400, "another workspace's prefix → 400");
    r = await owner.post(postsHandler, P.id, { body: 'x', images: ['https://store1.public.blob.vercel-storage.com/programs/legacy.jpg'] });
    assert(r.statusCode === 400, 'unprefixed path → 400');
    r = await owner.post(postsHandler, P.id, { body: 'x', images: Array.from({ length: 7 }, (_, i) => blob(A.wid, `${i}.jpg`)) });
    assert(r.statusCode === 400 && /6/.test(r.body.error), 'seven photos → 400');
    r = await m1.post(postsHandler, P.id, { body: '', images: [blob(M1ws, 'me.jpg')] });
    assert(r.statusCode === 201 && r.body.post.images.length === 1, "member posts a photo from their own upload prefix (no text needed)");
    r = await m1.post(postsHandler, P.id, { body: 'x', images: [blob(A.wid)] });
    assert(r.statusCode === 400, "member cannot claim the business's prefix");
    assert(cleanImageUrls([`https://user:pw@store1.public.blob.vercel-storage.com/ws/${A.wid}/a.jpg`], [A.wid]).error, 'credentials in the URL are refused');
    assert(cleanImageUrls([`https://store1.public.blob.vercel-storage.com/ws/${A.wid}/../${B.wid}/a.jpg`], [A.wid]).error, 'path traversal refused');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[5] mentions');
    r = await m1.get(directoryHandler, P.id, { view: 'mentionables' });
    const names = r.body.members.map((x) => x.name);
    assert(r.statusCode === 200 && names.includes(M2.name) && names.includes(M3.name) && r.body.members.some((x) => x.key === 'owner'), 'coach + members are suggestable');
    assert(!names.includes(M1.name) && !names.includes(N.name) && !names.includes(CB.name), 'not yourself, not non-members, not other businesses');
    assert(r.body.members.every((x) => Object.keys(x).sort().join() === 'key,name'), 'suggestions carry names only');
    r = await m1.get(directoryHandler, P.id, { view: 'mentionables', q: M2.name.slice(0, 3).toLowerCase() });
    assert(r.body.members.length >= 1 && r.body.members.every((x) => x.name.toLowerCase().includes(M2.name.slice(0, 3).toLowerCase())), 'filters by what was typed');
    const before = emails.length;
    r = await m1.post(postsHandler, P.id, { body: `Thanks @${M2.name} for the tip!`, mentions: [M2.cid, M3.cid, N.cid, CB.cid, 'owner'] });
    assert(r.statusCode === 201 && r.body.post.mentions.length === 1 && r.body.post.mentions[0].key === M2.cid, 'only the member actually @named in the text is kept');
    const mentionPost = r.body.post;
    assert((await notices('mention', mentionPost.id)).length === 1, 'one mention notice');
    assert(mailsTo(M2.email, /mentioned you/).length === 1, 'M2 gets one mention email');
    assert((await notes(M2.uid, `program-thread-${mentionPost.id}`)).length === 1, 'M2 gets a push / feed notification');
    assert(mailsTo(M3.email).length === 0 && mailsTo(N.email).length === 0 && mailsTo(CB.email).length === 0, 'nobody else is emailed');
    r = await m1.patch(postsHandler, P.id, { postId: mentionPost.id, body: `Thanks again @${M2.name}!`, mentions: [M2.cid] });
    assert(r.statusCode === 200 && r.body.post.editedAt, 'edit keeps the mention');
    assert(mailsTo(M2.email, /mentioned you/).length === 1 && (await notices('mention', mentionPost.id)).length === 1, 'editing does not notify again');
    r = await m1.patch(postsHandler, P.id, { postId: mentionPost.id, body: `Thanks @${M2.name} and @${M3.name}!`, mentions: [M2.cid, M3.cid] });
    assert((await notices('mention', mentionPost.id)).length === 2 && mailsTo(M3.email, /mentioned you/).length === 1, 'a newly added mention notifies that person once');
    void before;

    // ════════════════════════════════════════════════════════════════
    console.log('\n[6] reply notifications, batched email per thread per hour');
    const e0 = mailsTo(M1.email).length;
    r = await m2.post(postsHandler, P.id, { body: 'So proud of you', parentId: win.id });
    assert(r.statusCode === 201 && r.body.post.parentId === win.id, 'M2 replies to M1');
    assert(mailsTo(M1.email).length === e0 + 1, 'M1 gets an email for the first reply');
    assert((await notes(M1.uid, `program-thread-${win.id}`)).length === 1, 'M1 gets a push');
    await m3.post(postsHandler, P.id, { body: 'Same here', parentId: win.id });
    await owner.post(postsHandler, P.id, { body: 'Great work', parentId: win.id });
    assert(mailsTo(M1.email).length === e0 + 1, 'later replies within the hour: no more email yet');
    const pendingR = (await sql`SELECT * FROM program_community_notices WHERE recipient_key = ${M1.cid} AND thread_id = ${win.id} AND email_done = FALSE`).rows;
    assert(pendingR.length === 2, 'two replies held back');
    await m1.post(postsHandler, P.id, { body: 'Thank you all', parentId: win.id });
    assert((await notices('reply', win.id)).length === 0 && (await sql`SELECT 1 FROM program_community_notices WHERE recipient_key = ${M1.cid} AND kind = 'reply' AND ref_id IN (SELECT id FROM program_posts WHERE author_user_id = ${M1.uid})`).rows.length === 0, 'replying to your own post notifies nobody');
    r = await runCron();
    assert(r.statusCode === 200 && mailsTo(M1.email).length === e0 + 1, 'cron inside the hour still holds them');
    await sql`UPDATE program_community_notices SET email_sent_at = NOW() - INTERVAL '61 minutes' WHERE recipient_key = ${M1.cid} AND thread_id = ${win.id} AND email_sent_at IS NOT NULL`;
    await runCron();
    const batch = mailsTo(M1.email).slice(e0 + 1);
    assert(batch.length === 1 && /2 new replies/.test(batch[0].subject), 'after the hour: ONE email with both held replies');
    await runCron();
    assert(mailsTo(M1.email).length === e0 + 2, 'running the cron again sends nothing more');
    r = await m2.post(postsHandler, P.id, { body: `@${M1.name} replying with a mention`, parentId: win.id, mentions: [M1.cid] });
    const both = await sql`SELECT kind FROM program_community_notices WHERE ref_id = ${r.body.post.id} AND recipient_key = ${M1.cid}`;
    assert(both.rows.length === 1 && both.rows[0].kind === 'mention', 'a reply that also mentions the author notifies them once');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[7] questions push the owner');
    r = await m2.post(postsHandler, P.id, { kind: 'question', body: 'How do I start?' });
    assert(r.statusCode === 201 && r.body.post.kind === 'question', 'member asks a question');
    assert((await notes(A.uid, `program-question-${r.body.post.id}`)).length === 1, 'owner gets a push for it');
    assert(mailsTo(A.email, /question/i).length === 0, 'push only, no email');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[8] pinning');
    const pins = [];
    for (let i = 0; i < 4; i++) pins.push((await owner.post(postsHandler, P.id, { body: `Pin me ${i}` })).body.post);
    r = await m1.patch(postsHandler, P.id, { postId: pins[0].id, pinned: true });
    assert(r.statusCode === 403, 'member cannot pin');
    for (let i = 0; i < 3; i++) {
      r = await owner.patch(postsHandler, P.id, { postId: pins[i].id, pinned: true });
      assert(r.statusCode === 200 && r.body.post.pinned === true, `owner pins #${i + 1}`);
    }
    r = await owner.patch(postsHandler, P.id, { postId: pins[3].id, pinned: true });
    assert(r.statusCode === 400 && /3/.test(r.body.error), 'a fourth pin → 400');
    r = await m1.get(postsHandler, P.id);
    const firstThree = r.body.posts.filter((p) => !p.parentId).slice(0, 3);
    assert(firstThree.every((p) => p.pinned) && r.body.pinnedCount === 3, 'pinned posts come first');
    r = await owner.patch(postsHandler, P.id, { postId: pins[0].id, pinned: false });
    assert(r.statusCode === 200 && r.body.post.pinned === false, 'owner unpins');
    r = await owner.patch(postsHandler, P.id, { postId: pins[3].id, pinned: true });
    assert(r.statusCode === 200, 'room for another pin now');
    const replyRow = (await sql`SELECT id FROM program_posts WHERE parent_id = ${win.id} LIMIT 1`).rows[0];
    r = await owner.patch(postsHandler, P.id, { postId: replyRow.id, pinned: true });
    assert(r.statusCode === 400, 'replies cannot be pinned');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[9] announcements');
    r = await m1.post(postsHandler, P.id, { body: 'Hear ye', announce: true });
    assert(r.statusCode === 403, 'member cannot announce');
    r = await m1.patch(postsHandler, P.id, { postId: win.id, announce: true });
    assert(r.statusCode === 403, 'member cannot turn a post into an announcement');
    r = await owner.post(postsHandler, P.id, { body: 'New module drops Monday', announce: true });
    assert(r.statusCode === 201 && r.body.post.isAnnouncement === true, 'owner posts an announcement');
    const ann = r.body.post;
    for (const m of [M1, M2, M3]) assert(mailsTo(m.email, /announcement/i).length === 1, `${m.name} emailed once`);
    assert(mailsTo(N.email).length === 0 && mailsTo(A.email, /announcement/i).length === 0, 'non-members and the author are not');
    assert((await notes(M3.uid, `program-announcement-${ann.id}`)).length === 1, 'members get a push');
    r = await owner.patch(postsHandler, P.id, { postId: ann.id, announce: true });
    assert(r.statusCode === 200 && [M1, M2, M3].every((m) => mailsTo(m.email, /announcement/i).length === 1), 'marking it again sends nothing');
    r = await owner.patch(postsHandler, P.id, { postId: pins[1].id, announce: true });
    assert(r.statusCode === 200 && r.body.post.isAnnouncement && mailsTo(M2.email, /announcement/i).length === 2, 'an existing post can become an announcement (once)');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[10] muting');
    r = await m1.post(communityHandler, P.id, { action: 'mute', clientId: M3.cid });
    assert(r.statusCode === 403, 'members cannot mute');
    r = await owner.post(communityHandler, P.id, { action: 'mute', clientId: CB.cid });
    assert(r.statusCode === 404, "cannot mute someone outside the program");
    r = await owner.post(communityHandler, P.id, { action: 'mute', clientId: M3.cid });
    assert(r.statusCode === 200 && r.body.muted === true, 'owner mutes M3');
    r = await m3.post(postsHandler, P.id, { body: 'Can I post?' });
    assert(r.statusCode === 403, 'muted member cannot post');
    r = await m3.post(postsHandler, P.id, { body: 'Or reply?', parentId: win.id });
    assert(r.statusCode === 403, 'muted member cannot reply');
    r = await m3.post(postsHandler, P.id, { body: 'Or comment?', itemId: item.id });
    assert(r.statusCode === 403, 'muted member cannot comment on lessons');
    r = await m3.get(postsHandler, P.id);
    assert(r.statusCode === 200 && r.body.muted === true && r.body.posts.length > 0, 'muted member can still read');
    r = await m3.post(reactionsHandler, P.id, { postId: win.id, emoji: 'clap' });
    assert(r.statusCode === 200, 'muted member can still react');
    r = await owner.get(communityHandler, P.id);
    assert(r.body.mutedMembers.some((x) => x.clientId === M3.cid) && !JSON.stringify(r.body).includes(M3.email), 'owner sees the muted list (no emails)');
    r = await owner.post(communityHandler, P.id, { action: 'unmute', clientId: M3.cid });
    r = await m3.post(postsHandler, P.id, { body: 'Back!' });
    assert(r.statusCode === 201, 'unmuted member can post again');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[11] edit window');
    r = await m2.post(postsHandler, P.id, { body: 'Typo heer' });
    const typo = r.body.post;
    assert(typo.canEdit === true, 'fresh post is editable');
    r = await m1.patch(postsHandler, P.id, { postId: typo.id, body: 'hijack' });
    assert(r.statusCode === 403, "cannot edit someone else's post");
    r = await owner.patch(postsHandler, P.id, { postId: typo.id, body: 'owner edit' });
    assert(r.statusCode === 403, "the owner cannot rewrite a member's words either");
    r = await m2.patch(postsHandler, P.id, { postId: typo.id, body: 'Typo here' });
    assert(r.statusCode === 200 && r.body.post.body === 'Typo here' && r.body.post.editedAt, 'author edits within 15 minutes');
    await sql`UPDATE program_posts SET created_at = NOW() - INTERVAL '16 minutes' WHERE id = ${typo.id}`;
    r = await m2.patch(postsHandler, P.id, { postId: typo.id, body: 'Too late' });
    assert(r.statusCode === 403 && /15 minutes/.test(r.body.error), 'after 15 minutes → 403');
    r = await m2.get(postsHandler, P.id);
    assert(r.body.posts.find((p) => p.id === typo.id).canEdit === false, 'feed says it is no longer editable');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[12] reports');
    r = await m1.post(communityHandler, P.id, { action: 'report', postId: typo.id, reason: 'spam', details: 'nope' });
    assert(r.statusCode === 201 && r.body.reported, 'member reports a post');
    const rep = (await sql`SELECT * FROM abuse_reports WHERE target_type = 'program_post' AND target_id = ${typo.id}`).rows;
    assert(rep.length === 1 && rep[0].workspace_id === A.wid && rep[0].reporter_role === 'client', 'lands in the operator queue for this business');
    assert((await notes(A.uid, `program-report-${P.id}`)).length === 1, 'owner is told');
    r = await m1.post(communityHandler, P.id, { action: 'report', postId: typo.id, reason: 'spam' });
    assert(r.statusCode === 200 && r.body.duplicate, 'reporting twice does not file twice');
    r = await m1.post(communityHandler, P.id, { action: 'report', postId: foreignPost, reason: 'spam' });
    assert(r.statusCode === 404, "cannot report another program's post");
    r = await owner.get(postsHandler, P.id);
    assert(r.body.posts.find((p) => p.id === typo.id).reportCount === 1, 'owner sees the report flag');
    r = await m2.get(postsHandler, P.id);
    assert(r.body.posts.find((p) => p.id === typo.id).reportCount === undefined, 'members do not');
    r = await owner.del(postsHandler, P.id, { postId: typo.id });
    assert(r.statusCode === 200, 'owner removes any post');
    r = await m1.del(postsHandler, P.id, { postId: win.id });
    assert(r.statusCode === 200, 'author removes their own');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[13] lesson comments');
    r = await m1.post(postsHandler, P.id, { body: 'Loved this lesson', itemId: item.id });
    assert(r.statusCode === 201 && r.body.post.itemId === item.id, 'member comments on a lesson');
    const comment = r.body.post;
    assert((await notes(A.uid, `program-comment-${comment.id}`)).length === 1, 'owner hears about lesson comments');
    r = await m2.post(postsHandler, P.id, { body: 'Me too', parentId: comment.id });
    assert(r.statusCode === 201 && r.body.post.itemId === item.id, 'a reply inherits the lesson');
    r = await m2.post(postsHandler, P.id, { body: 'Wrong lesson', parentId: comment.id, itemId: item2.id });
    assert(r.statusCode === 400, 'a reply cannot move to another lesson');
    r = await m2.post(postsHandler, P.id, { body: 'Into a lesson', parentId: pins[2].id, itemId: item.id });
    assert(r.statusCode === 400, 'a feed post reply cannot land in a lesson');
    r = await m2.get(postsHandler, P.id);
    assert(!r.body.posts.some((p) => p.itemId || p.id === comment.id), 'lesson comments never appear in the feed');
    r = await m2.get(postsHandler, P.id, { itemId: item.id });
    assert(r.statusCode === 200 && r.body.posts.length === 2 && r.body.posts.every((p) => p.itemId === item.id), 'the lesson thread has the comment + reply');
    r = await m2.get(postsHandler, P.id, { itemId: item2.id });
    assert(r.body.posts.length === 0, 'another lesson has its own (empty) thread');
    r = await m1.post(postsHandler, P.id, { body: 'x', itemId: itemP2.id });
    assert(r.statusCode === 404, "an item from another program → 404");
    r = await m1.get(postsHandler, P.id, { itemId: itemP2.id });
    assert(r.statusCode === 404, 'reading it → 404');
    r = await n.get(postsHandler, P2.id, { itemId: item.id });
    assert(r.statusCode === 404, "a member of program 2 cannot read program 1's lesson through program 2");
    r = await m1.post(reactionsHandler, P.id, { postId: comment.id, emoji: '100' });
    assert(r.statusCode === 200 && r.body.reactions.counts['100'] === 1, 'reactions work on lesson comments');
    r = await owner.patch(postsHandler, P.id, { postId: comment.id, pinned: true });
    assert(r.statusCode === 400, 'lesson comments cannot be pinned');
    await sql`UPDATE program_items SET deleted_at = NOW() WHERE id = ${item2.id}`;
    r = await m1.post(postsHandler, P.id, { body: 'x', itemId: item2.id });
    assert(r.statusCode === 404, 'removed lesson → 404');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[14] profiles + directory');
    r = await m1.patch(communityHandler, P.id, { profile: { displayName: 'Mia R.', bio: 'x'.repeat(281) } });
    assert(r.statusCode === 400, 'bio over 280 → 400');
    r = await m1.patch(communityHandler, P.id, { profile: { displayName: 'Mia R.', bio: 'Designer. Early riser.', avatarUrl: blob(M1ws, 'face.jpg') } });
    assert(r.statusCode === 200 && r.body.profile.displayName === 'Mia R.' && r.body.profile.avatarUrl.includes(`/ws/${M1ws}/`), 'member saves a profile with an uploaded avatar');
    r = await m1.patch(communityHandler, P.id, { profile: { avatarUrl: 'https://evil.example.com/x.jpg' } });
    assert(r.statusCode === 400, 'avatar must be one of their uploads');
    r = await m3.patch(communityHandler, P.id, { profile: { hideFromDirectory: true } });
    assert(r.statusCode === 200 && r.body.profile.hideFromDirectory === true, 'M3 hides from the directory');
    r = await owner.patch(communityHandler, P.id, { profile: { displayName: 'Coach Alpha', bio: 'Here to help.' } });
    r = await m2.get(directoryHandler, P.id);
    const dir = r.body.members;
    assert(r.statusCode === 200 && dir[0].isOwner && dir[0].name === 'Coach Alpha', 'coach first, with their profile');
    assert(dir.some((x) => x.name === 'Mia R.' && x.bio === 'Designer. Early riser.' && x.joinedAt), 'members show name, bio, joined date');
    assert(!dir.some((x) => x.key === M3.cid), 'hidden member is left out');
    const dj = JSON.stringify(r.body);
    assert(![M1.email, M2.email, M3.email, A.email, '+15555550123', '5555550123'].some((s) => dj.includes(s)), 'no emails or phone numbers anywhere');
    assert(dir.every((x) => !('email' in x) && !('phone' in x)), 'no email/phone fields');
    r = await m3.get(directoryHandler, P.id);
    assert(r.body.meHidden === true, 'the hidden member is told they are hidden');
    r = await m2.get(postsHandler, P.id, { itemId: item.id });
    assert(r.body.posts.find((p) => p.id === comment.id).authorName === 'Mia R.', 'posts use the display name');
    r = await m2.get(directoryHandler, P.id, { view: 'mentionables' });
    assert(!r.body.members.some((x) => x.key === M3.cid), 'hidden members are not suggested for mentions');
    r = await m1.patch(communityHandler, P.id, { directoryEnabled: false });
    assert(r.statusCode === 403, 'members cannot switch the directory');
    r = await owner.patch(communityHandler, P.id, { directoryEnabled: false });
    assert(r.statusCode === 200 && r.body.directoryEnabled === false, 'owner switches the directory off');
    r = await m2.get(directoryHandler, P.id);
    assert(r.statusCode === 200 && r.body.enabled === false && r.body.members.length === 0, 'members then see nothing');
    r = await owner.get(directoryHandler, P.id);
    assert(r.body.enabled === false && r.body.members.length > 1, 'owner still sees the list');
    await owner.patch(communityHandler, P.id, { directoryEnabled: true });
    r = await m2.get(communityHandler, P.id);
    assert(r.body.role === 'member' && r.body.directoryEnabled === true && r.body.communityEnabled === true && r.body.profile.displayName === '', 'summary for a member');
    // Profiles are per business: M1's profile in A does not leak to another business.
    assert((await sql`SELECT COUNT(*)::int AS n FROM program_member_profiles WHERE user_id = ${M1.uid} AND workspace_id <> ${A.wid}`).rows[0].n === 0, 'profile stored for this business only');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[15] live sessions');
    const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
    r = await m1.post(eventsHandler, P.id, { title: 'Member event', startsAt: inHours(48) });
    assert(r.statusCode === 403, 'members cannot create sessions');
    r = await owner.post(eventsHandler, P.id, { title: 'Bad', startsAt: inHours(48), locationType: 'link', externalUrl: 'http://zoom.example.com/x' });
    assert(r.statusCode === 400, 'http join link → 400');
    r = await owner.post(eventsHandler, P.id, { title: 'Bad', startsAt: 'tomorrow-ish' });
    assert(r.statusCode === 400, 'bad date → 400');
    r = await owner.post(eventsHandler, P.id, { title: 'Bad', startsAt: inHours(48), locationType: 'in_person' });
    assert(r.statusCode === 400, 'in person without a place → 400');
    r = await owner.post(eventsHandler, P.id, { title: 'Monthly Q&A', description: 'Bring questions', startsAt: inHours(48), durationMin: 60, locationType: 'video' });
    assert(r.statusCode === 201 && /^https:\/\/meet\.jit\.si\/ivy-/.test(r.body.event.videoUrl), 'owner creates a video session; room minted');
    const evFar = r.body.event;
    r = await owner.patch(eventsHandler, P.id, { eventId: evFar.id, title: 'Monthly Q&A (bring snacks)', durationMin: 90 });
    assert(r.statusCode === 200 && r.body.event.durationMin === 90 && r.body.event.videoUrl === evFar.videoUrl, 'owner edits; room kept');
    r = await m1.patch(eventsHandler, P.id, { eventId: evFar.id, title: 'hijack' });
    assert(r.statusCode === 403, 'members cannot edit');
    r = await m1.del(eventsHandler, P.id, { eventId: evFar.id });
    assert(r.statusCode === 403, 'members cannot cancel');
    r = await ob.patch(eventsHandler, P.id, { eventId: evFar.id, title: 'x' });
    assert(r.statusCode === 404, 'other owner → 404');
    r = await m1.get(eventsHandler, P.id);
    const mv = r.body.upcoming.find((e) => e.id === evFar.id);
    assert(r.statusCode === 200 && mv && mv.videoUrl === null && mv.joinUrl === null && mv.joinOpen === false, 'member: no join link two days out');
    assert(!JSON.stringify(r.body).includes(evFar.videoUrl), 'the room URL is not anywhere in the member response');
    r = await owner.get(eventsHandler, P.id);
    assert(r.body.upcoming.find((e) => e.id === evFar.id).videoUrl === evFar.videoUrl, 'owner always sees it');
    // RSVP
    r = await owner.post(eventsHandler, P.id, { action: 'rsvp', eventId: evFar.id, status: 'going' });
    assert(r.statusCode === 403, 'owner does not RSVP');
    r = await n.post(eventsHandler, P.id, { action: 'rsvp', eventId: evFar.id, status: 'going' });
    assert(r.statusCode === 404, 'non-member cannot RSVP');
    r = await m1.post(eventsHandler, P.id, { action: 'rsvp', eventId: evFar.id, status: 'going' });
    assert(r.statusCode === 200 && r.body.event.rsvp === 'going' && r.body.event.goingCount === 1, 'member RSVPs going');
    r = await m1.post(eventsHandler, P.id, { action: 'rsvp', eventId: evFar.id, status: 'not_going' });
    assert(r.body.event.rsvp === 'not_going' && r.body.event.goingCount === 0, 'and changes their mind (one row)');
    await m1.post(eventsHandler, P.id, { action: 'rsvp', eventId: evFar.id, status: 'going' });
    r = await m1.post(eventsHandler, P.id, { action: 'rsvp', eventId: evFar.id, status: 'maybe' });
    assert(r.statusCode === 400, 'unknown RSVP → 400');
    r = await owner.get(eventsHandler, P.id);
    assert(r.body.upcoming.find((e) => e.id === evFar.id).attendees.some((a) => a.name === 'Mia R.'), 'owner sees who is going');
    // Join window
    r = await owner.post(eventsHandler, P.id, { title: 'Starting soon', startsAt: inHours(10 / 60), durationMin: 30, locationType: 'link', externalUrl: 'https://zoom.example.com/j/123' });
    const evSoon = r.body.event;
    r = await m2.get(eventsHandler, P.id);
    const sv = r.body.upcoming.find((e) => e.id === evSoon.id);
    assert(sv.joinOpen === true && sv.externalUrl === 'https://zoom.example.com/j/123' && sv.joinUrl === sv.externalUrl, 'member sees the link 10 minutes before');
    const fake = { starts_at: new Date(Date.now() - 2 * 3600000), duration_min: 60, cancelled_at: null };
    assert(joinWindowOpen(fake) === false, 'link closed after the end');
    assert(joinWindowOpen({ starts_at: new Date(Date.now() + 16 * 60000), duration_min: 30 }) === false, 'closed 16 minutes before');
    assert(joinWindowOpen({ starts_at: new Date(Date.now() + 14 * 60000), duration_min: 30 }) === true, 'open 14 minutes before');
    // .ics
    r = await m1.get(eventsHandler, P.id, { eventId: evFar.id, format: 'ics' });
    assert(r.statusCode === 200 && /BEGIN:VCALENDAR/.test(r.body.ics) && /SUMMARY:Monthly Q&A/.test(r.body.ics) && !r.body.ics.includes(evFar.videoUrl), '.ics for the member, without the room link');
    assert(/^https:\/\/calendar\.google\.com\//.test(r.body.googleUrl) && /\.ics$/.test(r.body.filename), 'Google link + file name');
    r = await cb.get(eventsHandler, P.id, { eventId: evFar.id, format: 'ics' });
    assert(r.statusCode === 404, '.ics for another business → 404');
    // Owner calendar shows sessions read-only
    r = await call(calendarHandler, req({ cookie: A.cookie }));
    const calBlock = (r.body?.calendar?.blocks || []).find((b) => b.programEventId === evFar.id);
    assert(r.statusCode === 200 && calBlock && calBlock.readOnly === true && calBlock.programId === P.id && /Live:/.test(calBlock.label), 'owner calendar lists the session as a read-only entry');
    r = await call(calendarHandler, req({ cookie: B.cookie }));
    assert(!(r.body?.calendar?.blocks || []).some((b) => b.programEventId === evFar.id), "another owner's calendar does not");
    // Recording notice
    r = await owner.post(eventsHandler, P.id, { title: 'Kickoff', startsAt: inHours(-3), durationMin: 60, locationType: 'video' });
    const evPast = r.body.event;
    r = await m1.get(eventsHandler, P.id);
    assert(r.body.past.some((e) => e.id === evPast.id && e.videoUrl === null), 'past session: no join link for members');
    r = await m1.post(eventsHandler, P.id, { action: 'rsvp', eventId: evPast.id, status: 'going' });
    assert(r.statusCode === 400, 'cannot RSVP to a past session');
    r = await owner.patch(eventsHandler, P.id, { eventId: evPast.id, recordingUrl: 'http://video.example.com/rec' });
    assert(r.statusCode === 400, 'recording must be https');
    r = await owner.patch(eventsHandler, P.id, { eventId: evPast.id, recordingUrl: 'https://video.example.com/rec' });
    assert(r.statusCode === 200 && r.body.event.recordingUrl === 'https://video.example.com/rec', 'owner adds the recording');
    for (const m of [M1, M2, M3]) assert(mailsTo(m.email, /Recording is up/).length === 1, `${m.name} told once`);
    await owner.patch(eventsHandler, P.id, { eventId: evPast.id, recordingUrl: 'https://video.example.com/rec2' });
    assert([M1, M2, M3].every((m) => mailsTo(m.email, /Recording is up/).length === 1), 'changing the link does not notify again');
    // Cancel
    const evCancel = (await owner.post(eventsHandler, P.id, { title: 'Maybe not', startsAt: inHours(30) })).body.event;
    await m2.post(eventsHandler, P.id, { action: 'rsvp', eventId: evCancel.id, status: 'going' });
    r = await owner.del(eventsHandler, P.id, { eventId: evCancel.id });
    assert(r.statusCode === 200 && r.body.event.cancelledAt, 'owner cancels');
    assert(mailsTo(M2.email, /Cancelled/).length === 1 && mailsTo(M1.email, /Cancelled/).length === 0, 'only those going hear about it');
    r = await m2.post(eventsHandler, P.id, { action: 'rsvp', eventId: evCancel.id, status: 'going' });
    assert(r.statusCode === 400, 'cannot RSVP to a cancelled session');
    r = await m2.get(communityHandler, P.id);
    assert(r.body.hasEvents === true && r.body.upcomingEvents >= 2, 'summary says Live has sessions');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[16] reminder cron');
    r = await owner.post(eventsHandler, P.id, { title: 'Workshop', startsAt: inHours(5), durationMin: 60 });
    const ev5 = r.body.event;
    await m1.post(eventsHandler, P.id, { action: 'rsvp', eventId: ev5.id, status: 'going' });
    await m3.post(eventsHandler, P.id, { action: 'rsvp', eventId: ev5.id, status: 'not_going' });
    r = await call(eventsCron, { method: 'GET', url: '/api/cron/program-events', query: {}, headers: { host: 'localhost' } });
    assert(r.statusCode === 401, 'cron without auth → 401');
    await runCron();
    assert(mailsTo(M1.email, /Coming up: Workshop/).length === 1, 'going member gets the 24 hour reminder');
    assert(mailsTo(M2.email, /Workshop/).length === 0 && mailsTo(M3.email, /Workshop/).length === 0, 'others do not (no RSVP / not going)');
    assert((await notes(M1.uid, `program-event-event_24h-${ev5.id}`)).length === 1, 'and a push');
    await runCron(); await runCron();
    assert(mailsTo(M1.email, /Workshop/).length === 1 && (await notices('event_24h', ev5.id)).length === 1, 'running again sends nothing more');
    // Moved to 30 minutes from now: the 1 hour reminder goes out.
    r = await owner.patch(eventsHandler, P.id, { eventId: ev5.id, startsAt: inHours(0.5) });
    assert(r.statusCode === 200, 'owner moves it');
    await runCron(); await runCron();
    assert(mailsTo(M1.email, /Starting soon: Workshop/).length === 1, '1 hour reminder, once');
    assert(mailsTo(M1.email, /Coming up: Workshop/).length === 1, 'no second 24 hour reminder inside the last hour');
    // Remind everyone
    r = await owner.post(eventsHandler, P.id, { title: 'Town hall', startsAt: inHours(20), remindEveryone: true });
    const evAll = r.body.event;
    await m3.post(eventsHandler, P.id, { action: 'rsvp', eventId: evAll.id, status: 'not_going' });
    await runCron(); await runCron();
    assert(mailsTo(M1.email, /Town hall/).length === 1 && mailsTo(M2.email, /Town hall/).length === 1, 'remind everyone: members without an RSVP get it, once');
    assert(mailsTo(M3.email, /Town hall/).length === 0, 'except people who said they cannot make it');
    assert(mailsTo(N.email).length === 0 && mailsTo(CB.email).length === 0, 'never people outside the program');
    // A member who lost access is not reminded.
    await sql`UPDATE program_enrollments SET status = 'cancelled' WHERE program_id = ${P.id} AND client_id = ${M2.cid}`;
    r = await owner.post(eventsHandler, P.id, { title: 'After hours', startsAt: inHours(3), remindEveryone: true });
    await runCron();
    assert(mailsTo(M2.email, /After hours/).length === 0 && mailsTo(M1.email, /After hours/).length === 1, 'cancelled members are skipped');
    r = await m2.get(eventsHandler, P.id);
    assert(r.statusCode === 404, 'and lose access to sessions');

    // ════════════════════════════════════════════════════════════════
    console.log('\n[17] blob-prune keep-list');
    const photoPost = (await m1.post(postsHandler, P.id, { body: 'keep me', images: [blob(M1ws, `keep-${S}.jpg`)] })).body.post;
    await m1.patch(communityHandler, P.id, { profile: { avatarUrl: blob(M1ws, `avatar-${S}.jpg`) } });
    let refs = await collectReferencedPathnames();
    assert(refs && refs.has(`ws/${M1ws}/programs/community/keep-${S}.jpg`), 'community photo is a referenced blob (never pruned)');
    assert(refs && refs.has(`ws/${M1ws}/programs/community/avatar-${S}.jpg`), 'member avatar is a referenced blob');
    await m1.del(postsHandler, P.id, { postId: photoPost.id });
    refs = await collectReferencedPathnames();
    assert(refs && !refs.has(`ws/${M1ws}/programs/community/keep-${S}.jpg`), 'a removed post\'s photo is left for the prune');
  } finally {
    globalThis.fetch = realFetch;
    await sql`DELETE FROM abuse_reports WHERE workspace_id IN (${A.wid}, ${B.wid})`;
    await sql`DELETE FROM workspaces WHERE id IN (${A.wid}, ${B.wid})`;
    await sql.query(`DELETE FROM workspaces WHERE owner_id = ANY($1::uuid[])`, [[M1.uid, M2.uid, M3.uid, N.uid, CB.uid]]);
    await sql.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[A.uid, B.uid, M1.uid, M2.uid, M3.uid, N.uid, CB.uid]]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

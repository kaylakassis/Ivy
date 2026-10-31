// Programs as courses (phase 1), through the real handlers against local
// Postgres. Resend is mocked by replacing globalThis.fetch.
//
//   [1] modules: CRUD, ordering, workspace isolation
//   [2] lessons: video links (YouTube / Vimeo / Loom), uploads, audio,
//       images, attachments, preview flag, moving between modules
//   [3] drip: locked content is never served to a member; owner sees all
//   [4] progress: only enrolled members, only their own record
//   [5] public sales page: outline + free previews only
//   [6] notifications: new lesson, drip cron dedupe, unsubscribe, owner join push
//   [7] upload token kinds
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/programs-course.test.mjs
process.env.SECRETS_KEY = process.env.SECRETS_KEY || 'a'.repeat(64);
process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron_course_secret';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { mintUnsubscribeToken } from '../api/_lib/unsubscribeToken.js';
import programsIndex from '../api/programs/index.js';
import programById from '../api/programs/[id].js';
import programItems from '../api/programs/[id]/items.js';
import programModules from '../api/programs/[id]/modules.js';
import programMembers from '../api/programs/[id]/members.js';
import programPublic from '../api/programs/public/[id].js';
import uploadToken, { uploadKind } from '../api/programs/upload-token.js';
import mePrograms from '../api/me/programs/index.js';
import meProgram from '../api/me/programs/[id].js';
import meProgress from '../api/me/programs/[id]/progress.js';
import dripCron from '../api/cron/program-drip.js';
import unsubscribe from '../api/unsubscribe.js';
import { parseVideoLink, videoEmbedUrl, dripAnchorFor, moduleUnlocksAt } from '../api/_lib/programCourse.js';
import { notifyNewLesson, runDripNotifications } from '../api/_lib/programNotify.js';
import { applyProgramSubscription } from '../api/_lib/programs.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

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
    headers: { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': `${IPB}.7`, 'user-agent': 'test', ...(cookie ? { cookie } : {}), ...headers } };
}
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;

const STAMP = Date.now();
const T = `pc${STAMP}`;
const users = []; const workspaces = [];
async function mkOwner(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`${T}-${label}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${`${T}-${label}`})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}`;
  users.push(u); workspaces.push(wid);
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

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const B = await mkOwner('beta');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] modules: CRUD, ordering, workspace isolation');
  let r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: `Course ${T}`, description: 'A course.', priceCents: 0 } }));
  const P = r.body.program;
  r = await call(programsIndex, req({ method: 'POST', cookie: B.cookie, body: { title: `B Course ${T}`, priceCents: 0 } }));
  const PB = r.body.program;

  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: '' } }));
  assert(r.statusCode === 400 && /title/i.test(r.body.error), 'module without a title → 400');
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'X', unlockAfterDays: -1 } }));
  assert(r.statusCode === 400, 'negative unlock day → 400');
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'X', unlockAfterDays: 'soon' } }));
  assert(r.statusCode === 400, 'non-numeric unlock day → 400');
  r = await call(programModules, req({ method: 'POST', query: { id: P.id }, body: { title: 'X' } }));
  assert(r.statusCode === 401, 'anonymous module create → 401');
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Week 1', description: 'Start here' } }));
  assert(r.statusCode === 201 && r.body.module.title === 'Week 1' && r.body.module.unlockAfterDays === null, 'module created');
  const M1 = r.body.module;
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Week 2', unlockAfterDays: 7 } }));
  const M2 = r.body.module;
  assert(r.statusCode === 201 && M2.unlockAfterDays === 7 && M2.position > M1.position, 'dripped module created after the first');
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Bonus' } }));
  const M3 = r.body.module;
  r = await call(programModules, req({ method: 'POST', cookie: B.cookie, query: { id: PB.id }, body: { title: 'B module' } }));
  const MB = r.body.module;

  // Other workspace: 404 on every verb, nothing changes.
  r = await call(programModules, req({ method: 'POST', cookie: B.cookie, query: { id: P.id }, body: { title: 'Hijack' } }));
  assert(r.statusCode === 404, "owner B cannot add a module to A's program");
  r = await call(programModules, req({ method: 'PATCH', cookie: B.cookie, query: { id: P.id }, body: { moduleId: M1.id, title: 'Hijacked' } }));
  assert(r.statusCode === 404, "owner B cannot rename A's module");
  r = await call(programModules, req({ method: 'PATCH', cookie: B.cookie, query: { id: PB.id }, body: { moduleId: M1.id, title: 'Hijacked' } }));
  assert(r.statusCode === 404, "owner B cannot rename A's module through B's own program");
  r = await call(programModules, req({ method: 'DELETE', cookie: B.cookie, query: { id: PB.id, moduleId: M1.id } }));
  assert(r.statusCode === 404, "owner B cannot delete A's module through B's own program");
  r = await call(programModules, req({ method: 'PATCH', cookie: B.cookie, query: { id: PB.id }, body: { order: [M3.id, M2.id, M1.id] } }));
  assert((await sql`SELECT title FROM program_modules WHERE id = ${M1.id}`).rows[0].title === 'Week 1', "A's module untouched");
  assert((await sql`SELECT position FROM program_modules WHERE id = ${M1.id}`).rows[0].position === M1.position, "B's reorder did not move A's modules");

  r = await call(programModules, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { moduleId: M3.id, title: 'Bonus material', unlockAfterDays: 30 } }));
  assert(r.statusCode === 200 && r.body.module.title === 'Bonus material' && r.body.module.unlockAfterDays === 30, 'rename + set unlock day');
  r = await call(programModules, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { moduleId: M3.id, unlockAfterDays: '' } }));
  assert(r.statusCode === 200 && r.body.module.unlockAfterDays === null && r.body.module.title === 'Bonus material', 'blank unlock day opens it right away, keeps title');
  r = await call(programModules, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { order: [M3.id, M1.id, M2.id] } }));
  r = await call(programById, req({ cookie: A.cookie, query: { id: P.id } }));
  assert(r.body.modules.map((m) => m.id).join() === [M3.id, M1.id, M2.id].join(), 'reorder applied');
  r = await call(programModules, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { order: [M1.id, M2.id, M3.id] } }));

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] lessons: links, uploads, audio, images, attachments');
  const yt = parseVideoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert(yt?.provider === 'youtube' && yt.youtubeId === 'dQw4w9WgXcQ', 'YouTube watch link');
  assert(parseVideoLink('https://youtu.be/dQw4w9WgXcQ')?.ref === 'dQw4w9WgXcQ', 'youtu.be link');
  assert(parseVideoLink('dQw4w9WgXcQ')?.provider === 'youtube', 'bare YouTube id (older builders)');
  assert(parseVideoLink('https://vimeo.com/76979871')?.ref === '76979871', 'Vimeo link');
  assert(parseVideoLink('https://vimeo.com/76979871/abc123def4')?.ref === '76979871:abc123def4', 'unlisted Vimeo link keeps its hash');
  assert(parseVideoLink('https://player.vimeo.com/video/76979871?h=abc123def4')?.ref === '76979871:abc123def4', 'Vimeo player link');
  const loomId = '0123456789abcdef0123456789abcdef';
  assert(parseVideoLink(`https://www.loom.com/share/${loomId}`)?.provider === 'loom', 'Loom share link');
  assert(parseVideoLink(`https://www.loom.com/embed/${loomId}?t=3`)?.ref === loomId, 'Loom embed link');
  for (const bad of ['http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'http://vimeo.com/76979871', `http://www.loom.com/share/${loomId}`,
    'https://evil.example.com/watch?v=dQw4w9WgXcQ', 'https://vimeo.com.evil.example/76979871', 'https://www.loom.com/share/short',
    'javascript:alert(1)', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'ftp://vimeo.com/76979871']) {
    assert(parseVideoLink(bad) === null, `rejected: ${bad}`);
  }
  assert(/^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(videoEmbedUrl('youtube', 'dQw4w9WgXcQ')), 'YouTube embeds use youtube-nocookie');
  assert(/^https:\/\/player\.vimeo\.com\/video\/76979871\?dnt=1/.test(videoEmbedUrl('vimeo', '76979871')), 'Vimeo embeds use dnt=1');
  assert(videoEmbedUrl('loom', loomId).startsWith(`https://www.loom.com/embed/${loomId}`), 'Loom embed URL');
  assert(videoEmbedUrl('vimeo', 'x"><script>') === null && videoEmbedUrl('youtube', '../../x') === null, 'tampered refs give no embed');

  const add = (body, who = A, pid = P.id) => call(programItems, req({ method: 'POST', cookie: who.cookie, query: { id: pid }, body: { notify: false, ...body } }));
  r = await add({ type: 'quiz', title: 'x' });
  assert(r.statusCode === 400, 'unknown lesson type → 400');
  r = await add({ type: 'video', title: 'V', videoUrl: 'http://vimeo.com/76979871' });
  assert(r.statusCode === 400, 'non-https video link → 400');
  r = await add({ type: 'video', title: 'V', videoUrl: 'https://dailymotion.com/video/x7' });
  assert(r.statusCode === 400, 'unknown video host → 400');
  r = await add({ type: 'video', title: 'Welcome', videoUrl: 'https://youtu.be/dQw4w9WgXcQ', body: 'Hello there' });
  assert(r.statusCode === 201 && r.body.item.youtubeId === 'dQw4w9WgXcQ' && r.body.item.videoProvider === 'youtube' && r.body.item.moduleId === null, 'YouTube lesson at the top level keeps youtubeId for old clients');
  const Lwelcome = r.body.item;
  r = await add({ type: 'video', title: 'Vimeo lesson', videoUrl: 'https://vimeo.com/76979871/abc123def4', moduleId: M1.id });
  assert(r.statusCode === 201 && r.body.item.videoProvider === 'vimeo' && r.body.item.youtubeId === null && /h=abc123def4/.test(r.body.item.videoEmbedUrl) && r.body.item.moduleId === M1.id, 'Vimeo lesson in Week 1');
  const Lvimeo = r.body.item;
  r = await add({ type: 'video', title: 'Loom lesson', videoUrl: `https://www.loom.com/share/${loomId}`, moduleId: M1.id });
  assert(r.statusCode === 201 && r.body.item.videoProvider === 'loom', 'Loom lesson');
  r = await add({ type: 'video', title: 'Upload', mediaUrl: blob(B.wid, 'v.mp4') });
  assert(r.statusCode === 400, "uploaded video under another workspace's folder → 400");
  r = await add({ type: 'video', title: 'Upload', mediaUrl: 'https://evil.example.com/ws/x/v.mp4' });
  assert(r.statusCode === 400, 'uploaded video on a foreign host → 400');
  r = await add({ type: 'video', title: 'Uploaded video', mediaUrl: blob(A.wid, 'v.mp4'), mediaName: 'v.mp4', moduleId: M1.id });
  assert(r.statusCode === 201 && r.body.item.videoProvider === 'upload' && r.body.item.mediaUrl === blob(A.wid, 'v.mp4') && r.body.item.videoEmbedUrl === null, 'uploaded video lesson');
  r = await add({ type: 'audio', title: 'Audio' });
  assert(r.statusCode === 400, 'audio without a file → 400');
  r = await add({ type: 'audio', title: 'Meditation', mediaUrl: blob(A.wid, 'a.mp3'), mediaName: 'a.mp3', moduleId: M1.id });
  assert(r.statusCode === 201 && r.body.item.type === 'audio', 'audio lesson');
  r = await add({ type: 'post', title: 'Too many', body: 'x', images: Array.from({ length: 11 }, (_, i) => ({ url: blob(A.wid, `i${i}.png`) })) });
  assert(r.statusCode === 400, '11 images → 400');
  r = await add({ type: 'post', title: 'Too many', body: 'x', attachments: Array.from({ length: 6 }, (_, i) => ({ url: blob(A.wid, `f${i}.pdf`), name: 'f.pdf' })) });
  assert(r.statusCode === 400, '6 attachments → 400');
  r = await add({ type: 'post', title: 'Foreign image', body: 'x', images: [{ url: blob(B.wid, 'i.png') }] });
  assert(r.statusCode === 400, "image from another workspace's folder → 400");
  r = await add({ type: 'post', title: 'Bad module', body: 'x', moduleId: MB.id });
  assert(r.statusCode === 404, "moduleId from another workspace's program → 404");
  const SECRET = `SECRET-BODY-${T}`;
  const secretAtt = blob(A.wid, `secret-${T}.pdf`);
  const secretImg = blob(A.wid, `secret-${T}.png`);
  r = await add({ type: 'post', title: 'Week 2 lesson', body: SECRET, moduleId: M2.id, images: [{ url: secretImg, name: 's.png' }], attachments: [{ url: secretAtt, name: 'workbook.pdf' }] });
  assert(r.statusCode === 201 && r.body.item.images.length === 1 && r.body.item.attachments[0].name === 'workbook.pdf', 'lesson with images + attachments in the dripped module');
  const Lsecret = r.body.item;
  const secretVimeo = '987654321';
  r = await add({ type: 'video', title: 'Week 2 video', videoUrl: `https://vimeo.com/${secretVimeo}`, moduleId: M2.id });
  const LsecretVid = r.body.item;
  r = await add({ type: 'audio', title: 'Week 2 audio', mediaUrl: blob(A.wid, `secret-${T}.mp3`), moduleId: M2.id });
  const LsecretAudio = r.body.item;
  r = await add({ type: 'post', title: 'Free sample', body: `PREVIEW-${T}`, isPreview: true });
  assert(r.statusCode === 201 && r.body.item.isPreview === true, 'free preview lesson');
  const Lpreview = r.body.item;
  r = await add({ type: 'post', title: 'Not a preview', body: `PRIVATE-${T}` });
  const Lprivate = r.body.item;

  // Edits: an older builder's PATCH (youtube field) still works; moving between modules; reorder within one.
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { itemId: Lwelcome.id, title: 'Welcome!', youtube: 'https://youtu.be/aaaaaaaaaaa', fileUrl: null } }));
  assert(r.statusCode === 200 && r.body.item.youtubeId === 'aaaaaaaaaaa' && r.body.item.body === 'Hello there', 'legacy PATCH with youtube changes the link, keeps the body');
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { itemId: Lvimeo.id, isPreview: true } }));
  assert(r.statusCode === 200 && r.body.item.isPreview === true && r.body.item.videoProvider === 'vimeo', 'toggle preview keeps the video');
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { itemId: Lvimeo.id, isPreview: false } }));
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { itemId: Lprivate.id, moduleId: M3.id } }));
  assert(r.statusCode === 200 && r.body.item.moduleId === M3.id, 'lesson moved to another module');
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { itemId: Lprivate.id, moduleId: null } }));
  assert(r.statusCode === 200 && r.body.item.moduleId === null, 'lesson moved back to the top level');
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { itemId: Lprivate.id, moduleId: MB.id } }));
  assert(r.statusCode === 404, "cannot move a lesson into another workspace's module");
  r = await call(programItems, req({ method: 'PATCH', cookie: B.cookie, query: { id: PB.id }, body: { itemId: Lprivate.id, title: 'Hijacked' } }));
  assert(r.statusCode === 404, "owner B cannot edit A's lesson");
  r = await call(programItems, req({ method: 'PATCH', cookie: B.cookie, query: { id: P.id }, body: { order: [Lprivate.id] } }));
  assert(r.statusCode === 404, "owner B cannot reorder A's lessons");
  r = await call(programById, req({ cookie: A.cookie, query: { id: P.id } }));
  const m1Ids = r.body.items.filter((i) => i.moduleId === M1.id).map((i) => i.id);
  r = await call(programItems, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { order: [...m1Ids].reverse(), moduleId: M1.id } }));
  r = await call(programById, req({ cookie: A.cookie, query: { id: P.id } }));
  assert(r.body.items.filter((i) => i.moduleId === M1.id).map((i) => i.id).join() === [...m1Ids].reverse().join(), 'reorder within a module');
  assert(r.body.modules.find((m) => m.id === M1.id).lessons === 4, 'owner sees the lesson count per module');
  // Deleting a module keeps its lessons at the top level.
  r = await add({ type: 'post', title: 'Bonus lesson', body: 'b', moduleId: M3.id });
  const Lbonus = r.body.item;
  r = await call(programModules, req({ method: 'DELETE', cookie: A.cookie, query: { id: P.id, moduleId: M3.id } }));
  assert(r.statusCode === 200, 'module deleted');
  assert((await sql`SELECT module_id FROM program_items WHERE id = ${Lbonus.id}`).rows[0].module_id === null, "a deleted module's lessons move to the top level");
  r = await call(programModules, req({ method: 'DELETE', cookie: A.cookie, query: { id: P.id, moduleId: M3.id } }));
  assert(r.statusCode === 404, 'deleting it again → 404');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] drip: locked content is never served to a member');
  const mem = await mkClientUser('member', A.wid);
  const other = await mkClientUser('nonmember', A.wid);
  const bClient = await mkClientUser('bclient', B.wid);
  r = await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { clientId: mem.cid } }));
  assert(r.statusCode === 201, 'member granted by hand');
  const enrollmentId = r.body.enrollmentId;
  r = await call(meProgram, req({ cookie: mem.cookie, query: { id: P.id } }));
  assert(r.statusCode === 200 && r.body.role === 'member', 'member opens the course');
  const course = r.body;
  const wk2 = course.modules.find((m) => m.id === M2.id);
  const daysOut = (new Date(wk2.unlocksAt) - Date.now()) / 86400_000;
  assert(wk2.locked === true && daysOut > 6.9 && daysOut < 7.1, `Week 2 locked, unlocks in 7 days (${daysOut.toFixed(2)})`);
  assert(course.modules.find((m) => m.id === M1.id).locked === false, 'Week 1 open');
  const lockedRows = course.lessons.filter((l) => l.moduleId === M2.id);
  assert(lockedRows.length === 3 && lockedRows.every((l) => l.locked && l.title && l.unlocksAt), 'locked lessons listed with title + unlocksAt');
  const forbiddenKeys = ['body', 'fileUrl', 'fileName', 'youtubeId', 'videoEmbedUrl', 'videoUrl', 'videoProvider', 'mediaUrl', 'mediaName', 'images', 'attachments'];
  assert(lockedRows.every((l) => forbiddenKeys.every((k) => !(k in l))), 'locked lessons carry no body / file / media / video / images / attachments');
  const raw = JSON.stringify(r.body);
  assert(!raw.includes(SECRET) && !raw.includes(secretVimeo) && !raw.includes(secretAtt) && !raw.includes(secretImg) && !raw.includes(`secret-${T}.mp3`), 'the response text holds none of the locked content');
  assert(!course.items.some((i) => [Lsecret.id, LsecretVid.id, LsecretAudio.id].includes(i.id)), 'legacy items list holds only open lessons');
  assert(course.items.find((i) => i.id === Lwelcome.id)?.youtubeId === 'aaaaaaaaaaa', 'open lessons keep full content (old app builds)');
  assert(course.progress.total === course.lessons.length && course.progress.completed === 0 && course.progress.nextItemId === course.lessons[0].id, 'progress starts at zero; continue = first lesson');
  r = await call(meProgress, req({ method: 'POST', cookie: mem.cookie, query: { id: P.id }, body: { itemId: Lsecret.id } }));
  assert(r.statusCode === 403, 'a locked lesson cannot be marked complete');

  r = await call(meProgram, req({ cookie: other.cookie, query: { id: P.id } }));
  assert(r.statusCode === 403, 'a client who is not a member → 403');
  r = await call(meProgram, req({ cookie: bClient.cookie, query: { id: P.id } }));
  assert(r.statusCode === 403, 'a client of another business → 403');
  r = await call(meProgram, req({ cookie: B.cookie, query: { id: P.id } }));
  assert(r.statusCode === 403, 'another owner → 403');
  r = await call(programById, req({ cookie: B.cookie, query: { id: P.id } }));
  assert(r.statusCode === 404, 'another owner on the owner API → 404');
  r = await call(meProgram, req({ cookie: A.cookie, query: { id: P.id } }));
  assert(r.statusCode === 200 && r.body.role === 'owner' && r.body.lessons.find((l) => l.id === Lsecret.id)?.body === SECRET && !r.body.modules.some((m) => m.locked), 'owner preview sees everything');
  assert(r.body.modules.find((m) => m.id === M2.id).unlockAfterDays === 7, 'owner preview shows the unlock day setting');
  r = await call(programById, req({ cookie: A.cookie, query: { id: P.id } }));
  assert(r.body.items.find((i) => i.id === LsecretVid.id)?.videoEmbedUrl?.includes(secretVimeo), 'owner API returns every lesson in full');

  // Anchor: one function, the enrollment date today.
  const anchor = dripAnchorFor({ granted_at: '2026-01-01T00:00:00Z' }, {});
  assert(anchor.toISOString() === '2026-01-01T00:00:00.000Z' && moduleUnlocksAt({ unlock_after_days: 3 }, anchor).toISOString() === '2026-01-04T00:00:00.000Z', 'dripAnchorFor + moduleUnlocksAt');

  await sql`UPDATE program_enrollments SET granted_at = NOW() - INTERVAL '8 days' WHERE id = ${enrollmentId}`;
  r = await call(meProgram, req({ cookie: mem.cookie, query: { id: P.id } }));
  assert(!r.body.modules.find((m) => m.id === M2.id).locked && r.body.lessons.find((l) => l.id === Lsecret.id)?.body === SECRET, 'after day 7 the module opens with its content');
  await sql`UPDATE program_enrollments SET granted_at = NOW() WHERE id = ${enrollmentId}`;

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] progress: enrolled members, their own record only');
  const prog = (who, body) => call(meProgress, req({ method: 'POST', cookie: who.cookie, query: { id: P.id }, body }));
  r = await prog(mem, { itemId: Lwelcome.id, clientId: other.cid });
  assert(r.statusCode === 200 && r.body.done === true && r.body.progress.completed === 1, 'member marks a lesson complete');
  const rows = (await sql`SELECT client_id, enrollment_id, workspace_id FROM program_progress WHERE item_id = ${Lwelcome.id}`).rows;
  assert(rows.length === 1 && rows[0].client_id === mem.cid && rows[0].enrollment_id === enrollmentId && rows[0].workspace_id === A.wid, 'row is the caller\'s own (a clientId in the body is ignored)');
  r = await prog(mem, { itemId: Lwelcome.id });
  assert(r.statusCode === 200 && r.body.progress.completed === 1, 'marking twice is a no-op');
  r = await call(meProgram, req({ cookie: mem.cookie, query: { id: P.id } }));
  assert(r.body.lessons.find((l) => l.id === Lwelcome.id).completed === true && r.body.progress.nextItemId !== Lwelcome.id, 'check mark shows; continue moves on');
  r = await prog(mem, { itemId: Lwelcome.id, done: false });
  assert(r.statusCode === 200 && r.body.done === false && r.body.progress.completed === 0, 'undo');
  r = await prog(mem, { itemId: Lwelcome.id });
  r = await prog(other, { itemId: Lwelcome.id });
  assert(r.statusCode === 403, 'non-member → 403');
  r = await prog(bClient, { itemId: Lwelcome.id });
  assert(r.statusCode === 403, 'client of another business → 403');
  r = await prog(A, { itemId: Lwelcome.id });
  assert(r.statusCode === 400, 'owner preview cannot save progress');
  r = await call(meProgress, req({ method: 'POST', query: { id: P.id }, body: { itemId: Lwelcome.id } }));
  assert(r.statusCode === 401, 'anonymous → 401');
  r = await call(meProgress, req({ method: 'POST', cookie: mem.cookie, query: { id: P.id }, body: { itemId: Lwelcome.id }, headers: { origin: 'https://evil.example.com' } }));
  assert(r.statusCode === 403, 'cross-origin POST refused');
  r = await add({ type: 'post', title: 'B lesson', body: 'b' }, B, PB.id);
  r = await prog(mem, { itemId: r.body.item.id });
  assert(r.statusCode === 404, "a lesson from another program → 404");
  r = await call(mePrograms, req({ cookie: mem.cookie }));
  const card = r.body.programs.find((p) => p.id === P.id);
  assert(card && card.completedCount === 1 && card.progressPercent === Math.round(100 / card.items), `portal card shows progress (${card?.progressPercent}%)`);
  r = await call(programById, req({ cookie: A.cookie, query: { id: P.id } }));
  const mrow = r.body.members.find((m) => m.clientId === mem.cid);
  assert(mrow.completedCount === 1 && mrow.progressPercent > 0 && !!mrow.lastActivityAt, 'owner sees member progress + last activity');
  assert(r.body.items.find((i) => i.id === Lwelcome.id).completedCount === 1 && r.body.items.find((i) => i.id === Lvimeo.id).completedCount === 0, 'owner sees completions per lesson');
  r = await call(programById, req({ cookie: B.cookie, query: { id: P.id } }));
  assert(r.statusCode === 404, "another owner cannot read A's progress");
  // Access ended → no more progress writes.
  await sql`UPDATE program_enrollments SET status = 'cancelled' WHERE id = ${enrollmentId}`;
  r = await prog(mem, { itemId: Lvimeo.id });
  assert(r.statusCode === 403, 'cancelled member cannot save progress');
  await sql`UPDATE program_enrollments SET status = 'active' WHERE id = ${enrollmentId}`;

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[5] public sales page: outline + free previews only');
  r = await call(programPublic, req({ query: { id: P.id } }));
  assert(r.statusCode === 404, 'draft program has no sales page');
  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: P.id }, body: { status: 'published' } }));
  r = await call(programPublic, req({ query: { id: P.id } }));
  assert(r.statusCode === 200 && r.body.modules.length === 2 && r.body.modules.find((m) => m.id === M2.id).lessons === 3, 'module outline with lesson counts');
  assert(r.body.outline.length === r.body.program.items && r.body.outline.every((o) => o.body === undefined && o.youtubeId === undefined && o.mediaUrl === undefined), 'outline rows are titles only');
  assert(r.body.previews.length === 1 && r.body.previews[0].id === Lpreview.id && r.body.previews[0].body === `PREVIEW-${T}`, 'only the free preview is playable');
  const pub = JSON.stringify(r.body);
  assert(!pub.includes(SECRET) && !pub.includes(`PRIVATE-${T}`) && !pub.includes(secretVimeo) && !pub.includes(secretAtt) && !pub.includes('aaaaaaaaaaa') && !pub.includes('abc123def4'), 'no non-preview content on the sales page');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[6] notifications');
  await settle();
  emails.length = 0;
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { type: 'post', title: `Fresh lesson ${T}`, body: 'new' } }));
  assert(r.statusCode === 201 && r.body.notified === 1, 'new lesson in a published program notifies (default on)');
  const fresh = r.body.item;
  let got = mailsTo(mem.email, /New lesson in/);
  assert(got.length === 1 && got[0].subject.includes(`Fresh lesson ${T}`) && got[0].subject.includes(P.title), 'member gets "New lesson in <program>: <title>"');
  assert(mailsTo(other.email).length === 0 && mailsTo(bClient.email).length === 0, 'non-members get nothing');
  const feed = (await sql`SELECT COUNT(*)::int n FROM notifications WHERE user_id = ${mem.uid} AND tag = ${`program-lesson-${fresh.id}`}`).rows[0].n;
  assert(feed === 1, 'member gets the in-app notification (push channel)');
  r = await notifyNewLesson({ workspaceId: A.wid, programId: P.id, itemId: fresh.id });
  assert(r.sent === 0 && mailsTo(mem.email, /New lesson in/).length === 1, 'sending the same lesson again is deduped');
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { type: 'post', title: 'Quiet', body: 'q', notify: false } }));
  assert(r.statusCode === 201 && mailsTo(mem.email, /Quiet/).length === 0, '"Notify members" off sends nothing');
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { type: 'post', title: `Locked news ${T}`, body: 'l', moduleId: M2.id } }));
  assert(r.statusCode === 201 && mailsTo(mem.email, /Locked news/).length === 0, 'a lesson in a module still locked for the member is not announced yet');
  r = await notifyNewLesson({ workspaceId: B.wid, programId: P.id, itemId: fresh.id });
  assert(r.sent === 0, "another workspace cannot trigger A's announcements");

  // Drip cron: Week 2 opened for the member an hour ago.
  await sql`UPDATE program_enrollments SET granted_at = NOW() - INTERVAL '7 days 1 hour' WHERE id = ${enrollmentId}`;
  emails.length = 0;
  r = await call(dripCron, { method: 'GET', url: '/api/cron/program-drip', headers: {}, query: {} });
  assert(r.statusCode === 401, 'drip cron without the secret → 401');
  r = await call(dripCron, { method: 'GET', url: '/api/cron/program-drip', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} });
  assert(r.statusCode === 200, 'drip cron runs');
  await settle();
  got = mailsTo(mem.email, /is now open/);
  assert(got.length === 1 && got[0].subject.includes('Week 2'), 'member told that Week 2 is open');
  r = await call(dripCron, { method: 'GET', url: '/api/cron/program-drip', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} });
  await settle();
  assert(mailsTo(mem.email, /open/).length === 1, 'running the cron twice sends once');
  assert((await sql`SELECT COUNT(*)::int n FROM program_notifications WHERE dedupe_key = ${`unlock:${M2.id}:${mem.cid}`}`).rows[0].n === 1, 'send recorded once');
  // An unlock long past (e.g. first run after launch) is recorded, not sent late.
  r = await call(programModules, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { title: 'Week 0', unlockAfterDays: 1 } }));
  await add({ type: 'post', title: 'w0', body: 'w0', moduleId: r.body.module.id });
  emails.length = 0;
  r = await runDripNotifications({ workspaceId: A.wid });
  assert(mailsTo(mem.email).length === 0 && r.recordedOnly >= 1, 'a stale unlock is recorded without a late email');

  // Unsubscribe from program emails (one-click link) stops the next one.
  const tok = mintUnsubscribeToken({ scope: 'client', id: mem.cid, type: 'programs' });
  r = await call(unsubscribe, { method: 'POST', url: '/api/unsubscribe', headers: {}, query: { token: tok } });
  assert(r.statusCode === 200, 'unsubscribe link accepted');
  assert((await sql`SELECT notification_prefs FROM clients WHERE id = ${mem.cid}`).rows[0].notification_prefs.programs === false, "client's programs preference switched off");
  emails.length = 0;
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: P.id }, body: { type: 'post', title: 'After unsub', body: 'x' } }));
  assert(mailsTo(mem.email).length === 0, 'no program email after unsubscribing');

  // Owner push when someone joins through a subscription.
  const subClient = await mkClientUser('subscriber', A.wid);
  await sql`UPDATE programs SET billing = 'month', price_cents = 1000 WHERE id = ${P.id}`;
  const sub = { id: `sub_${T}`, status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    metadata: { purpose: 'program', program_id: P.id, client_id: subClient.cid, workspace_id: A.wid } };
  r = await applyProgramSubscription({ workspaceId: A.wid, sub });
  await settle();
  const subEnr = (await sql`SELECT id FROM program_enrollments WHERE stripe_subscription_id = ${sub.id}`).rows[0];
  const ownerFeed = () => sql`SELECT COUNT(*)::int n FROM notifications WHERE user_id = ${A.uid} AND tag = ${`program-join-${subEnr.id}`}`.then((x) => x.rows[0].n);
  assert(r === 'applied' && (await ownerFeed()) === 1, 'owner notified when a subscriber joins');
  await applyProgramSubscription({ workspaceId: A.wid, sub });
  await settle();
  assert((await sql`SELECT read_at FROM notifications WHERE user_id = ${A.uid} AND tag = ${`program-join-${subEnr.id}`}`).rows.length === 1, 'a renewal does not add another join notice');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[7] upload token kinds');
  assert(uploadKind(JSON.stringify({ kind: 'video' })).max === 500 * 1024 * 1024 && uploadKind(JSON.stringify({ kind: 'video' })).types.includes('video/quicktime'), 'video: 500 MB, mov allowed');
  assert(uploadKind(JSON.stringify({ kind: 'audio' })).max === 100 * 1024 * 1024 && uploadKind(JSON.stringify({ kind: 'audio' })).types.includes('audio/mpeg'), 'audio: 100 MB');
  assert(uploadKind(null).max === 25 * 1024 * 1024 && uploadKind(null).types.includes('application/pdf') && !uploadKind(null).types.includes('video/mp4'), 'no kind (older builds): PDFs and images, 25 MB');
  assert(uploadKind('{"kind":"__proto__"}').max === 25 * 1024 * 1024 && uploadKind('not json').max === 25 * 1024 * 1024, 'unknown kind falls back to the default');
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_abc123store_testsecretvalue0000000000';
  const tokenFor = async (kind, pathname = `ws/${A.wid}/programs/x.mp4`) => {
    const res = await call(uploadToken, req({ method: 'POST', cookie: A.cookie, body: { type: 'blob.generate-client-token', payload: { pathname, clientPayload: kind ? JSON.stringify({ kind }) : null, multipart: true } } }));
    if (!res.body?.clientToken) return { status: res.statusCode };
    const enc = res.body.clientToken.split('_')[4];
    return { status: res.statusCode, payload: JSON.parse(Buffer.from(Buffer.from(enc, 'base64').toString().split('.')[1], 'base64').toString()) };
  };
  let t = await tokenFor('video');
  assert(t.status === 200 && t.payload.maximumSizeInBytes === 500 * 1024 * 1024 && t.payload.allowedContentTypes.includes('video/mp4'), 'video token: 500 MB, mp4');
  t = await tokenFor(null);
  assert(t.status === 200 && t.payload.maximumSizeInBytes === 25 * 1024 * 1024, 'default token unchanged');
  t = await tokenFor('video', `ws/${B.wid}/programs/x.mp4`);
  assert(t.status === 400, "token for another workspace's folder still refused");

  // ── cleanup ──────────────────────────────────────────────────────────
  await sql.query('DELETE FROM workspaces WHERE id = ANY($1)', [workspaces]);
  await sql.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

// Programs as courses: modules, lesson content (video links, uploads,
// audio, images, attachments), drip, progress and the member / public
// views built from them. Shared by the owner API (api/programs/**), the
// member API (api/me/programs/**), the public sales page and the drip
// cron.
//
// Security model (see the comment on buildCourse): a member only ever
// receives the content of lessons that are unlocked for them; a locked
// lesson travels as an outline row (id, type, title, module, unlocksAt)
// with no body, file, media, video id, images or attachments.
import { sql } from './db.js';
import { blobPathnameForWorkspace } from './blobScope.js';
import { parseYouTubeId, serializeItem } from './programs.js';

export const MAX_IMAGES = 10;
export const MAX_ATTACHMENTS = 5;
export const VIDEO_PROVIDERS = new Set(['youtube', 'vimeo', 'loom', 'upload']);

// ── video links ─────────────────────────────────────────────────────
// Returns { provider, ref, youtubeId } or null. Only https links on the
// three known hosts are accepted; a bare 11-character YouTube id still
// works (older builder versions sent just the id).
export function parseVideoLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { provider: 'youtube', ref: s, youtubeId: s };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (/^(?:www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) {
    const id = parseYouTubeId(s);
    return id ? { provider: 'youtube', ref: id, youtubeId: id } : null;
  }
  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    // player.vimeo.com/video/<id>?h=<hash> | vimeo.com/<id>[/<hash>] | vimeo.com/channels/x/<id>
    let id = null; let hash = u.searchParams.get('h') || null;
    if (host === 'player.vimeo.com') { if (parts[0] === 'video' && /^\d{4,12}$/.test(parts[1] || '')) id = parts[1]; }
    else {
      const idx = parts.findIndex((p) => /^\d{4,12}$/.test(p));
      if (idx >= 0) { id = parts[idx]; if (!hash && parts[idx + 1] && /^[0-9a-f]{6,20}$/i.test(parts[idx + 1])) hash = parts[idx + 1]; }
    }
    if (!id) return null;
    if (hash && !/^[0-9a-f]{6,20}$/i.test(hash)) hash = null;
    return { provider: 'vimeo', ref: hash ? `${id}:${hash}` : id, youtubeId: null };
  }
  if (host === 'loom.com' || host === 'www.loom.com') {
    const m = u.pathname.match(/^\/(?:share|embed)\/([0-9a-f]{32})(?:[/?#]|$)/i);
    return m ? { provider: 'loom', ref: m[1].toLowerCase(), youtubeId: null } : null;
  }
  return null;
}

// Privacy-friendly embed URL for a stored provider + ref. Built only from
// validated refs, so the client can put it straight into an iframe.
export function videoEmbedUrl(provider, ref) {
  if (!ref) return null;
  if (provider === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(ref)) return `https://www.youtube-nocookie.com/embed/${ref}?rel=0&modestbranding=1&playsinline=1`;
  if (provider === 'vimeo') {
    const [id, hash] = String(ref).split(':');
    if (!/^\d{4,12}$/.test(id)) return null;
    return `https://player.vimeo.com/video/${id}?dnt=1&title=0&byline=0&portrait=0${hash && /^[0-9a-f]{6,20}$/i.test(hash) ? `&h=${hash}` : ''}`;
  }
  if (provider === 'loom' && /^[0-9a-f]{32}$/.test(ref)) return `https://www.loom.com/embed/${ref}?hide_owner=true&hide_share=true&hide_title=true&hideEmbedTopBar=true`;
  return null;
}

// A link the owner can paste back into the editor.
export function videoShareUrl(provider, ref) {
  if (!ref) return '';
  if (provider === 'youtube') return `https://youtu.be/${ref}`;
  if (provider === 'vimeo') { const [id, hash] = String(ref).split(':'); return `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`; }
  if (provider === 'loom') return `https://www.loom.com/share/${ref}`;
  return '';
}

// ── uploaded files ──────────────────────────────────────────────────
// An uploaded file must live on Blob storage under THIS workspace's
// prefix (ws/<workspaceId>/), so a lesson can never point at someone
// else's file or an arbitrary host.
export function ownBlobUrl(url, workspaceId) {
  const s = String(url || '').trim();
  if (!/^https:\/\//i.test(s) || s.length > 1000) return null;
  return blobPathnameForWorkspace(s, workspaceId) ? s : null;
}
const cleanName = (n, fallback) => String(n || fallback).replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) || fallback;

function cleanFileList(list, workspaceId, max, label, kind) {
  if (list == null) return { value: [] };
  if (!Array.isArray(list)) return { error: `${label} must be a list.` };
  if (list.length > max) return { error: `Up to ${max} ${label.toLowerCase()} per lesson.` };
  const out = [];
  for (const f of list) {
    const url = ownBlobUrl(f?.url, workspaceId);
    if (!url) return { error: `Upload the ${kind} through Ivy first.` };
    const size = Number(f?.size);
    out.push({ url, name: cleanName(f?.name, kind === 'image' ? 'Image' : 'File'), ...(Number.isFinite(size) && size > 0 ? { size: Math.round(size) } : {}) });
  }
  return { value: out };
}

// Validates and normalises a lesson. `type` is fixed by the caller (an
// edit never changes it). Returns { value } (DB column names) or { error }.
export function cleanLesson(body, type, workspaceId) {
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) return { error: 'Give it a title.' };
  const out = {
    title, body: String(body.body || '').slice(0, 100_000), file_url: null, file_name: null, youtube_id: null,
    video_provider: null, video_ref: null, media_url: null, media_name: null, images: [], attachments: [], is_preview: !!body.isPreview,
  };
  if (type === 'pdf') {
    const url = String(body.fileUrl || '');
    if (!/^https:\/\/[^ ]+\.(public\.blob\.vercel-storage\.com|blob\.vercel-storage\.com)\//.test(url)) return { error: 'Upload the PDF first.' };
    out.file_url = url; out.file_name = cleanName(body.fileName, 'document.pdf');
  }
  if (type === 'video') {
    if (body.mediaUrl) {
      const url = ownBlobUrl(body.mediaUrl, workspaceId);
      if (!url) return { error: 'Upload the video through Ivy first.' };
      out.video_provider = 'upload'; out.media_url = url; out.media_name = cleanName(body.mediaName, 'video');
    } else {
      const link = parseVideoLink(body.videoUrl || body.youtube);
      if (!link) return { error: 'Paste a YouTube, Vimeo or Loom link (https), or upload a video file.' };
      out.video_provider = link.provider; out.video_ref = link.ref; out.youtube_id = link.youtubeId;
    }
  }
  if (type === 'audio') {
    const url = ownBlobUrl(body.mediaUrl, workspaceId);
    if (!url) return { error: 'Upload the audio file first.' };
    out.media_url = url; out.media_name = cleanName(body.mediaName, 'audio');
  }
  const imgs = cleanFileList(body.images, workspaceId, MAX_IMAGES, 'Images', 'image');
  if (imgs.error) return { error: imgs.error };
  const atts = cleanFileList(body.attachments, workspaceId, MAX_ATTACHMENTS, 'Attachments', 'file');
  if (atts.error) return { error: atts.error };
  out.images = imgs.value; out.attachments = atts.value;
  if (type === 'post' && !out.body.trim()) return { error: 'Write something in the post.' };
  return { value: out };
}

// The editable shape of a stored lesson, so a PATCH can merge onto it.
export function lessonInputFromRow(it) {
  return {
    title: it.title, body: it.body, fileUrl: it.file_url, fileName: it.file_name,
    mediaUrl: it.video_provider === 'upload' || it.type === 'audio' ? it.media_url : null, mediaName: it.media_name,
    videoUrl: it.video_provider && it.video_provider !== 'upload' ? videoShareUrl(it.video_provider, it.video_ref) : (it.youtube_id ? `https://youtu.be/${it.youtube_id}` : ''),
    images: Array.isArray(it.images) ? it.images : [], attachments: Array.isArray(it.attachments) ? it.attachments : [], isPreview: !!it.is_preview,
  };
}

// Full lesson (owner, unlocked member, public preview). Keeps every field
// serializeItem already sends (old app builds read those).
export function serializeLesson(r) {
  const provider = r.video_provider || (r.youtube_id ? 'youtube' : null);
  const ref = r.video_ref || r.youtube_id || null;
  return {
    ...serializeItem(r),
    moduleId: r.module_id || null,
    videoProvider: r.type === 'video' ? provider : null,
    videoUrl: r.type === 'video' && provider && provider !== 'upload' ? videoShareUrl(provider, ref) : null,
    videoEmbedUrl: r.type === 'video' && provider && provider !== 'upload' ? videoEmbedUrl(provider, ref) : null,
    mediaUrl: r.media_url || null, mediaName: r.media_name || null,
    images: Array.isArray(r.images) ? r.images : [],
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    isPreview: !!r.is_preview, locked: false,
  };
}

// What a member may know about a lesson they cannot open yet.
export function lessonOutline(r, extra = {}) {
  return { id: r.id, type: r.type, title: r.title, moduleId: r.module_id || null, position: r.position, isPreview: !!r.is_preview, ...extra };
}

export function serializeModule(m, extra = {}) {
  return {
    id: m.id, title: m.title, description: m.description || '', position: m.position,
    unlockAfterDays: m.unlock_after_days == null ? null : Number(m.unlock_after_days),
    availableBeforeStart: !!m.available_before_start, ...extra,
  };
}

export function cleanModuleInput(body, partial = false) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const t = String(body.title || '').trim();
    if (!t) return { error: 'Give the module a title.' };
    if (t.length > 140) return { error: 'Title is too long (140 characters max).' };
    out.title = t;
  }
  if (!partial || body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 2000);
  if (!partial || body.unlockAfterDays !== undefined) {
    const raw = body.unlockAfterDays;
    const d = raw == null || raw === '' ? null : Math.round(Number(raw));
    if (d != null && (!Number.isFinite(d) || d < 0 || d > 3650)) return { error: 'Unlock day must be between 0 and 3650, or blank to open right away.' };
    out.unlock_after_days = d === 0 ? null : d;
  }
  if (!partial || body.availableBeforeStart !== undefined) out.available_before_start = !!body.availableBeforeStart;
  return { value: out };
}

// ── loading ─────────────────────────────────────────────────────────
export async function loadModules(programId, workspaceId) {
  return (await sql`SELECT * FROM program_modules WHERE program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
                    ORDER BY position ASC, created_at ASC`).rows;
}
export async function loadLessons(programId, workspaceId) {
  return (await sql`SELECT * FROM program_items WHERE program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
                    ORDER BY position ASC, created_at ASC`).rows;
}

// Course order: lessons outside any module first (that is where every
// lesson of an older program lives), then each module's lessons in turn.
export function courseOrder(modules, items) {
  const live = new Set(modules.map((m) => m.id));
  const top = items.filter((i) => !i.module_id || !live.has(i.module_id));
  const out = [...top];
  for (const m of modules) out.push(...items.filter((i) => i.module_id === m.id));
  return out;
}

// ── drip ────────────────────────────────────────────────────────────
// THE anchor for drip schedules: when the member got access, or for a
// cohort program the start of the member's cohort (memberEnrollment and
// the drip cron attach cohort_starts_at to the enrollment row). Every
// unlock date in the product goes through this one function.
export function dripAnchorFor(enrollment, program) {
  if (program?.delivery === 'cohort' && enrollment?.cohort_starts_at) {
    const c = new Date(enrollment.cohort_starts_at);
    if (!Number.isNaN(c.getTime())) return c;
  }
  const t = enrollment?.granted_at ? new Date(enrollment.granted_at) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}
// Cohort programs: nothing opens before the cohort starts except modules
// the owner marked "available before start". Null for evergreen programs
// (and for a member who is not in a cohort).
export function courseGateFor(enrollment, program) {
  if (program?.delivery !== 'cohort' || !enrollment?.cohort_starts_at) return null;
  const c = new Date(enrollment.cohort_starts_at);
  return Number.isNaN(c.getTime()) ? null : c;
}
export function moduleUnlocksAt(module, anchor) {
  const days = Number(module?.unlock_after_days || 0);
  if (!days || !anchor) return null;
  return new Date(anchor.getTime() + days * 86400_000);
}
export function isModuleOpen(module, anchor, now = new Date()) {
  if (!module) return true;
  const at = moduleUnlocksAt(module, anchor);
  return !at || at.getTime() <= now.getTime();
}
// When a lesson (in `module`, or top level when null) opens for a member:
// null = open now. Combines the cohort gate with the module's drip day.
export function lessonUnlocksAt(module, { anchor, gate, now = new Date() }) {
  if (module?.available_before_start && gate) return null;
  const dripAt = module ? moduleUnlocksAt(module, anchor) : null;
  const at = gate && (!dripAt || gate.getTime() > dripAt.getTime()) ? gate : dripAt;
  return at && at.getTime() > now.getTime() ? at : null;
}

// The member's active enrollment for a program (the one access rides on),
// with its cohort's name and start when the member is in one.
export async function memberEnrollment(programId, clientId) {
  if (!clientId) return null;
  return (await sql`
    SELECT e.*, c.name AS cohort_name, c.starts_at AS cohort_starts_at, c.start_date::text AS cohort_start_date
      FROM program_enrollments e
      LEFT JOIN program_cohorts c ON c.id = e.cohort_id AND c.program_id = e.program_id AND c.deleted_at IS NULL
     WHERE e.program_id = ${programId} AND e.client_id = ${clientId} AND e.status IN ('active','past_due')
       AND (e.expires_at IS NULL OR e.expires_at > NOW())
     ORDER BY e.granted_at ASC LIMIT 1`).rows[0] || null;
}

// Whether one lesson is open for a member right now.
export async function lessonOpenForMember({ program, item, enrollment, now = new Date() }) {
  const gate = courseGateFor(enrollment, program);
  const m = item.module_id
    ? (await sql`SELECT * FROM program_modules WHERE id = ${item.module_id} AND program_id = ${program.id} AND deleted_at IS NULL`).rows[0] || null
    : null;
  return !lessonUnlocksAt(m, { anchor: dripAnchorFor(enrollment, program), gate, now });
}

// ── progress ────────────────────────────────────────────────────────
export async function completedItemIds(programId, clientId) {
  if (!clientId) return new Set();
  const r = await sql`SELECT item_id FROM program_progress WHERE program_id = ${programId} AND client_id = ${clientId}`;
  return new Set(r.rows.map((x) => x.item_id));
}

// ── the course a viewer sees ────────────────────────────────────────
// role 'owner' sees everything. role 'member' gets full content only for
// lessons in open modules; locked lessons go out as outline rows. The
// legacy `items` field (read by the iPhone app already in the store)
// holds only the lessons the viewer may open, in course order.
export function buildCourse({ program, modules, items, role, enrollment = null, completed = new Set(), now = new Date() }) {
  const owner = role === 'owner';
  const anchor = owner ? null : dripAnchorFor(enrollment, program);
  const gate = owner ? null : courseGateFor(enrollment, program);
  const byId = new Map(modules.map((m) => [m.id, m]));
  const modOut = modules.map((m) => {
    const drip = owner ? null : moduleUnlocksAt(m, anchor);
    const at = owner ? null : lessonUnlocksAt(m, { anchor, gate, now });
    return serializeModule(m, { unlocksAt: (at || drip) ? (at || drip).toISOString() : null, locked: !!at });
  });
  const lockedMods = new Set(modOut.filter((m) => m.locked).map((m) => m.id));
  // Cohort not started yet: top-level lessons wait for the start too.
  const topLockedUntil = owner ? null : lessonUnlocksAt(null, { anchor, gate, now });
  const ordered = courseOrder(modules, items);
  const lessons = ordered.map((it) => {
    const modId = it.module_id && byId.has(it.module_id) ? it.module_id : null;
    if (modId && lockedMods.has(modId)) {
      const mod = modOut.find((m) => m.id === modId);
      return lessonOutline(it, { moduleId: modId, locked: true, unlocksAt: mod.unlocksAt, completed: false });
    }
    if (!modId && topLockedUntil) {
      return lessonOutline(it, { moduleId: null, locked: true, unlocksAt: topLockedUntil.toISOString(), completed: false });
    }
    return { ...serializeLesson(it), moduleId: modId, completed: completed.has(it.id) };
  });
  const total = lessons.length;
  const done = lessons.filter((l) => l.completed).length;
  const next = lessons.find((l) => !l.locked && !l.completed) || null;
  return {
    modules: modOut,
    lessons,
    items: lessons.filter((l) => !l.locked),
    progress: { completed: done, total, percent: total ? Math.round((done / total) * 100) : 0, nextItemId: next?.id || null },
  };
}

// Progress summary for one member of one program (portal list cards).
export async function progressFor(programIds, clientIds) {
  if (!programIds.length || !clientIds.length) return new Map();
  const r = await sql.query(
    `SELECT p.program_id, COUNT(*)::int AS n FROM program_progress p
       JOIN program_items i ON i.id = p.item_id AND i.deleted_at IS NULL
      WHERE p.program_id = ANY($1) AND p.client_id = ANY($2)
      GROUP BY p.program_id`, [programIds, clientIds]);
  return new Map(r.rows.map((x) => [x.program_id, x.n]));
}

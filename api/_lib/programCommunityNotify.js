// Notifications for the program community and live sessions.
//
// Every notification is a row in program_community_notices, unique on
// (kind, ref_id, recipient_key). Inserting with ON CONFLICT DO NOTHING and
// acting only on the rows that came back is what makes each one fire ONCE,
// however often a post is edited or the cron runs.
//
//   push   immediate, for every new row (preference-gated in push.js)
//   email  preference-gated (sendEmailToClient / sendEmailToUser):
//          reply + mention (kinds tied to a post thread) are batched so one
//          person gets at most one email per thread per hour; what is held
//          back is sent by api/cron/program-events.js once the hour is up.
//          Everything else is emailed right away (a request sends up to
//          EMAIL_CAP_PER_REQUEST, the cron picks up the rest).
//
// Kinds: reply, mention, announcement (ref = post), event_24h, event_1h,
// recording, event_cancelled (ref = program_events.id).
import { sql } from './db.js';
import { notifyClientSafe, notifyOwnerSafe } from './push.js';
import { sendEmailToClient, sendEmailToUser, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { workspaceTimeZone } from './calendar.js';
import { appUrl } from './tokens.js';

export const THREAD_KINDS = new Set(['reply', 'mention']);
export const EVENT_KINDS = new Set(['event_24h', 'event_1h', 'recording', 'event_cancelled']);
const EMAIL_CAP_PER_REQUEST = 40;
const STALE_AFTER_HOURS = 72;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const snippet = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ── recipients ───────────────────────────────────────────────────────
// key 'owner' → the workspace owner; any other key is a clients.id that
// must belong to the program's workspace.
export async function resolveRecipients(program, keys) {
  const out = [];
  const uniq = [...new Set(keys.filter(Boolean))];
  if (uniq.includes('owner')) {
    const o = (await sql`SELECT w.owner_id FROM workspaces w JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL WHERE w.id = ${program.workspace_id}`).rows[0];
    if (o) out.push({ key: 'owner', userId: o.owner_id, clientId: null });
  }
  const clientKeys = uniq.filter((k) => k !== 'owner');
  if (clientKeys.length) {
    const { rows } = await sql.query(
      `SELECT id, user_id FROM clients WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [program.workspace_id, clientKeys],
    );
    for (const r of rows) out.push({ key: r.id, userId: r.user_id || null, clientId: r.id });
  }
  return out;
}

// Inserts notices; returns ONLY the rows that are new.
export async function recordNotices({ program, kind, refId, threadId = null, recipients }) {
  if (!recipients.length) return [];
  const { rows } = await sql.query(
    `INSERT INTO program_community_notices (workspace_id, program_id, kind, ref_id, thread_id, recipient_key, recipient_user_id, recipient_client_id)
     SELECT $1, $2, $3, $4, $5, r.key, r.uid, r.cid
       FROM unnest($6::text[], $7::uuid[], $8::uuid[]) AS r(key, uid, cid)
     ON CONFLICT (kind, ref_id, recipient_key) DO NOTHING
     RETURNING *`,
    [program.workspace_id, program.id, kind, refId, threadId,
      recipients.map((r) => r.key), recipients.map((r) => r.userId || null), recipients.map((r) => r.clientId || null)],
  );
  return rows;
}

// ── content ──────────────────────────────────────────────────────────
function fmtWhen(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
  } catch { return new Date(iso).toUTCString(); }
}

async function loadContext(cache, programId) {
  const k = `p:${programId}`;
  if (!cache.has(k)) {
    const program = (await sql`SELECT * FROM programs WHERE id = ${programId}`).rows[0];
    const branding = program ? await fetchBranding(program.workspace_id) : null;
    const tz = program ? await workspaceTimeZone(program.workspace_id) : 'UTC';
    cache.set(k, { program, branding, tz });
  }
  return cache.get(k);
}
async function loadPost(cache, id) {
  const k = `post:${id}`;
  if (!cache.has(k)) {
    const row = (await sql`
      SELECT p.*, COALESCE(mp.display_name, p.author_name) AS shown_name
        FROM program_posts p LEFT JOIN program_member_profiles mp ON mp.workspace_id = p.workspace_id AND mp.user_id = p.author_user_id
       WHERE p.id = ${id}`).rows[0] || null;
    cache.set(k, row);
  }
  return cache.get(k);
}
async function loadEvent(cache, id) {
  const k = `ev:${id}`;
  if (!cache.has(k)) cache.set(k, (await sql`SELECT * FROM program_events WHERE id = ${id}`).rows[0] || null);
  return cache.get(k);
}

const linkFor = (n, programId) => (n.recipient_key === 'owner' ? '/programs' : `/me/programs/${programId}`);

// Push payload + type for one notice (null = nothing to say any more,
// e.g. the post was removed before the cron got to it).
async function pushFor(n, cache) {
  const { program } = await loadContext(cache, n.program_id);
  if (!program) return null;
  const url = linkFor(n, program.id);
  if (THREAD_KINDS.has(n.kind) || n.kind === 'announcement') {
    const post = await loadPost(cache, n.ref_id);
    if (!post || post.deleted_at) return null;
    const who = post.shown_name || 'Someone';
    const title = n.kind === 'reply' ? `${who} replied to your post`
      : n.kind === 'mention' ? `${who} mentioned you`
      : `New announcement in ${program.title}`;
    const tag = n.kind === 'announcement' ? `program-announcement-${post.id}` : `program-thread-${n.thread_id || post.id}`;
    return { type: 'messages', payload: { title, body: snippet(post.body, 120) || program.title, url, tag } };
  }
  if (EVENT_KINDS.has(n.kind)) {
    const ev = await loadEvent(cache, n.ref_id);
    if (!ev) return null;
    const { tz } = await loadContext(cache, n.program_id);
    const when = fmtWhen(ev.starts_at, tz);
    const map = {
      event_24h: [`Coming up: ${ev.title}`, `${when}. ${program.title}`],
      event_1h: [`Starting within the hour: ${ev.title}`, `${when}. The join link opens 15 minutes before.`],
      recording: [`Recording is up: ${ev.title}`, `Watch it any time in ${program.title}.`],
      event_cancelled: [`Cancelled: ${ev.title}`, `The live session on ${when} is not happening.`],
    };
    const [title, body] = map[n.kind];
    return { type: 'bookings', payload: { title, body, url, tag: `program-event-${n.kind}-${ev.id}` } };
  }
  return null;
}

async function sendPush(n, cache) {
  const p = await pushFor(n, cache);
  if (!p) return;
  if (n.recipient_key === 'owner') await notifyOwnerSafe({ workspaceId: n.workspace_id, type: p.type, payload: p.payload });
  else if (n.recipient_client_id) await notifyClientSafe({ clientId: n.recipient_client_id, type: p.type, payload: p.payload });
}

async function recipientEmail(n) {
  if (n.recipient_key === 'owner') {
    const r = (await sql`SELECT u.id, u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL WHERE w.id = ${n.workspace_id}`).rows[0];
    return r?.email ? { owner: true, userId: r.id, email: r.email, name: r.name } : null;
  }
  const c = (await sql`SELECT id, email, name FROM clients WHERE id = ${n.recipient_client_id} AND workspace_id = ${n.workspace_id}`).rows[0];
  return c?.email ? { owner: false, clientId: c.id, email: c.email, name: c.name } : null;
}

async function sendMail(to, { type, subject, heading, body, ctaText, ctaUrl, branding }) {
  const html = emailShell({ heading, body, ctaText, ctaUrl, branding: to.owner ? undefined : branding });
  if (to.owner) return sendEmailToUser({ userId: to.userId, type, to: to.email, subject, html });
  return sendEmailToClient({ clientId: to.clientId, type, to: to.email, subject, html, replyTo: branding?.replyTo || undefined });
}

// One email for a batch of reply/mention notices of the same thread.
async function emailThread(notices, cache) {
  const first = notices[0];
  const { program, branding } = await loadContext(cache, first.program_id);
  if (!program) return;
  const to = await recipientEmail(first);
  if (!to) return;
  const items = [];
  for (const n of notices) {
    const post = await loadPost(cache, n.ref_id);
    if (!post || post.deleted_at) continue;
    items.push({ who: post.shown_name || 'Someone', what: n.kind === 'mention' ? 'mentioned you' : 'replied', text: snippet(post.body, 280) });
  }
  if (!items.length) return;
  const root = first.thread_id ? await loadPost(cache, first.thread_id) : null;
  const subject = items.length === 1
    ? `${items[0].who} ${items[0].what === 'replied' ? 'replied to your post' : 'mentioned you'} in ${program.title}`
    : `${items.length} new replies and mentions in ${program.title}`;
  const list = items.slice(0, 8).map((i) => `<p><strong>${esc(i.who)}</strong> ${esc(i.what)}:<br/>${esc(i.text)}</p>`).join('');
  await sendMail(to, {
    type: 'messages', subject, branding,
    heading: items.length === 1 ? subject : `New activity in ${program.title}`,
    body: `${root ? `<p style="opacity:.8">On: "${esc(snippet(root.body, 120))}"</p>` : ''}${list}${items.length > 8 ? `<p>And ${items.length - 8} more.</p>` : ''}`,
    ctaText: 'Open the community', ctaUrl: `${appUrl()}${linkFor(first, program.id)}`,
  });
}

async function emailSingle(n, cache) {
  const { program, branding, tz } = await loadContext(cache, n.program_id);
  if (!program) return;
  const to = await recipientEmail(n);
  if (!to) return;
  const ctaUrl = `${appUrl()}${linkFor(n, program.id)}`;
  const biz = branding?.businessName || 'Your coach';
  if (n.kind === 'announcement') {
    const post = await loadPost(cache, n.ref_id);
    if (!post || post.deleted_at) return;
    await sendMail(to, {
      type: 'messages', branding, subject: `New announcement in ${program.title}`,
      heading: `${biz} posted an announcement`,
      body: `<p>${esc(snippet(post.body, 1500)).replace(/\n/g, '<br/>')}</p>`,
      ctaText: 'Open the program', ctaUrl,
    });
    return;
  }
  if (EVENT_KINDS.has(n.kind)) {
    const ev = await loadEvent(cache, n.ref_id);
    if (!ev) return;
    const when = fmtWhen(ev.starts_at, tz);
    const where = ev.location_type === 'in_person' ? (ev.location_text ? `<p>Where: ${esc(ev.location_text)}</p>` : '')
      : '<p>The join link shows on the program page from 15 minutes before the start.</p>';
    const copy = {
      event_24h: { subject: `Coming up: ${ev.title}`, heading: `${ev.title} is coming up`, body: `<p>${esc(when)}</p>${where}` },
      event_1h: { subject: `Starting soon: ${ev.title}`, heading: `${ev.title} starts within the hour`, body: `<p>${esc(when)}</p>${where}` },
      recording: { subject: `Recording is up: ${ev.title}`, heading: 'The recording is up', body: `<p>The recording of <strong>${esc(ev.title)}</strong> (${esc(when)}) is ready to watch in ${esc(program.title)}.</p>` },
      event_cancelled: { subject: `Cancelled: ${ev.title}`, heading: 'Live session cancelled', body: `<p><strong>${esc(ev.title)}</strong> on ${esc(when)} has been cancelled.</p>` },
    }[n.kind];
    await sendMail(to, { type: 'bookings', branding, ...copy, ctaText: 'Open the program', ctaUrl });
  }
}

// Claims (marks done) before sending, so a request and the cron can never
// both email the same notice.
async function claimSingle(id) {
  const r = await sql`UPDATE program_community_notices SET email_done = TRUE, email_sent_at = NOW() WHERE id = ${id} AND email_done = FALSE RETURNING *`;
  return r.rows[0] || null;
}
async function claimThread(recipientKey, threadId) {
  const { rows } = await sql`
    UPDATE program_community_notices n SET email_done = TRUE, email_sent_at = NOW()
     WHERE n.recipient_key = ${recipientKey} AND n.thread_id = ${threadId}
       AND n.kind IN ('reply', 'mention') AND n.email_done = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM program_community_notices x
          WHERE x.recipient_key = ${recipientKey} AND x.thread_id = ${threadId}
            AND x.email_sent_at > NOW() - INTERVAL '1 hour')
     RETURNING *`;
  return rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function emailNotices(notices, cache, cap) {
  let sent = 0;
  const threads = new Map();
  for (const n of notices) {
    if (THREAD_KINDS.has(n.kind) && n.thread_id) {
      const k = `${n.recipient_key}|${n.thread_id}`;
      if (!threads.has(k)) threads.set(k, n);
      continue;
    }
    if (sent >= cap) break;
    const claimed = await claimSingle(n.id);
    if (!claimed) continue;
    try { await emailSingle(claimed, cache); sent++; } catch (e) { console.warn('[programCommunityNotify] email failed:', e.message); }
  }
  for (const n of threads.values()) {
    if (sent >= cap) break;
    const batch = await claimThread(n.recipient_key, n.thread_id);
    if (!batch.length) continue; // emailed within the hour: held for the cron
    try { await emailThread(batch, cache); sent++; } catch (e) { console.warn('[programCommunityNotify] thread email failed:', e.message); }
  }
  return sent;
}

// Push every new notice now, email what policy allows now.
export async function deliverNotices(notices, { cap = EMAIL_CAP_PER_REQUEST } = {}) {
  if (!notices.length) return { pushed: 0, emailed: 0 };
  const cache = new Map();
  for (const n of notices) {
    try { await sendPush(n, cache); } catch (e) { console.warn('[programCommunityNotify] push failed:', e.message); }
  }
  const emailed = await emailNotices(notices, cache, cap);
  return { pushed: notices.length, emailed };
}

export async function notify({ program, kind, refId, threadId = null, keys }) {
  const recipients = await resolveRecipients(program, keys);
  const fresh = await recordNotices({ program, kind, refId, threadId, recipients });
  return deliverNotices(fresh);
}

// ── community events ─────────────────────────────────────────────────
// A post or reply was created (or edited, for new mentions). `root` is the
// top-level post when `post` is a reply.
export async function notifyPostActivity({ program, post, root = null, authorKey, mentions = [], isNew = true, activeMemberKeys = null }) {
  const out = { reply: 0, mention: 0, announcement: 0 };
  const threadId = root ? root.id : post.id;
  const mentionKeys = new Set(mentions.map((m) => m.key).filter((k) => k !== authorKey));
  if (post.is_announcement && isNew) {
    const everyone = (activeMemberKeys || []).filter((k) => k !== authorKey);
    const r = await notify({ program, kind: 'announcement', refId: post.id, keys: everyone });
    out.announcement = r.pushed;
    for (const k of everyone) mentionKeys.delete(k); // one notification per person per event
  }
  if (isNew && root) {
    const rootKey = root.is_owner ? 'owner' : root.author_client_id;
    if (rootKey && rootKey !== authorKey && !mentionKeys.has(rootKey)) {
      const r = await notify({ program, kind: 'reply', refId: post.id, threadId, keys: [rootKey] });
      out.reply = r.pushed;
    }
  }
  if (mentionKeys.size) {
    const r = await notify({ program, kind: 'mention', refId: post.id, threadId, keys: [...mentionKeys] });
    out.mention = r.pushed;
  }
  return out;
}

// The owner hears about every new question right away (push only).
export async function notifyOwnerOfQuestion({ program, post, authorName }) {
  await notifyOwnerSafe({
    workspaceId: program.workspace_id, type: 'messages',
    payload: { title: `New question in ${program.title}`, body: `${authorName}: ${snippet(post.body, 120)}`, url: '/programs', tag: `program-question-${post.id}` },
  });
}

export async function notifyOwnerOfLessonComment({ program, post, authorName, itemTitle }) {
  await notifyOwnerSafe({
    workspaceId: program.workspace_id, type: 'messages',
    payload: { title: `New comment on ${itemTitle || 'a lesson'}`, body: `${authorName}: ${snippet(post.body, 120)}`, url: '/programs', tag: `program-comment-${post.id}` },
  });
}

export async function notifyOwnerOfReport({ program }) {
  await notifyOwnerSafe({
    workspaceId: program.workspace_id, type: 'messages',
    payload: { title: 'A post was reported', body: `Someone in ${program.title} reported a post. Take a look in the community.`, url: '/programs', tag: `program-report-${program.id}` },
  });
}

// ── cron: anything held back or over the per-request cap ─────────────
export async function flushPendingEmails({ limit = 300 } = {}) {
  await sql`UPDATE program_community_notices SET email_done = TRUE
             WHERE email_done = FALSE AND created_at < NOW() - (${STALE_AFTER_HOURS} || ' hours')::interval`;
  const { rows } = await sql`
    SELECT * FROM program_community_notices WHERE email_done = FALSE ORDER BY created_at ASC LIMIT ${limit}`;
  const cache = new Map();
  return emailNotices(rows, cache, limit);
}

// Program notifications to members and owners.
//
//   notifyNewLesson      owner added a lesson to a published program and
//                        left "Notify members" on: one email + one push to
//                        every member who can open it right now.
//   runDripNotifications daily cron: a dripped module opened for a member
//                        today. One email + push per member per program
//                        (several modules opening the same day share it).
//   notifyOwnerProgramJoin  owner push when someone starts a subscription
//                        program (one-time purchases already push
//                        "Program sold" from checkout fulfillment).
//
// Every member send is claimed first in program_notifications (unique
// dedupe_key), so a retried request or a second cron run never sends the
// same news twice. Emails use the client 'programs' type, so a member can
// switch them off (and the one-click unsubscribe link handles it).
import { sql } from './db.js';
import { withTimeout } from './timeBudget.js';
import { sendEmailToClient, emailShell } from './email.js';
import { notifyClientSafe, notifyOwnerSafe } from './push.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { dripAnchorFor, moduleUnlocksAt, lessonUnlocksAt, courseGateFor } from './programCourse.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const DRIP_WINDOW_MS = 48 * 3600_000;

// Claims a send. True only for the first caller with this key.
async function claim({ workspaceId, programId, clientId, kind, refId }) {
  const key = `${kind}:${refId}:${clientId}`;
  const r = await sql`
    INSERT INTO program_notifications (workspace_id, program_id, client_id, kind, ref_id, dedupe_key)
    VALUES (${workspaceId}, ${programId}, ${clientId}, ${kind}, ${refId}, ${key})
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
  return r.rows.length > 0;
}

async function activeMembers(programId, workspaceId) {
  return (await sql`
    SELECT DISTINCT ON (e.client_id) e.*, c.name AS client_name, c.email AS client_email, co.starts_at AS cohort_starts_at
      FROM program_enrollments e
      JOIN clients c ON c.id = e.client_id AND c.workspace_id = e.workspace_id
      LEFT JOIN program_cohorts co ON co.id = e.cohort_id AND co.deleted_at IS NULL
     WHERE e.program_id = ${programId} AND e.workspace_id = ${workspaceId}
       AND e.status IN ('active','past_due') AND (e.expires_at IS NULL OR e.expires_at > NOW())
     ORDER BY e.client_id, e.granted_at ASC`).rows;
}

// Small worker pool so a big program does not send hundreds of requests at once.
async function eachLimited(list, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const x = list[i++]; await fn(x); }  
  });
  await Promise.all(workers);
}

async function sendMember({ member, subject, heading, bodyHtml, ctaText, path, push, branding }) {
  if (member.client_email) {
    const html = emailShell({ heading, branding, body: bodyHtml, ctaText, ctaUrl: `${appUrl()}${path}`, preheader: subject,
      footer: `You get these because you're a member of a program from ${esc(branding.businessName || 'this business')}.` });
    await sendEmailToClient({ clientId: member.client_id, type: 'programs', to: member.client_email, subject, html, replyTo: branding.replyTo })
      .catch((e) => console.warn('[programNotify] email', e.message));
  }
  await notifyClientSafe({ clientId: member.client_id, type: 'engagement', payload: { ...push, url: path } });
}

export async function notifyNewLesson({ workspaceId, programId, itemId, now = new Date() }) {
  const program = (await sql`SELECT * FROM programs WHERE id = ${programId} AND workspace_id = ${workspaceId}`).rows[0];
  if (!program || program.status !== 'published') return { sent: 0, reason: 'not published' };
  const item = (await sql`SELECT * FROM program_items WHERE id = ${itemId} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0];
  if (!item) return { sent: 0, reason: 'no lesson' };
  const module = item.module_id
    ? (await sql`SELECT * FROM program_modules WHERE id = ${item.module_id} AND program_id = ${programId} AND deleted_at IS NULL`).rows[0] || null
    : null;
  const members = await activeMembers(programId, workspaceId);
  if (!members.length) return { sent: 0 };
  const branding = await fetchBranding(workspaceId);
  let sent = 0;
  await eachLimited(members, 5, async (m) => {
    // A lesson in a module that is still locked for this member is
    // announced by the drip cron when the module opens, not now.
    if (lessonUnlocksAt(module, { anchor: dripAnchorFor(m, program), gate: courseGateFor(m, program), now })) return;
    if (!(await claim({ workspaceId, programId, clientId: m.client_id, kind: 'lesson', refId: item.id }))) return;
    const subject = `New lesson in ${program.title}: ${item.title}`;
    await sendMember({
      workspaceId, member: m, branding, subject, heading: 'A new lesson is ready',
      bodyHtml: `<p>Hi ${esc(firstName(m.client_name))},</p><p><strong>${esc(item.title)}</strong> was just added to <strong>${esc(program.title)}</strong>.</p>`,
      ctaText: 'Open the lesson', path: `/me/programs/${program.id}/lessons/${item.id}`,
      push: { title: `New lesson in ${program.title}`, body: item.title, tag: `program-lesson-${item.id}` },
    });
    sent++;
  });
  return { sent };
}

// Daily. Finds dripped modules that opened for a member within the last
// 48 hours and tells them once. Unlocks older than that (a module whose
// schedule was shortened, or the first run after launch) are recorded
// without a send so they never pile up or arrive late.
export async function runDripNotifications({ now = new Date(), workspaceId = null } = {}) {
  const rows = (await sql`
    SELECT m.id AS module_id, m.title AS module_title, m.unlock_after_days, m.workspace_id,
           p.id AS program_id, p.title AS program_title, p.status AS program_status, p.delivery,
           e.id AS enrollment_id, e.client_id, e.granted_at, e.status, e.expires_at, co.starts_at AS cohort_starts_at,
           c.name AS client_name, c.email AS client_email
      FROM program_modules m
      JOIN programs p ON p.id = m.program_id AND p.workspace_id = m.workspace_id AND p.status IN ('published','archived')
      JOIN program_enrollments e ON e.program_id = p.id AND e.workspace_id = p.workspace_id
           AND e.status IN ('active','past_due') AND (e.expires_at IS NULL OR e.expires_at > ${now.toISOString()})
      LEFT JOIN program_cohorts co ON co.id = e.cohort_id AND co.deleted_at IS NULL
      JOIN clients c ON c.id = e.client_id AND c.workspace_id = p.workspace_id
     WHERE m.deleted_at IS NULL AND m.unlock_after_days > 0
       AND (${workspaceId}::uuid IS NULL OR m.workspace_id = ${workspaceId}::uuid)
       AND EXISTS (SELECT 1 FROM program_items i WHERE i.module_id = m.id AND i.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM program_notifications n WHERE n.dedupe_key = 'unlock:' || m.id::text || ':' || e.client_id::text)
     LIMIT 5000`).rows;

  // Group what opened for each member, per program, so two modules
  // opening the same day arrive as one email.
  const groups = new Map();
  let recordedOnly = 0;
  for (const r of rows) {
    const at = moduleUnlocksAt(r, dripAnchorFor(r, { id: r.program_id, delivery: r.delivery }));
    if (!at || at.getTime() > now.getTime()) continue;
     
    const mine = await claim({ workspaceId: r.workspace_id, programId: r.program_id, clientId: r.client_id, kind: 'unlock', refId: r.module_id });
    if (!mine) continue;
    if (now.getTime() - at.getTime() > DRIP_WINDOW_MS) { recordedOnly++; continue; }
    const k = `${r.program_id}:${r.client_id}`;
    if (!groups.has(k)) groups.set(k, { first: r, modules: [] });
    groups.get(k).modules.push(r.module_title);
  }
  let sent = 0;
  const brandingCache = new Map();
  await eachLimited([...groups.values()], 5, async ({ first: r, modules }) => {
    if (!brandingCache.has(r.workspace_id)) brandingCache.set(r.workspace_id, fetchBranding(r.workspace_id));
    const branding = await brandingCache.get(r.workspace_id);
    const one = modules.length === 1;
    const subject = one ? `New in ${r.program_title}: ${modules[0]} is now open` : `${modules.length} new modules are open in ${r.program_title}`;
    const list = modules.map((t) => `<li>${esc(t)}</li>`).join('');
    await withTimeout(sendMember({
      workspaceId: r.workspace_id, member: r, branding, subject, heading: one ? 'A new module is open' : 'New modules are open',
      bodyHtml: `<p>Hi ${esc(firstName(r.client_name))},</p><p>New content just opened for you in <strong>${esc(r.program_title)}</strong>:</p><ul>${list}</ul>`,
      ctaText: 'Keep going', path: `/me/programs/${r.program_id}`,
      push: { title: `New in ${r.program_title}`, body: one ? `${modules[0]} is now open` : `${modules.length} new modules are open`, tag: `program-unlock-${r.program_id}` },
    }), 30_000);
    sent++;
  });
  return { candidates: rows.length, sent, recordedOnly };
}

// Owner push when a member joins through a subscription checkout.
export function notifyOwnerProgramJoin({ workspaceId, programTitle, clientName, enrollmentId, trial = false }) {
  return notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: trial
      ? { title: 'Free trial started', body: `${clientName || 'Someone'} started a free trial of ${programTitle}.`, url: '/programs', tag: `program-join-${enrollmentId}` }
      : { title: 'New program member', body: `${clientName || 'Someone'} joined ${programTitle}.`, url: '/programs', tag: `program-join-${enrollmentId}` },
  });
}

// Daily, cohort programs: the day a cohort starts, each of its members is
// told once that the program is open. Starts older than 48 hours (a
// cohort created with a past date) are recorded without a send.
export async function runCohortStartNotifications({ now = new Date(), workspaceId = null } = {}) {
  const rows = (await sql`
    SELECT co.id AS cohort_id, co.name AS cohort_name, co.starts_at, p.id AS program_id, p.title AS program_title, p.workspace_id,
           e.client_id, c.name AS client_name, c.email AS client_email
      FROM program_cohorts co
      JOIN programs p ON p.id = co.program_id AND p.workspace_id = co.workspace_id AND p.delivery = 'cohort' AND p.status IN ('published','archived')
      JOIN program_enrollments e ON e.cohort_id = co.id AND e.program_id = p.id AND e.workspace_id = p.workspace_id
           AND e.status IN ('active','past_due') AND (e.expires_at IS NULL OR e.expires_at > ${now.toISOString()})
      JOIN clients c ON c.id = e.client_id AND c.workspace_id = p.workspace_id
     WHERE co.deleted_at IS NULL AND co.starts_at <= ${now.toISOString()}
       AND (${workspaceId}::uuid IS NULL OR co.workspace_id = ${workspaceId}::uuid)
       AND NOT EXISTS (SELECT 1 FROM program_notifications n WHERE n.dedupe_key = 'cohort_start:' || co.id::text || ':' || e.client_id::text)
     LIMIT 5000`).rows;
  let sent = 0; let recordedOnly = 0;
  const brandingCache = new Map();
  await eachLimited(rows, 5, async (r) => {
    if (!(await claim({ workspaceId: r.workspace_id, programId: r.program_id, clientId: r.client_id, kind: 'cohort_start', refId: r.cohort_id }))) return;
    if (now.getTime() - new Date(r.starts_at).getTime() > DRIP_WINDOW_MS) { recordedOnly++; return; }
    if (!brandingCache.has(r.workspace_id)) brandingCache.set(r.workspace_id, fetchBranding(r.workspace_id));
    const branding = await brandingCache.get(r.workspace_id);
    await sendMember({
      member: r, branding, subject: `${r.program_title} starts today`, heading: 'Your program starts today',
      bodyHtml: `<p>Hi ${esc(firstName(r.client_name))},</p><p><strong>${esc(r.program_title)}</strong> (${esc(r.cohort_name)}) is open. Your first lessons are ready.</p>`,
      ctaText: 'Start now', path: `/me/programs/${r.program_id}`,
      push: { title: `${r.program_title} starts today`, body: 'Your first lessons are ready.', tag: `program-cohort-${r.cohort_id}` },
    });
    sent++;
  });
  return { candidates: rows.length, sent, recordedOnly };
}

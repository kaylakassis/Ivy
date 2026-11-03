// Check-in notifications.
//   notifyCheckinReply     the owner replied privately to a member's check-in:
//                          one email + one push to that member per reply.
//   notifyOwnerCheckin     a member submitted a check-in: one push to the owner
//                          per submission (edits within the period stay quiet).
//   runCheckinReminders    hourly cron: from 9am in the business's timezone on
//                          the day a check-in is due, members who have not
//                          submitted yet get ONE email + push listing what is
//                          due in that program (several forms share it).
// Every send is claimed first in program_notifications (unique
// dedupe_key), so a retry or a second cron run never sends twice.
import { sql } from './db.js';
import { makeDeadline, withTimeout } from './timeBudget.js';
import { sendEmailToClient, emailShell } from './email.js';
import { notifyClientSafe, notifyOwnerSafe } from './push.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { currentPeriod, localMinutes } from './programCheckins.js';
import { isValidTimeZone } from './tz.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const REMIND_FROM_MINUTES = 9 * 60;

async function claimKey({ workspaceId, programId, clientId, kind, refId, key }) {
  const r = await sql`
    INSERT INTO program_notifications (workspace_id, program_id, client_id, kind, ref_id, dedupe_key)
    VALUES (${workspaceId}, ${programId}, ${clientId}, ${kind}, ${refId}, ${key})
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
  return r.rows.length > 0;
}

async function sendToMember({ workspaceId, clientId, subject, heading, bodyHtml, ctaText, path, push, pushType = 'engagement', branding = null }) {
  const c = (await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`).rows[0];
  if (!c) return;
  const b = branding || await fetchBranding(workspaceId);
  if (c.email) {
    const html = emailShell({ heading, branding: b, body: bodyHtml.replace('{first}', esc(firstName(c.name))), ctaText, ctaUrl: `${appUrl()}${path}`, preheader: subject,
      footer: `You get these because you're a member of a program from ${esc(b.businessName || 'this business')}.` });
    await sendEmailToClient({ clientId: c.id, type: 'programs', to: c.email, subject, html, replyTo: b.replyTo })
      .catch((e) => console.warn('[checkinNotify] email', e.message));
  }
  await notifyClientSafe({ clientId: c.id, type: pushType, payload: { ...push, url: path } });
}

export async function notifyCheckinReply({ program, response, replyIndex }) {
  const key = `checkin_reply:${response.id}:${replyIndex}`;
  if (!(await claimKey({ workspaceId: program.workspace_id, programId: program.id, clientId: response.client_id, kind: 'checkin_reply', refId: response.id, key }))) return false;
  const form = (await sql`SELECT title FROM program_checkin_forms WHERE id = ${response.form_id}`).rows[0];
  const title = form?.title || 'your check-in';
  await sendToMember({
    workspaceId: program.workspace_id, clientId: response.client_id,
    subject: `New reply on ${title}`, heading: 'Your coach replied',
    bodyHtml: `<p>Hi {first},</p><p>There's a new private reply on your <strong>${esc(title)}</strong> check-in in <strong>${esc(program.title)}</strong>.</p>`,
    ctaText: 'Read the reply', path: `/me/programs/${program.id}?tab=checkins`,
    push: { title: `Reply on ${title}`, body: `New reply in ${program.title}`, tag: `checkin-reply-${response.id}` }, pushType: 'messages',
  });
  return true;
}

export function notifyOwnerCheckin({ program, response, memberName, formTitle }) {
  return notifyOwnerSafe({
    workspaceId: program.workspace_id, type: 'messages',
    payload: { title: 'New check-in', body: `${memberName || 'A member'} filled in ${formTitle} (${program.title}).`, url: `/programs?program=${program.id}&tab=checkins`, tag: `checkin-${response.id}` },
  });
}

// Hourly. See the header.
export async function runCheckinReminders({ now = new Date(), workspaceId = null } = {}) {
  const forms = (await sql`
    SELECT f.*, p.title AS program_title, cs.timezone
      FROM program_checkin_forms f
      JOIN programs p ON p.id = f.program_id AND p.workspace_id = f.workspace_id AND p.status = 'published'
      LEFT JOIN calendar_settings cs ON cs.workspace_id = f.workspace_id
     WHERE f.archived_at IS NULL AND f.remind AND f.frequency IN ('daily', 'weekly')
       AND (${workspaceId}::uuid IS NULL OR f.workspace_id = ${workspaceId}::uuid)
     LIMIT 2000`).rows;
  // (program, member) → forms due today and not yet submitted.
  const due = new Map();
  for (const f of forms) {
    const tz = isValidTimeZone(f.timezone) ? f.timezone : 'UTC';
    const period = currentPeriod(f, tz, now);
    if (!period.dueToday || localMinutes(tz, now) < REMIND_FROM_MINUTES) continue;
    const members = (await sql`
      SELECT DISTINCT e.client_id FROM program_enrollments e
       WHERE e.program_id = ${f.program_id} AND e.workspace_id = ${f.workspace_id} AND e.status IN ('active','past_due')
         AND (e.expires_at IS NULL OR e.expires_at > NOW())
         AND NOT EXISTS (SELECT 1 FROM program_checkin_responses r WHERE r.form_id = ${f.id} AND r.client_id = e.client_id AND r.period_key = ${period.key})`).rows;
    for (const m of members) {
      const k = `${f.program_id}|${m.client_id}|${period.key}`;
      if (!due.has(k)) due.set(k, { form: f, clientId: m.client_id, periodKey: period.key, forms: [] });
      due.get(k).forms.push(f);
    }
  }
  let sent = 0;
  let stoppedEarly = false;
  const deadline = makeDeadline();
  for (const d of due.values()) {
    // Stay inside the platform's time limit; the next hourly run continues.
    if (deadline.passed()) { stoppedEarly = true; break; }
    const fresh = [];
    for (const f of d.forms) {
      if (await claimKey({ workspaceId: f.workspace_id, programId: f.program_id, clientId: d.clientId, kind: 'checkin_due', refId: f.id, key: `checkin_due:${f.id}:${d.periodKey}:${d.clientId}` })) fresh.push(f);
    }
    if (!fresh.length) continue;
    const f = d.form;
    const one = fresh.length === 1;
    await withTimeout(sendToMember({
      workspaceId: f.workspace_id, clientId: d.clientId,
      subject: one ? `Check-in due today: ${fresh[0].title}` : `${fresh.length} check-ins due today in ${f.program_title}`,
      heading: 'Time for your check-in',
      bodyHtml: `<p>Hi {first},</p><p>${one ? `Your <strong>${esc(fresh[0].title)}</strong> check-in` : 'These check-ins'} for <strong>${esc(f.program_title)}</strong> ${one ? 'is' : 'are'} due today.</p>${one ? '' : `<ul>${fresh.map((x) => `<li>${esc(x.title)}</li>`).join('')}</ul>`}<p>It only takes a minute.</p>`,
      ctaText: 'Check in', path: `/me/programs/${f.program_id}?tab=checkins`,
      push: { title: 'Check-in due', body: one ? `${fresh[0].title} (${f.program_title})` : `${fresh.length} check-ins in ${f.program_title}`, tag: `checkin-due-${f.program_id}-${d.periodKey}` },
    }), 30_000);
    sent++;
  }
  return { forms: forms.length, sent, stoppedEarly };
}

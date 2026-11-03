// "I've moved" announcement: after switching to Ivy, the owner can email the
// clients they choose a short note from the business with the new booking
// link. Clients don't care which software a business uses, so the email is
// about the business and its link, not about Ivy.
//
// It is a non-critical client email of type 'marketing' ("occasional updates
// from the business" in the client's settings): an unsubscribe from that or
// from everything is honored, and every email carries the one-click
// unsubscribe link that sendEmailToClient adds. Owner edits are plain text,
// length-capped, and escaped when rendered.
import { sql } from './db.js';
import { appUrl } from './tokens.js';

export const ANNOUNCE_EMAIL_TYPE = 'marketing';
export const ANNOUNCE_DAILY_CAP = 500;
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
const FIRST_NAME_TOKEN = /\{\s*first\s*name\s*\}/gi;
const LINK_TOKEN = /\{\s*link\s*\}/gi;

function firstWord(s) {
  const w = String(s || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}\p{M}'’.-]{0,40}$/u.test(w) ? w : '';
}

// Owner-facing details for the announcement: business name, owner's first
// name and the public booking link (null when there is no booking page yet).
export async function announceContext(workspaceId) {
  const r = await sql`
    SELECT cs.biz_name, cs.slug, w.name AS ws_name, u.name AS owner_name, u.email AS owner_email
      FROM workspaces w
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN users u ON u.id = w.owner_id
     WHERE w.id = ${workspaceId}`;
  const row = r.rows[0] || {};
  const businessName = String(row.biz_name || row.ws_name || '').trim() || 'Your business';
  const ownerFirstName = firstWord(row.owner_name) || businessName;
  const bookingUrl = row.slug ? `${appUrl()}/book/${encodeURIComponent(row.slug)}` : null;
  return { businessName, ownerFirstName, bookingUrl, replyTo: row.owner_email || null };
}

export function defaultSubject(businessName) {
  return `${businessName} has a new booking link`;
}

// The default note. {first name} is filled in per client when it is sent.
export function defaultBody({ bookingUrl, ownerFirstName }) {
  return [
    'Hi {first name},',
    '',
    `Quick note: I've moved my bookings and payments to a new system. From now on you can book with me here: ${bookingUrl || '{link}'}`,
    '',
    'Your history with me is safe and nothing changes on your end.',
    '',
    'See you soon,',
    ownerFirstName,
  ].join('\n');
}

// Plain text only: control characters out, length capped. Subjects are one line.
export function cleanSubject(s) {
  const t = String(s ?? '').replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, SUBJECT_MAX);
}
export function cleanBody(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .slice(0, BODY_MAX)
    .trim();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One client's email: { text, html } where html is the escaped body (blank
// lines → paragraphs, newlines → <br>) with the booking link made clickable.
export function renderAnnouncement(body, { clientName, bookingUrl }) {
  const first = firstWord(clientName) || 'there';
  const text = body.replace(FIRST_NAME_TOKEN, first).replace(LINK_TOKEN, bookingUrl || '');
  const linkHtml = bookingUrl ? escapeHtml(bookingUrl) : null;
  const paragraphs = text.split(/\n{2,}/).map((p) => {
    let h = escapeHtml(p).replace(/\n/g, '<br>');
    if (linkHtml) h = h.split(linkHtml).join(`<a href="${linkHtml}" style="color:inherit;text-decoration:underline;">${linkHtml}</a>`);
    return `<p style="margin:0 0 14px;">${h}</p>`;
  });
  const fullText = bookingUrl && !text.includes(bookingUrl) ? `${text}\n\nBook here: ${bookingUrl}` : text;
  return { text: fullText, html: paragraphs.join('\n') };
}

// Clients of the workspace (optionally only `ids`) with the facts the
// announcement needs. opted_out mirrors the address-wide rule in
// notificationPrefs.js: any record of that address in this business that
// turned the type off, or an active opt-out for that type or for everything.
export async function announceCandidates(workspaceId, ids = null) {
  const r = await sql.query(`
    SELECT c.id, c.name, c.email, c.move_announced_at,
           (COALESCE(c.email, '') <> '' AND (
              EXISTS (SELECT 1 FROM clients c2
                       WHERE c2.workspace_id = c.workspace_id AND LOWER(c2.email) = LOWER(c.email)
                         AND c2.notification_prefs->>$3 = 'false')
              OR EXISTS (SELECT 1 FROM client_email_optouts o
                          WHERE o.workspace_id = c.workspace_id AND o.email = LOWER(TRIM(c.email))
                            AND o.cleared_at IS NULL AND o.type IN ($3, 'all'))
           )) AS opted_out
      FROM clients c
     WHERE c.workspace_id = $1
       AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))`,
  [workspaceId, ids, ANNOUNCE_EMAIL_TYPE]);
  return r.rows;
}

export async function sentInLastDay(workspaceId) {
  const r = await sql`
    SELECT COUNT(*)::int AS n FROM clients
     WHERE workspace_id = ${workspaceId} AND move_announced_at > NOW() - INTERVAL '24 hours'`;
  return r.rows[0]?.n || 0;
}

// Client email opt-outs from one business: apply them, record them, and
// tell the business owner.
//
// Entry points:
//   • applyClientOptOut   - the public /api/unsubscribe link (GET) and the
//                           RFC 8058 one-click header (POST), scopes
//                           'client' and 'clientEmail'.
//   • applyPortalEmailPrefs - the client portal switches (/me/notifications).
//
// Every opt-out that actually changes something writes one
// client_email_optouts row per category (or one 'all' row), which is both
// the history the owner sees in the client drawer and part of enforcement
// (api/_lib/notificationPrefs.js reads active rows, so an opt-out sticks
// for an address with no clients row yet). Only the client can clear a
// row, by turning the category back on in their portal; owners have no
// write path.
//
// Owner notice: a push per opt-out event (repeats of an already-muted
// category change nothing, so they notify nothing) and at most ONE email
// per client per day, listing every category they turned off that day.
// Newsletter and waitlist opt-outs (Ivy's own lists) and an owner muting
// their own Ivy emails never come through here.
import { sql } from './db.js';
import {
  EMAIL_NOTIFY_TYPES, CLIENT_EMAIL_TYPES, normalizeEmail,
  effectiveClientEmailPrefs,
} from './notificationPrefs.js';
import { sendEmailToUser, emailShell } from './email.js';
import { notifyOwnerSafe } from './push.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';

export const OPTOUT_SOURCES = ['link', 'one_click', 'portal', 'owner'];

// How a category reads in a sentence: "unsubscribed from <label>".
export const OPTOUT_LABELS = {
  all:       'all emails',
  bookings:  'booking emails',
  invoices:  'invoice reminders',
  documents: 'document emails',
  messages:  'message emails',
  marketing: 'reviews and announcements',
  billing:   'billing emails',
  programs:  'program updates',
  // Owner-side categories: used for the owner's own unsubscribe page line.
  reports:   'weekly recaps and setup reminders',
  signup_reminders: 'reminders to finish signing up',
};

export function optOutLabel(type) {
  return OPTOUT_LABELS[type] || 'some emails';
}

function joinLabels(types) {
  if (types.includes('all')) return OPTOUT_LABELS.all;
  const labels = [...new Set(types.map(optOutLabel))];
  if (labels.length <= 1) return labels[0] || OPTOUT_LABELS.all;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Who is opting out: the clients row (when known) and the address.
// Returns null when a token names a clients row that no longer exists.
async function resolveSubject({ workspaceId, clientId, email }) {
  if (clientId) {
    const { rows } = await sql`SELECT id, workspace_id, name, email FROM clients WHERE id = ${clientId}`;
    const c = rows[0];
    if (!c) return null;
    return { workspaceId: c.workspace_id, clientId: c.id, name: c.name || null, email: normalizeEmail(c.email) };
  }
  const addr = normalizeEmail(email);
  if (!workspaceId || !addr) return null;
  const { rows } = await sql`
    SELECT id, name FROM clients
     WHERE workspace_id = ${workspaceId} AND LOWER(email) = ${addr}
     ORDER BY created_at ASC LIMIT 1`;
  return { workspaceId, clientId: rows[0]?.id || null, name: rows[0]?.name || null, email: addr };
}

// Effective prefs for an address that may have no clients row.
async function effectivePrefsFor(subject) {
  if (subject.clientId) return effectiveClientEmailPrefs(subject.clientId);
  const out = {};
  for (const t of CLIENT_EMAIL_TYPES) out[t] = true;
  const { rows } = await sql`
    SELECT DISTINCT type FROM client_email_optouts
     WHERE workspace_id = ${subject.workspaceId} AND email = ${subject.email} AND cleared_at IS NULL`;
  for (const r of rows) {
    if (r.type === 'all') for (const t of CLIENT_EMAIL_TYPES) out[t] = false;
    else if (r.type in out) out[r.type] = false;
  }
  return out;
}

// Merge a prefs patch into every clients row of this business that holds
// this address (or just the one row when there is no address).
async function writePrefs(subject, patch) {
  await sql`
    UPDATE clients
       SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
     WHERE workspace_id = ${subject.workspaceId}
       AND (id = ${subject.clientId}
            OR (${subject.email} <> '' AND LOWER(email) = ${subject.email}))`;
}

// Unsubscribe link / one-click. `type` is one category or 'all'. An
// unknown category (an old link minted for a type nothing reads) is
// treated as 'all': the person asked to stop, so stop.
export async function applyClientOptOut({ workspaceId, clientId, email, type, source }) {
  const subject = await resolveSubject({ workspaceId, clientId, email });
  if (!subject) return { ok: true, changed: false, missing: true };
  const t = (type && type !== 'all' && EMAIL_NOTIFY_TYPES.includes(type)) ? type : 'all';
  const before = await effectivePrefsFor(subject);
  const affected = t === 'all' ? CLIENT_EMAIL_TYPES : [t];
  const changed = affected.some((x) => before[x] !== false);

  const patch = {};
  for (const x of (t === 'all' ? EMAIL_NOTIFY_TYPES : [t])) patch[x] = false;
  if (subject.clientId || subject.email) await writePrefs(subject, patch);
  if (!changed) return { ok: true, changed: false, subject };

  await recordAndNotify({ subject, types: [t], source });
  return { ok: true, changed: true, subject };
}

// Client portal switches. `prefs` holds only the categories the client
// changed. Turning a category ON clears the client's own opt-out rows for
// it; turning one OFF records an opt-out and tells the owner.
export async function applyPortalEmailPrefs({ clientId, prefs }) {
  const subject = await resolveSubject({ clientId });
  if (!subject) return null;
  const before = await effectivePrefsFor(subject);
  const final = { ...before };
  const turnedOn = [];
  const turnedOff = [];
  for (const t of CLIENT_EMAIL_TYPES) {
    if (!(t in prefs)) continue;
    const next = !!prefs[t];
    final[t] = next;
    if (next && before[t] === false) turnedOn.push(t);
    if (!next && before[t] !== false) turnedOff.push(t);
  }
  // Write the whole effective state onto every row for this address, so
  // clearing an 'all' opt-out below cannot silently switch the other
  // categories back on.
  await writePrefs(subject, final);
  if (turnedOn.length && subject.email) {
    await sql.query(
      `UPDATE client_email_optouts SET cleared_at = NOW()
        WHERE workspace_id = $1 AND email = $2 AND cleared_at IS NULL
          AND (type = ANY($3::text[]) OR type = 'all')`,
      [subject.workspaceId, subject.email, turnedOn],
    );
  }
  if (turnedOn.length) {
    await sql.query(
      `UPDATE client_email_optouts SET cleared_at = NOW()
        WHERE client_id = $1 AND cleared_at IS NULL
          AND (type = ANY($2::text[]) OR type = 'all')`,
      [subject.clientId, turnedOn],
    );
  }
  if (turnedOff.length) await recordAndNotify({ subject, types: turnedOff, source: 'portal' });
  return final;
}

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function recordAndNotify({ subject, types, source }) {
  const src = OPTOUT_SOURCES.includes(source) ? source : 'link';
  const ids = [];
  for (const t of types) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await sql`
      INSERT INTO client_email_optouts (workspace_id, client_id, email, type, source)
      VALUES (${subject.workspaceId}, ${subject.clientId}, ${subject.email || null}, ${t}, ${src})
      RETURNING id`;
    ids.push(rows[0].id);
  }
  try {
    await notifyOwnerOfOptOut({ subject, types, rowId: ids[0] });
  } catch (err) {
    // The opt-out itself is already saved; a notice failure must not undo it.
    // eslint-disable-next-line no-console
    console.warn('[clientOptouts] owner notice failed:', err.message);
  }
}

async function notifyOwnerOfOptOut({ subject, types, rowId }) {
  const { rows } = await sql`
    SELECT u.id, u.email, u.name, w.name AS ws_name
      FROM workspaces w JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
     WHERE w.id = ${subject.workspaceId}`;
  const owner = rows[0];
  if (!owner) return;
  // The owner testing their own address is not a client opting out.
  if (subject.email && normalizeEmail(owner.email) === subject.email) return;

  const branding = await fetchBranding(subject.workspaceId).catch(() => ({}));
  const business = branding.businessName || owner.ws_name || 'your business';
  const who = subject.name || subject.email || 'A client';
  const path = subject.clientId ? `/clients?id=${encodeURIComponent(subject.clientId)}` : '/clients';
  const subjectKey = subject.clientId || subject.email;

  // Push: one per event. Same category again changes nothing upstream, so
  // it never reaches here; the tag also coalesces the bell row.
  await notifyOwnerSafe({
    workspaceId: subject.workspaceId,
    type: 'client_optouts',
    payload: {
      title: `${who} unsubscribed`,
      body: `${who} unsubscribed from ${joinLabels(types)} from ${business}. You can still reach them through Messages.`,
      url: path,
      tag: `client-optout-${subjectKey}-${[...types].sort().join('-')}`,
    },
  });

  // Email: at most one per client per day. Claim today's key on this
  // row; a second opt-out the same day loses the claim and stays quiet
  // (it is still in the drawer history and got its own push).
  const noticeKey = `${subjectKey}:${utcDay()}`;
  try {
    await sql`UPDATE client_email_optouts SET notice_key = ${noticeKey} WHERE id = ${rowId}`;
  } catch (err) {
    if (err?.code === '23505') return;
    throw err;
  }
  const today = await sql`
    SELECT DISTINCT type FROM client_email_optouts
     WHERE workspace_id = ${subject.workspaceId}
       AND (client_id = ${subject.clientId} OR (${subject.email || ''} <> '' AND email = ${subject.email || ''}))
       AND created_at >= ${`${utcDay()}T00:00:00Z`}::timestamptz`;
  const dayTypes = today.rows.map((r) => r.type);
  const label = joinLabels(dayTypes.length ? dayTypes : types);
  const link = `${appUrl()}${path}`;
  const html = emailShell({
    heading: `${who} unsubscribed`,
    preheader: `${who} unsubscribed from ${label} from ${business}.`,
    body: `<p><strong>${escapeHtml(who)}</strong> unsubscribed from ${escapeHtml(label)} from ${escapeHtml(business)}.</p>
      <p>They'll still get account essentials like receipts. You can still reach them through Messages in Ivy.</p>
      <p style="color:#93A3A0;font-size:13px;">Only ${escapeHtml(who)} can turn these emails back on, from their own notification settings.</p>`,
    ctaText: 'Open client',
    ctaUrl: link,
    footer: 'You get at most one of these per client per day. Turn them off in Account → Notifications.',
  });
  await sendEmailToUser({
    userId: owner.id, type: 'client_optouts', to: owner.email,
    subject: `${who} unsubscribed from ${label}`,
    html,
  });
}

// Owner-side history for the client drawer: newest first, scoped to the
// owner's workspace and this client (by row or by address).
export async function listClientOptOuts({ workspaceId, clientId }) {
  const { rows: c } = await sql`SELECT id, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
  if (!c[0]) return null;
  const email = normalizeEmail(c[0].email);
  const { rows } = await sql`
    SELECT type, source, created_at, cleared_at FROM client_email_optouts
     WHERE workspace_id = ${workspaceId}
       AND (client_id = ${clientId} OR (${email} <> '' AND email = ${email}))
     ORDER BY created_at DESC
     LIMIT 20`;
  return rows.map((r) => ({
    type: r.type,
    label: optOutLabel(r.type),
    source: r.source,
    createdAt: r.created_at,
    active: !r.cleared_at,
    resubscribedAt: r.cleared_at || null,
  }));
}

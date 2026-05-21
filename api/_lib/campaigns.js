// Email campaigns / newsletters for owners. Audience is resolved from the
// workspace's own data (clients, or the owner's website newsletter
// sign-ups). Sends route through sendEmailToClientByAddress with
// type='marketing', so each recipient's opt-out is honored and a
// List-Unsubscribe header is attached (CAN-SPAM hygiene).
import { sql } from './db.js';
import { sendEmailToClientByAddress, emailShell } from './email.js';
import { fetchBranding } from './branding.js';

export const VALID_AUDIENCE = (a) =>
  a === 'all-clients' || a === 'newsletter' || (typeof a === 'string' && a.startsWith('tag:') && a.length <= 64);

// Max recipients a single send will fan out to, to stay within the
// serverless time budget. Larger lists should be split into segments.
export const MAX_RECIPIENTS = 1000;

export function serializeCampaign(row) {
  if (!row) return null;
  return {
    id:             row.id,
    subject:        row.subject || '',
    body:           row.body || '',
    audience:       row.audience || 'all-clients',
    status:         row.status || 'draft',
    recipientCount: row.recipient_count || 0,
    sentCount:      row.sent_count || 0,
    failedCount:    row.failed_count || 0,
    lastError:      row.last_error || null,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
    sentAt:         row.sent_at,
  };
}

// Resolve an audience string into a deduped [{ email, name }] list.
export async function resolveAudience(workspaceId, audience) {
  let rows = [];
  if (audience === 'all-clients') {
    rows = (await sql`
      SELECT name, email FROM clients
       WHERE workspace_id = ${workspaceId} AND email IS NOT NULL AND email <> ''
    `).rows;
  } else if (audience.startsWith('tag:')) {
    const tag = audience.slice(4);
    rows = (await sql`
      SELECT name, email FROM clients
       WHERE workspace_id = ${workspaceId} AND email IS NOT NULL AND email <> ''
         AND ${tag} = ANY(tags)
    `).rows;
  } else if (audience === 'newsletter') {
    rows = (await sql`
      SELECT s.payload->>'name' AS name, lower(s.payload->>'email') AS email
        FROM website_form_submissions s
        JOIN websites w ON w.id = s.website_id
       WHERE w.workspace_id = ${workspaceId}
         AND s.form_id = 'newsletter'
         AND s.payload->>'email' IS NOT NULL AND s.payload->>'email' <> ''
    `).rows;
  }
  // Dedupe by lowercased email.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: r.name || '' });
  }
  return out;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Render the owner's plain-text body into the branded shell. Newlines →
// <br>; everything is escaped (owner-authored, but defense-in-depth).
function renderCampaignHtml({ subject, body, branding }) {
  const html = escapeHtml(body).replace(/\n/g, '<br>');
  return emailShell({
    heading: subject,
    body: `<div style="white-space:normal;line-height:1.6">${html}</div>`,
    branding,
  });
}

// Build the {subject, html} a campaign will send (also used for test sends).
export async function buildCampaignEmail({ workspaceId, campaign }) {
  const branding = await fetchBranding(workspaceId).catch(() => ({}));
  const subject = campaign.subject || '(no subject)';
  const html = renderCampaignHtml({ subject, body: campaign.body, branding });
  return { subject, html };
}

// Run fn over items with bounded concurrency, classifying each result:
//   sent    — actually delivered
//   skipped — recipient opted out / quota (intentional, not an error)
//   failed  — a real send error
async function runPool(items, concurrency, fn) {
  let i = 0;
  const counts = { sent: 0, skipped: 0, failed: 0 };
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      try {
        const res = await fn(item);
        if (!res || res.ok === false) counts.failed++;
        else if (res.sent) counts.sent++;
        else counts.skipped++;
      } catch { counts.failed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return counts;
}

// Send a campaign to its resolved audience. Returns {recipientCount,
// sent, skipped, failed}. Marketing type → opt-outs honored (skipped),
// unsubscribe header attached.
export async function sendCampaign({ workspaceId, campaign }) {
  const audience = (await resolveAudience(workspaceId, campaign.audience)).slice(0, MAX_RECIPIENTS);
  const { subject, html } = await buildCampaignEmail({ workspaceId, campaign });
  const counts = await runPool(audience, 5, (r) => sendEmailToClientByAddress({
    workspaceId, email: r.email, type: 'marketing', subject, html,
  }));
  return { recipientCount: audience.length, sent: counts.sent, skipped: counts.skipped, failed: counts.failed };
}

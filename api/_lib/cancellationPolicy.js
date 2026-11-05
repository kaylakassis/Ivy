// The business's own cancellation policy: the words the owner writes, the
// "clients must accept it when they book" switch, and the acceptance
// records that back the owner up if a client disputes a charge.
//
//   cancellation_policy_versions   every edit is a new version (append-only)
//   cancellation_policy_settings   switches (require acceptance, show it on
//                                  the booking page / website footer,
//                                  refund deposits before the window)
//   cancellation_policy_acceptances one row per booking acceptance, with the
//                                  exact text, its hash, the fees in effect,
//                                  time, IP, browser and what was typed
//
// The FEE NUMBERS always come from each service's settings (deposit,
// late-cancel fee + window, no-show fee). The owner's text is the words
// around them. Every read and write here is pinned to a workspace id.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { getClientIp } from './rate-limit.js';
import { depositFor } from './calendar.js';

export const MAX_POLICY_CHARS = 5000;
export const MIN_POLICY_CHARS = 20;

const DEFAULT_SETTINGS = Object.freeze({
  requireAcceptance: false,
  showOnBookingPage: true,
  showInSiteFooter: false,
  refundDepositOutsideWindow: true,
});

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Plain text only: normalise line breaks, drop control characters (keeps
// newlines and tabs), collapse runs of 3+ blank lines, trim. Returns
// { text } or { error }.
export function normalizePolicyText(input) {
  if (typeof input !== 'string') return { error: 'Write your cancellation policy first.' };
  let t = input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  t = t.replace(/\n{4,}/g, '\n\n\n').trim();
  if (t.length < MIN_POLICY_CHARS) return { error: `Your policy needs at least ${MIN_POLICY_CHARS} characters.` };
  if (t.length > MAX_POLICY_CHARS) return { error: `Keep your policy under ${MAX_POLICY_CHARS} characters (it is ${t.length}).` };
  return { text: t };
}

export function serializeSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    requireAcceptance: !!row.require_acceptance,
    showOnBookingPage: row.show_on_booking_page !== false,
    showInSiteFooter: !!row.show_in_site_footer,
    refundDepositOutsideWindow: row.refund_deposit_outside_window !== false,
  };
}

export function serializeVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    text: row.body,
    sha256: row.body_sha256,
    createdAt: row.created_at,
  };
}

export async function getPolicySettings(workspaceId) {
  if (!workspaceId) return { ...DEFAULT_SETTINGS };
  const { rows } = await sql`
    SELECT * FROM cancellation_policy_settings WHERE workspace_id = ${workspaceId} LIMIT 1
  `;
  return serializeSettings(rows[0]);
}

export async function getCurrentPolicy(workspaceId) {
  if (!workspaceId) return null;
  const { rows } = await sql`
    SELECT * FROM cancellation_policy_versions
     WHERE workspace_id = ${workspaceId}
     ORDER BY version DESC LIMIT 1
  `;
  return serializeVersion(rows[0]);
}

export async function listPolicyVersions(workspaceId, limit = 50) {
  const { rows } = await sql`
    SELECT * FROM cancellation_policy_versions
     WHERE workspace_id = ${workspaceId}
     ORDER BY version DESC LIMIT ${Math.max(1, Math.min(200, limit))}
  `;
  return rows.map(serializeVersion);
}

// Save the owner's text. Same words as the current version → no new
// version. Otherwise version = max + 1; a concurrent save that takes the
// same number loses the UNIQUE race and retries once.
export async function savePolicyText({ workspaceId, userId, text }) {
  const norm = normalizePolicyText(text);
  if (norm.error) return { error: norm.error };
  const current = await getCurrentPolicy(workspaceId);
  if (current && current.text === norm.text) return { policy: current, created: false };
  const hash = sha256(norm.text);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { rows } = await sql`
        INSERT INTO cancellation_policy_versions (workspace_id, version, body, body_sha256, created_by)
        SELECT ${workspaceId}, COALESCE(MAX(version), 0) + 1, ${norm.text}, ${hash}, ${userId || null}
          FROM cancellation_policy_versions WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      return { policy: serializeVersion(rows[0]), created: true };
    } catch (err) {
      if (attempt === 0 && /duplicate key|unique/i.test(err.message || '')) continue;
      throw err;
    }
  }
  return { error: 'Could not save right now. Try again.' };
}

export async function savePolicySettings({ workspaceId, patch }) {
  const cur = await getPolicySettings(workspaceId);
  const next = { ...cur };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  const { rows } = await sql`
    INSERT INTO cancellation_policy_settings (
      workspace_id, require_acceptance, show_on_booking_page, show_in_site_footer,
      refund_deposit_outside_window, updated_at
    ) VALUES (
      ${workspaceId}, ${next.requireAcceptance}, ${next.showOnBookingPage}, ${next.showInSiteFooter},
      ${next.refundDepositOutsideWindow}, NOW()
    )
    ON CONFLICT (workspace_id) DO UPDATE SET
      require_acceptance            = EXCLUDED.require_acceptance,
      show_on_booking_page          = EXCLUDED.show_on_booking_page,
      show_in_site_footer           = EXCLUDED.show_in_site_footer,
      refund_deposit_outside_window = EXCLUDED.refund_deposit_outside_window,
      updated_at                    = NOW()
    RETURNING *
  `;
  return serializeSettings(rows[0]);
}

// The switches PUT /api/cancellation-policy (and Ivy) can change.
export const POLICY_SETTING_KEYS = ['requireAcceptance', 'showOnBookingPage', 'showInSiteFooter', 'refundDepositOutsideWindow'];

// Validate a settings patch: each key present must be true or false.
// Returns { patch } or { error }.
export function cleanPolicySettingsPatch(body) {
  const patch = {};
  for (const k of POLICY_SETTING_KEYS) {
    if (body?.[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') return { error: `${k} must be true or false` };
    patch[k] = body[k];
  }
  return { patch };
}

// The owner's save: new text (a new version when the words change) and/or
// switches. The one path behind PUT /api/cancellation-policy and Ivy's
// cancellation_policy tool. Returns { error } or
// { createdVersion, before, after, changed } (changed = switch keys whose
// value moved).
export async function updateCancellationPolicy({ workspaceId, userId, body }) {
  if (!body || typeof body !== 'object') return { error: 'Nothing to save' };
  let createdVersion = null;
  if (body.text !== undefined) {
    if (typeof body.text !== 'string') return { error: 'text must be plain text' };
    if (body.text.length > MAX_POLICY_CHARS * 2) return { error: `Keep your policy under ${MAX_POLICY_CHARS} characters.` };
    const saved = await savePolicyText({ workspaceId, userId, text: body.text });
    if (saved.error) return { error: saved.error };
    if (saved.created) createdVersion = saved.policy;
  }
  const { patch, error } = cleanPolicySettingsPatch(body);
  if (error) return { error };
  if (patch.requireAcceptance === true && !(await getCurrentPolicy(workspaceId))) {
    return { error: 'Write your cancellation policy first, then turn this on.' };
  }
  const before = await getPolicySettings(workspaceId);
  let after = before;
  if (Object.keys(patch).length) after = await savePolicySettings({ workspaceId, patch });
  const changed = POLICY_SETTING_KEYS.filter((k) => before[k] !== after[k]);
  return { createdVersion, before, after, changed };
}

// "Please accept the policy" link for a booking the business made itself.
// loadPolicyRequest checks everything a send needs (shared with Ivy's
// approval card); sendPolicyAcceptanceRequest records the single-use link
// (only its sha256 is stored, 30-day expiry) and emails the client. One
// email per booking per 10 minutes. Both return { error, status } on a
// refusal.
export async function loadPolicyRequest({ workspaceId, bookingId }) {
  const { rows } = await sql`
    SELECT b.id, b.client_id, b.date, b.start_min, b.cancelled_at,
           c.name AS client_name, c.email AS client_email,
           s.name AS service_name, cs.biz_name, cs.slug
      FROM bookings b
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
     WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
     LIMIT 1
  `;
  const b = rows[0];
  if (!b) return { error: 'Booking not found', status: 404 };
  if (b.cancelled_at) return { error: 'This booking is cancelled.', status: 400 };
  if (!b.client_id || !b.client_email) return { error: 'Add an email for this client first.', status: 400 };
  if (!b.slug) return { error: 'Set up your booking page first.', status: 400 };
  const policy = await getCurrentPolicy(workspaceId);
  if (!policy) return { error: 'Write your cancellation policy first.', status: 400 };
  const recent = await sql`
    SELECT 1 FROM cancellation_policy_requests
     WHERE workspace_id = ${workspaceId} AND booking_id = ${bookingId}
       AND created_at > NOW() - INTERVAL '10 minutes'
     LIMIT 1
  `;
  if (recent.rows.length > 0) return { error: 'You just sent this. Give it a few minutes before sending again.', status: 400 };
  return { booking: b, policy };
}

export async function sendPolicyAcceptanceRequest({ workspaceId, bookingId }) {
  const loaded = await loadPolicyRequest({ workspaceId, bookingId });
  if (loaded.error) return loaded;
  const b = loaded.booking;
  const { generateRawToken, appUrl } = await import('./tokens.js');
  const { sendEmailToClient, emailShell } = await import('./email.js');
  const { fetchBranding } = await import('./branding.js');
  const raw = generateRawToken(32);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await sql`
    INSERT INTO cancellation_policy_requests (workspace_id, client_id, booking_id, token_hash, sent_to, expires_at)
    VALUES (${workspaceId}, ${b.client_id}, ${bookingId}, ${hash}, ${b.client_email}, NOW() + INTERVAL '30 days')
  `;
  const link = `${appUrl()}/book/${encodeURIComponent(b.slug)}/policy?t=${encodeURIComponent(raw)}`;
  const biz = b.biz_name || 'your business';
  const first = String(b.client_name || '').trim().split(/\s+/)[0];
  const dateISO = b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10);
  const branding = await fetchBranding(workspaceId);
  const html = emailShell({
    heading: 'Please review the cancellation policy',
    branding,
    body: `<p>${first ? `Hi ${escapeHtml(first)},` : 'Hi,'}</p>
      <p>${escapeHtml(biz)} asks you to read and agree to their cancellation policy for your ${escapeHtml(b.service_name || 'appointment')} on ${escapeHtml(dateISO)}.</p>
      <p>It only takes a moment.</p>`,
    ctaText: 'Read the policy',
    ctaUrl: link,
    footer: `Questions? Reply to this email to reach ${escapeHtml(biz)}.`,
  });
  const sent = await sendEmailToClient({
    clientId: b.client_id, workspaceId, type: 'bookings', to: b.client_email,
    subject: `${biz}: please review the cancellation policy`, html, replyTo: branding?.replyTo,
  });
  return { sent: !!sent?.sent, sentTo: b.client_email, reason: sent?.sent ? null : (sent?.reason || null) };
}

// What the public booking page / website get. Null when there is nothing
// to show (no text yet). Always the latest version.
export async function publicPolicy(workspaceId) {
  const [policy, settings] = await Promise.all([getCurrentPolicy(workspaceId), getPolicySettings(workspaceId)]);
  if (!policy) return null;
  return {
    versionId: policy.id,
    version: policy.version,
    text: policy.text,
    updatedAt: policy.createdAt,
    requireAcceptance: settings.requireAcceptance,
    showOnBookingPage: settings.showOnBookingPage,
    showInSiteFooter: settings.showInSiteFooter,
    refundDepositOutsideWindow: settings.refundDepositOutsideWindow,
  };
}

// The fees a client agrees to for one booking, snapshotted from the
// service row at booking time. Money in dollars (2dp) plus currency.
export function feeTerms({ service, bookingTotal = null, currency = 'USD', settings = null, depositRequired = null, appointment = null }) {
  const s = service || {};
  const total = bookingTotal == null ? Number(s.price || 0) : Number(bookingTotal);
  const deposit = depositRequired == null ? depositFor(s, total) : Number(depositRequired);
  return {
    currency: String(currency || 'USD').toUpperCase(),
    serviceName: s.name || null,
    bookingTotal: Math.round(total * 100) / 100,
    depositType: s.deposit_type || s.depositType || 'none',
    deposit: Math.round(Number(deposit || 0) * 100) / 100,
    lateCancelFee: Math.round(Number(s.cancellation_fee_amount ?? s.cancellationFeeAmount ?? 0) * 100) / 100,
    cancellationWindowHours: Number.isInteger(s.cancellation_window_hours) ? s.cancellation_window_hours
      : Number.isInteger(s.cancellationWindowHours) ? s.cancellationWindowHours : 24,
    noShowFee: Math.round(Number(s.no_show_fee_amount ?? s.noShowFeeAmount ?? 0) * 100) / 100,
    depositRefundedBeforeWindow: settings ? settings.refundDepositOutsideWindow !== false : true,
    ...(appointment ? { appointment } : {}),
  };
}

// Decide what a booking request means for the policy. Old app builds
// (iPhone 1.0.4 and earlier) never send `policyAccepted`, so its absence
// is treated as "older app": the booking goes through and the record says
// so plainly. A current page always sends the key, so a current client
// that did not tick the box is refused. Returns
//   { required: false }
//   { required: true, policy, settings, decision: 'accepted' | 'older_app' }
//   { required: true, policy, settings, decision: 'refused' | 'changed', status, message }
export async function evaluateAcceptance({ workspaceId, body }) {
  const settings = await getPolicySettings(workspaceId);
  if (!settings.requireAcceptance) return { required: false, settings };
  const policy = await getCurrentPolicy(workspaceId);
  if (!policy) return { required: false, settings };
  const b = body && typeof body === 'object' ? body : {};
  if (!Object.prototype.hasOwnProperty.call(b, 'policyAccepted')) {
    return { required: true, policy, settings, decision: 'older_app' };
  }
  if (b.policyAccepted !== true) {
    return {
      required: true, policy, settings, decision: 'refused', status: 400,
      message: 'Please read and agree to the cancellation policy to book.',
    };
  }
  const sent = b.policyVersionId == null ? null : String(b.policyVersionId);
  if (sent && sent !== policy.id) {
    return {
      required: true, policy, settings, decision: 'changed', status: 409,
      message: 'The cancellation policy was just updated. Please read the new version and agree again.',
    };
  }
  return { required: true, policy, settings, decision: 'accepted' };
}

// Refusal body for evaluateAcceptance's refused / changed decisions.
export function refusalBody(ev) {
  return {
    error: ev.message,
    policyRequired: true,
    policy: { versionId: ev.policy.id, version: ev.policy.version, text: ev.policy.text, updatedAt: ev.policy.createdAt },
  };
}

function clip(v, n) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n) : null;
}

// Append one acceptance row. Never throws: a failed write is logged and
// returns null so the booking itself is never lost over the record.
export async function recordAcceptance({
  workspaceId, clientId = null, bookingId = null, policy, status = 'accepted',
  source = 'booking_page', req = null, name = null, email = null, terms = {},
}) {
  if (!workspaceId || !policy) return null;
  try {
    const ip = req ? clip(getClientIp(req), 100) : null;
    const ua = req ? clip(req.headers?.['user-agent'], 500) : null;
    const { rows } = await sql`
      INSERT INTO cancellation_policy_acceptances (
        workspace_id, client_id, booking_id, policy_version_id, policy_version,
        policy_text, policy_sha256, status, source, ip, user_agent,
        name_entered, email_entered, terms
      ) VALUES (
        ${workspaceId}, ${clientId}, ${bookingId}, ${policy.id}, ${policy.version},
        ${policy.text}, ${policy.sha256 || sha256(policy.text)}, ${status}, ${source}, ${ip}, ${ua},
        ${clip(name, 200)}, ${clip(email, 320)}, ${JSON.stringify(terms || {})}::jsonb
      )
      RETURNING *
    `;
    return rows[0] || null;
  } catch (err) {
    console.error('[cancellation-policy] acceptance record failed:', err.message);
    return null;
  }
}

export function serializeAcceptance(row, { withText = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    bookingId: row.booking_id,
    status: row.status,
    source: row.source,
    acceptedAt: row.accepted_at,
    policyVersion: row.policy_version,
    policyVersionId: row.policy_version_id,
    policySha256: row.policy_sha256,
    ...(withText ? { policyText: row.policy_text } : {}),
    ip: row.ip || null,
    userAgent: row.user_agent || null,
    nameEntered: row.name_entered || null,
    emailEntered: row.email_entered || null,
    terms: row.terms || {},
  };
}

export async function listAcceptances({ workspaceId, clientId = null, bookingId = null, limit = 100 }) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 100));
  let rows;
  if (bookingId) {
    ({ rows } = await sql`
      SELECT * FROM cancellation_policy_acceptances
       WHERE workspace_id = ${workspaceId} AND booking_id = ${bookingId}
       ORDER BY accepted_at DESC LIMIT ${lim}
    `);
  } else if (clientId) {
    // Acceptances are permanent and never re-pointed: a client merged into
    // this one keeps its old client id on them (client_merges maps it).
    ({ rows } = await sql`
      SELECT * FROM cancellation_policy_acceptances
       WHERE workspace_id = ${workspaceId}
         AND (client_id = ${clientId}
              OR client_id IN (SELECT removed_client_id FROM client_merges
                                WHERE workspace_id = ${workspaceId} AND current_client_id = ${clientId}))
       ORDER BY accepted_at DESC LIMIT ${lim}
    `);
  } else {
    return [];
  }
  return rows.map((r) => serializeAcceptance(r));
}

// The accepted terms for a booking, if the client accepted any. Used by
// the fee logic so a client is never charged more than they agreed to.
export async function acceptedTermsForBooking({ workspaceId, bookingId }) {
  if (!workspaceId || !bookingId) return null;
  const { rows } = await sql`
    SELECT terms FROM cancellation_policy_acceptances
     WHERE workspace_id = ${workspaceId} AND booking_id = ${bookingId} AND status = 'accepted'
     ORDER BY accepted_at ASC LIMIT 1
  `;
  return rows[0]?.terms || null;
}

// ── Printable record (attach to a payment dispute) ──────────────────────
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

function money(n, currency) {
  const v = Number(n || 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export function formatWhen(ts, tz) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone: tz || 'UTC', timeZoneName: 'short' });
  } catch {
    return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC', timeZoneName: 'short' });
  }
}

function minToLabel(min) {
  const m = Number(min);
  if (!Number.isFinite(m)) return '';
  const h = Math.floor(m / 60), mm = m % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${ap}`;
}

export function termsLines(terms) {
  const t = terms || {};
  const c = t.currency || 'USD';
  const out = [];
  if (t.serviceName) out.push(['Service', t.serviceName]);
  if (Number(t.bookingTotal) > 0) out.push(['Price', money(t.bookingTotal, c)]);
  out.push(['Deposit', Number(t.deposit) > 0 ? money(t.deposit, c) : 'None']);
  const hrs = Number(t.cancellationWindowHours);
  out.push(['Cancellation window', Number.isFinite(hrs) && hrs > 0 ? `${hrs} hour${hrs === 1 ? '' : 's'} before the appointment` : 'None']);
  out.push(['Late cancellation fee', Number(t.lateCancelFee) > 0 ? money(t.lateCancelFee, c) : 'None']);
  out.push(['No-show fee', Number(t.noShowFee) > 0 ? money(t.noShowFee, c) : 'None']);
  if (Number(t.deposit) > 0) {
    out.push(['Deposit if cancelled before the window', t.depositRefundedBeforeWindow === false ? 'Not refunded' : 'Refundable (the business approves each refund)']);
  }
  if (t.appointment?.date) {
    out.push(['Appointment', `${t.appointment.date}${t.appointment.startMin != null ? ` at ${minToLabel(t.appointment.startMin)}` : ''}${t.appointment.timezone ? ` (${t.appointment.timezone})` : ''}`]);
  }
  return out;
}

export const STATUS_LABEL = {
  accepted: 'Accepted',
  not_accepted_older_app: 'Not accepted (booked from an older version of the app that could not show the policy)',
};
export const SOURCE_LABEL = {
  booking_page: 'Online booking page',
  package_booking: 'Booking with package sessions',
  waitlist: 'Waitlist sign-up',
  emailed_link: 'Link the business sent by email',
};

// A self-contained, printable HTML page. Every owner and client string is
// escaped and there is no script at all (the app CSP blocks inline
// script); the page tells the reader to use the browser's Print menu to
// save a PDF.
export function renderAcceptanceRecordHtml({ acceptance, businessName, clientName, clientEmail, timezone, generatedAt = new Date() }) {
  const a = acceptance;
  const rows = [
    ['Business', businessName || ''],
    ['Client', [clientName, clientEmail].filter(Boolean).join(' · ') || '(client record removed)'],
    ['Status', STATUS_LABEL[a.status] || a.status],
    [a.status === 'accepted' ? 'Accepted on' : 'Booked on', formatWhen(a.acceptedAt, timezone)],
    ['Accepted on (UTC)', new Date(a.acceptedAt).toISOString()],
    ['Where', SOURCE_LABEL[a.source] || a.source],
    ['Name typed', a.nameEntered || ''],
    ['Email typed', a.emailEntered || ''],
    ['IP address', a.ip || 'Not recorded'],
    ['Browser / device', a.userAgent || 'Not recorded'],
    ['Booking reference', a.bookingId || 'None'],
    ['Policy version', a.policyVersion != null ? `Version ${a.policyVersion}` : ''],
    ['Policy fingerprint (SHA-256)', a.policySha256 || ''],
    ['Record id', a.id],
  ];
  const tr = (k, v) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;
  const terms = termsLines(a.terms).map(([k, v]) => tr(k, v)).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Cancellation policy record · ${escapeHtml(clientName || 'client')}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1b19; background: #fff; margin: 0; padding: 24px 16px; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #55524c; }
  p.sub { margin: 0 0 18px; color: #55524c; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 7px 10px 7px 0; border-bottom: 1px solid #e6e3dc; word-break: break-word; }
  th { width: 38%; font-weight: 600; color: #3b3934; }
  .policy { white-space: pre-wrap; border: 1px solid #d9d5cc; border-radius: 8px; padding: 14px 16px; background: #faf9f6; word-break: break-word; }
  .note { font-size: 12.5px; color: #55524c; margin-top: 22px; }
  .print { display: inline-block; margin-top: 18px; font-size: 13px; color: #55524c; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head>
<body><main>
<h1>Cancellation policy record</h1>
<p class="sub">${escapeHtml(businessName || '')}. Generated ${escapeHtml(formatWhen(generatedAt, timezone))}.</p>
<table>${rows.map(([k, v]) => tr(k, v)).join('')}</table>
<h2>Fees in effect for this booking</h2>
<table>${terms}</table>
<h2>Exact policy text ${a.status === 'accepted' ? 'the client agreed to' : 'in effect'}</h2>
<div class="policy">${escapeHtml(a.policyText || '')}</div>
<p class="note">${a.status !== 'accepted'
    ? 'This booking was made while the policy switch was on, but from an older version of the app that could not show the policy, so the client did not tick the box. This record cannot be edited.'
    : `${a.source === 'emailed_link'
      ? 'The client opened the link the business emailed them and ticked "I have read and agree to the cancellation policy".'
      : 'The client ticked "I have read and agree to the cancellation policy" before their booking was confirmed.'} The text above is a copy of the policy as it read at that moment; the fingerprint lets anyone check it was not changed afterwards. This record cannot be edited.`}</p>
<p class="print">To save as a PDF, use your browser's Print option and choose "Save as PDF".</p>
</main></body></html>`;
}

export async function workspaceCurrency(workspaceId) {
  try {
    const { rows } = await sql`SELECT currency FROM finance_settings WHERE workspace_id = ${workspaceId} LIMIT 1`;
    return String(rows[0]?.currency || 'USD').toUpperCase();
  } catch {
    return 'USD';
  }
}

// A client who accepted the policy when joining the waitlist gets the
// same acceptance attached to the booking the waitlist later creates
// (a new row: records are never edited).
export async function linkWaitlistAcceptance({ workspaceId, waitlistEntryId, bookingId, clientId }) {
  if (!workspaceId || !waitlistEntryId || !bookingId) return null;
  try {
    const { rows } = await sql`
      SELECT * FROM cancellation_policy_acceptances
       WHERE workspace_id = ${workspaceId} AND source = 'waitlist'
         AND terms->>'waitlistEntryId' = ${String(waitlistEntryId)}
       ORDER BY accepted_at DESC LIMIT 1
    `;
    const w = rows[0];
    if (!w) return null;
    const ins = await sql`
      INSERT INTO cancellation_policy_acceptances (
        workspace_id, client_id, booking_id, policy_version_id, policy_version,
        policy_text, policy_sha256, status, source, accepted_at, ip, user_agent,
        name_entered, email_entered, terms
      ) VALUES (
        ${workspaceId}, ${clientId || w.client_id}, ${bookingId}, ${w.policy_version_id}, ${w.policy_version},
        ${w.policy_text}, ${w.policy_sha256}, ${w.status}, 'waitlist', ${w.accepted_at}, ${w.ip}, ${w.user_agent},
        ${w.name_entered}, ${w.email_entered}, ${JSON.stringify(w.terms || {})}::jsonb
      )
      RETURNING id
    `;
    return ins.rows[0]?.id || null;
  } catch (err) {
    console.error('[cancellation-policy] waitlist link failed:', err.message);
    return null;
  }
}

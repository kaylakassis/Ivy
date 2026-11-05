// Ivy tools for features that shipped with their own screens: appointment
// reminders, package sessions, deposit refunds, the cancellation policy,
// documents from templates, autopay and client portal invites (see
// docs/ivy-capabilities.md).
//
// Same shape as ivyOwnerTools.js: each write is planned in one place. The
// plan checks the call against the owner's own data (every lookup scoped
// to ctx.workspaceId, never to an id in the arguments), words the approval
// card, and is rebuilt and run only when the owner taps Approve. Every
// write here is approval-gated, and each one calls the same server
// function the app's own button calls, so Ivy never has a second copy of
// the money, signing or email logic.
//
// Some tools hold a read and a write behind one `action` (reminder
// settings, the policy, autopay, invite settings) to keep the schemas
// small. The read action runs straight away; every other action is held
// (appToolNeedsApproval below).
//
// Ivy can only ASK a client to approve automatic payments; nothing here
// can approve on the client's behalf (that is authorizeAgreement, which
// only the client's own portal calls).
import { sql } from './db.js';
import { ensureCalendarSettings, saveReminderSettings } from './calendar.js';
import {
  REMINDER_OPTIONS, MAX_REMINDERS, mergeReminderPatch, clientRemindersFrom, ownerRemindersFrom,
  cleanClientOverride, clientOverrideFrom, describeSchedule, beatLabel, sortDesc, sameSet,
  serializeReminderSettings, resolveClientSchedule, serviceFollowsDefault,
} from './reminderSettings.js';
import { applyPackageSession, packageBlockCode, packageErrorMessage } from './packages.js';
import { listDepositReviews, decideDepositRefund } from './bookingFees.js';
import {
  getCurrentPolicy, getPolicySettings, normalizePolicyText, cleanPolicySettingsPatch, updateCancellationPolicy,
  listAcceptances, loadPolicyRequest, sendPolicyAcceptanceRequest, MAX_POLICY_CHARS,
} from './cancellationPolicy.js';
import {
  fetchOwnedDoc, fieldProblemsForSend, sendDocumentForSigning, prepareTemplateSend, sendTemplateToClients,
  voidDocument, resendTarget, resendDocument, MAX_TEMPLATE_RECIPIENTS,
} from './documents.js';
import {
  autopayForSeries, autopayAvailability, requestAutopay, ownerTurnOff, seriesTotalCents, AutopayError,
} from './autopay.js';
import { CADENCE_WORDS, cardLong, fmtAmount, invoiceAutopayLine, seriesAutopayLabel } from '../../src/lib/autopayRules.js';
import { serializeInvoice } from './finance.js';
import { setInviteNewClients, resendInviteProblem, resendClientInvite } from './clientNotify.js';
import { recordWorkspaceAudit } from './audit.js';
import { fetchBranding } from './branding.js';
import { listDuplicatePairs, dismissDuplicatePair } from './clientDuplicates.js';
import { mergePreview, mergeRefusal, mergeClients, mergeSentence, mergeNames, movesPhrase, cleanFieldChoices } from './clientMerge.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── tool definitions (compact: sent with every request) ───────────────
export const APP_TOOLS = [
  {
    name: 'reminder_settings',
    description: "Appointment reminders. get (client_id adds that client's own setting). update: audience clients|owner with enabled, minutes, channels; or client_id with mode default|off|custom (+minutes) for one client.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update'] },
        audience: { type: 'string', enum: ['clients', 'owner'] },
        enabled: { type: 'boolean' },
        minutes: { type: 'array', items: { type: 'integer' }, description: `Minutes before, up to ${MAX_REMINDERS} of ${REMINDER_OPTIONS.join(',')}` },
        channels: { type: 'object', properties: { email: { type: 'boolean' }, sms: { type: 'boolean' }, push: { type: 'boolean' } } },
        client_id: { type: 'string' },
        mode: { type: 'string', enum: ['default', 'off', 'custom'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'use_package_session',
    description: "Pay for a booking made without a package with one session from the client's package. client_package_id can be left out when the client has one usable package.",
    input_schema: { type: 'object', properties: { booking_id: { type: 'string' }, client_package_id: { type: 'string' } }, required: ['booking_id'] },
  },
  {
    name: 'list_deposit_reviews',
    description: 'Cancelled bookings whose paid deposit waits for a Refund or Keep decision.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'review_deposit_refund',
    description: 'Decide a deposit from list_deposit_reviews: refund (money back to the client) or keep.',
    input_schema: {
      type: 'object',
      properties: { booking_id: { type: 'string' }, decision: { type: 'string', enum: ['refund', 'keep'] } },
      required: ['booking_id', 'decision'],
    },
  },
  {
    name: 'cancellation_policy',
    description: 'Cancellation policy. get: wording, version, switches, per-service fees. set_text: new wording (plain text; fee amounts come from each service). set_switches: change any of the booleans.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set_text', 'set_switches'] },
        text: { type: 'string' },
        require_acceptance: { type: 'boolean', description: 'Clients must accept it when they book.' },
        show_on_booking_page: { type: 'boolean' },
        show_in_site_footer: { type: 'boolean' },
        refund_deposit_outside_window: { type: 'boolean', description: 'Deposit refundable when the client cancels before the window.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'list_policy_acceptances',
    description: 'Cancellation policy acceptance records, newest first: one client, or the latest across the business.',
    input_schema: { type: 'object', properties: { client_id: { type: 'string' } } },
  },
  {
    name: 'send_policy_for_acceptance',
    description: "Email a booking's client a link to read and accept the current cancellation policy.",
    input_schema: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] },
  },
  {
    name: 'send_document_from_template',
    description: `Send a document template for e-signature: each client gets their own copy. Up to ${MAX_TEMPLATE_RECIPIENTS} clients. owner_signs: the owner signs too, first or last.`,
    input_schema: {
      type: 'object',
      properties: {
        template_id: { type: 'string' },
        client_ids: { type: 'array', items: { type: 'string' } },
        owner_signs: { type: 'string', enum: ['first', 'last'] },
      },
      required: ['template_id', 'client_ids'],
    },
  },
  {
    name: 'void_document',
    description: 'Void a sent document so its signing link stops working.',
    input_schema: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'] },
  },
  {
    name: 'resend_document',
    description: 'Email the current signer of a sent document a reminder with a fresh link.',
    input_schema: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'] },
  },
  {
    name: 'autopay',
    description: 'Automatic card payments for recurring invoices. status: every series, or series_id / invoice_id. request: email the client to approve (only the client can approve). turn_off: end it for a series.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'request', 'turn_off'] },
        series_id: { type: 'string' }, invoice_id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'client_invite_settings',
    description: 'The "Invite new clients automatically" switch (portal invite email for new clients). get or update.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['get', 'update'] }, invite_new_clients: { type: 'boolean' } },
      required: ['action'],
    },
  },
  {
    name: 'resend_client_invite',
    description: 'Email a client a reminder to set up their client portal account.',
    input_schema: { type: 'object', properties: { client_id: { type: 'string' } }, required: ['client_id'] },
  },
  {
    name: 'find_duplicate_clients',
    description: 'Possible duplicate clients (same email, same phone, similar name): each pair with reasons, record counts and which one to keep.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'Pairs to return, default 20, max 50.' } } },
  },
  {
    name: 'merge_clients',
    description: "Merge two records of the same person: everything on remove_client_id (bookings, invoices, messages, documents, packages, history) moves to keep_client_id, then remove_client_id is removed. field_choices: per field 'keep' (default) or 'remove' = whose value wins. No undo.",
    input_schema: {
      type: 'object',
      properties: {
        keep_client_id: { type: 'string' },
        remove_client_id: { type: 'string' },
        field_choices: {
          type: 'object',
          properties: Object.fromEntries(['name', 'email', 'phone', 'address', 'birthday', 'stage']
            .map((f) => [f, { type: 'string', enum: ['keep', 'remove'] }])),
        },
      },
      required: ['keep_client_id', 'remove_client_id'],
    },
  },
  {
    name: 'dismiss_duplicate',
    description: 'Mark two clients from find_duplicate_clients as different people so the pair is never suggested again.',
    input_schema: {
      type: 'object',
      properties: { client_id_a: { type: 'string' }, client_id_b: { type: 'string' } },
      required: ['client_id_a', 'client_id_b'],
    },
  },
];

// Tools that only read; tools with a read action; everything else writes.
export const APP_READ_ONLY = ['list_deposit_reviews', 'list_policy_acceptances', 'find_duplicate_clients'];
const READ_ACTION = { reminder_settings: 'get', cancellation_policy: 'get', autopay: 'status', client_invite_settings: 'get' };
export const APP_MIXED = new Set(Object.keys(READ_ACTION));
// Always held for approval (by name). send_document is an older tool whose
// plan now lives here.
export const APP_SENSITIVE = [
  ...APP_TOOLS.map((t) => t.name).filter((n) => !APP_READ_ONLY.includes(n) && !APP_MIXED.has(n)),
  'send_document',
];
// Every tool whose writes this module plans (for the ledger and the Done text).
export const APP_WRITE_TOOLS = new Set([...APP_SENSITIVE, ...APP_MIXED]);

export function appCallIsRead(name, args) {
  if (APP_READ_ONLY.includes(name)) return true;
  if (APP_MIXED.has(name)) return String(args?.action || '') === READ_ACTION[name];
  return false;
}
// A mixed tool is held unless it is its read action (an unknown action is
// held too, then refused by its plan before any card appears).
export function appToolNeedsApproval(name, args) {
  return APP_MIXED.has(name) && !appCallIsRead(name, args);
}

// ── helpers ────────────────────────────────────────────────────────────
const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const isoOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
function fmtDay(d) {
  const dt = new Date(`${isoOf(d)}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return isoOf(d) || '?';
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtStamp(ts) {
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function fmtMin(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '?';
  const h = Math.floor(n / 60), mm = n % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'the client';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function nameList(names, max = 8) {
  const shown = names.slice(0, max);
  const more = names.length > max ? ` and ${names.length - max} more` : '';
  return `${shown.join(', ')}${more}`;
}
function needId(v, what, listTool) {
  const id = String(v || '').trim();
  if (!UUID_RE.test(id)) throw new Error(`${what} is required (get it from ${listTool})`);
  return id;
}
// "1 day, 8 hours, 1 hour" (the "was" part of a reminder card).
const beatList = (mins) => sortDesc((mins || []).map(Number)).map(beatLabel).join(', ') || 'none';
// Did a client email really go out? sendEmailToClient answers { ok, sent,
// reason }: a muted client or the daily cap is sent:false, not an error.
function emailWhy(r) {
  if (!r) return 'no answer from the email service';
  if (r.reason === 'muted') return 'the client turned off this kind of email';
  if (r.reason === 'workspace-quota-exceeded') return "today's email limit was reached";
  return r.reason || 'it was skipped';
}
const emailed = (r) => !!(r && r.sent);
// The money paths write an audit row like the app's buttons do (no request
// here: Ivy acts as the signed-in owner, recorded with via: 'ivy').
function audit(ctx, action, target, meta = {}) {
  return recordWorkspaceAudit(null, {
    workspaceId: ctx.workspaceId, actor: { id: ctx.userId || null }, action, target, meta: { ...meta, via: 'ivy' },
  });
}

// ── reminders ──────────────────────────────────────────────────────────
const CHANNEL_WORDS = { email: 'Email', sms: 'Text (SMS)', push: 'App notification' };

async function planReminders(ws, a) {
  if (a.action !== 'update') throw new Error('action must be get or update');
  if (a.client_id) return planClientReminder(ws, a);
  const audience = a.audience;
  if (audience !== 'clients' && audience !== 'owner') throw new Error('audience must be clients or owner (or pass client_id for one client)');
  const body = {};
  if (a.enabled != null) {
    if (typeof a.enabled !== 'boolean') throw new Error('enabled must be true or false');
    body.enabled = a.enabled;
  }
  if (a.minutes != null) body.minutes = a.minutes;
  if (a.channels != null) {
    if (audience === 'owner' && a.channels && typeof a.channels === 'object' && 'sms' in a.channels) {
      throw new Error('Your own reminders come by email or app notification, not text');
    }
    body.channels = a.channels;
  }
  if (!Object.keys(body).length) throw new Error('Nothing to change: pass enabled, minutes or channels');
  const row = await ensureCalendarSettings(ws);
  const merged = mergeReminderPatch(row, { [audience]: body });
  if (merged.error) throw new Error(merged.error);
  const before = audience === 'clients' ? clientRemindersFrom(row.client_reminders ?? null) : ownerRemindersFrom(row.owner_reminders ?? null);
  const after = merged[audience];
  const who = audience === 'clients' ? 'Clients get' : 'You get';
  const parts = [];
  if (before.enabled !== after.enabled) {
    parts.push(audience === 'clients'
      ? (after.enabled ? `Reminders to clients: on (${describeSchedule(after.minutes)})` : 'Reminders to clients: off (no client gets one until you turn them back on)')
      : (after.enabled ? 'Your own appointment reminders: on' : 'Your own appointment reminders: off (clients still get theirs)'));
  }
  if (!sameSet(before.minutes, after.minutes)) {
    parts.push(`${who} reminders ${describeSchedule(after.minutes)} (was ${beatList(before.minutes)})`);
  }
  for (const k of Object.keys(after.channels)) {
    if (before.channels[k] !== after.channels[k]) {
      parts.push(`${CHANNEL_WORDS[k]} reminders ${audience === 'clients' ? 'to clients' : 'to you'}: ${after.channels[k] ? 'on' : 'off'}`);
    }
  }
  if (!parts.length) throw new Error('Nothing changes: reminders are already set that way');
  let note = '';
  if (audience === 'clients' && !sameSet(before.minutes, after.minutes)) {
    const [svc, cl] = await Promise.all([
      sql`SELECT reminder_minutes, reminders_use_default FROM services WHERE workspace_id = ${ws}`,
      sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${ws} AND reminder_settings IS NOT NULL`,
    ]);
    const ownSvc = svc.rows.filter((s) => !serviceFollowsDefault(s)).length;
    const ownCl = cl.rows[0].n;
    if (ownSvc || ownCl) {
      note = ` ${[ownSvc ? plural(ownSvc, 'service') : null, ownCl ? plural(ownCl, 'client') : null].filter(Boolean).join(' and ')} with their own reminder times keep them.`;
    }
  }
  return {
    summary: `Change appointment reminders: ${parts.join('. ')}.${note}`,
    done: `Changed appointment reminders: ${parts.join('. ')}`,
    apply: async () => {
      const fresh = await ensureCalendarSettings(ws);
      const m = mergeReminderPatch(fresh, { [audience]: body });
      if (m.error) throw new Error(m.error);
      const saved = await saveReminderSettings(ws, m);
      return { ok: true, reminders: serializeReminderSettings(saved)[audience] };
    },
  };
}

function overrideWords(ov, biz) {
  if (ov.mode === 'off') return 'no appointment reminders';
  if (ov.mode === 'custom') return `reminders ${describeSchedule(ov.minutes)}`;
  return biz.enabled ? `your business reminders (${describeSchedule(biz.minutes)})` : 'your business reminders (off for all clients right now)';
}

async function planClientReminder(ws, a) {
  const id = needId(a.client_id, 'client_id', 'search_clients');
  const c = (await sql`SELECT id, name, reminder_settings, notification_prefs FROM clients WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!c) throw new Error('Client not found');
  const mode = String(a.mode || '');
  if (!['default', 'off', 'custom'].includes(mode)) throw new Error('mode must be default, off or custom');
  const cleaned = cleanClientOverride(mode === 'custom' ? { mode, minutes: a.minutes } : { mode });
  if (cleaned.error) throw new Error(cleaned.error);
  const row = await ensureCalendarSettings(ws);
  const biz = clientRemindersFrom(row.client_reminders ?? null);
  const before = clientOverrideFrom(c.reminder_settings);
  const after = clientOverrideFrom(cleaned.value);
  if (before.mode === after.mode && (after.mode !== 'custom' || sameSet(before.minutes, after.minutes))) {
    throw new Error(`Nothing changes: ${c.name} already gets ${overrideWords(before, biz)}`);
  }
  const optedOut = (c.notification_prefs || {}).reminders === false;
  const nm = clip(c.name, 60);
  return {
    summary: `${nm} gets ${overrideWords(after, biz)} (was ${overrideWords(before, biz)}).${optedOut ? ` ${firstName(c.name)} turned reminders off in their portal, so they still get none until they turn them back on.` : ''}`,
    done: `${nm} now gets ${overrideWords(after, biz)}`,
    apply: async () => {
      const r = await sql`
        UPDATE clients SET reminder_settings = ${cleaned.value ? JSON.stringify(cleaned.value) : null}::jsonb, updated_at = NOW()
         WHERE id = ${id} AND workspace_id = ${ws} RETURNING reminder_settings`;
      if (!r.rows.length) throw new Error('Client not found');
      return { ok: true, client_id: id, reminder_settings: clientOverrideFrom(r.rows[0].reminder_settings) };
    },
  };
}

async function readReminders(ws, a) {
  const row = await ensureCalendarSettings(ws);
  const s = serializeReminderSettings(row);
  const out = {
    clients: { ...s.clients, schedule: s.clients.enabled ? describeSchedule(s.clients.minutes) : 'off' },
    owner: { ...s.owner, schedule: s.owner.enabled ? describeSchedule(s.owner.minutes) : 'off' },
    allowed_minutes: REMINDER_OPTIONS, max_reminders: MAX_REMINDERS,
    manage: '[Reminder settings](/calendar?reminders=1)',
  };
  if (a.client_id) {
    const id = needId(a.client_id, 'client_id', 'search_clients');
    const c = (await sql`SELECT id, name, reminder_settings, notification_prefs FROM clients WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
    if (!c) throw new Error('Client not found');
    const eff = resolveClientSchedule({ business: clientRemindersFrom(row.client_reminders ?? null), client: c });
    out.client = {
      name: c.name, setting: clientOverrideFrom(c.reminder_settings),
      gets: eff.minutes.length ? describeSchedule(eff.minutes) : 'no reminders',
      why: eff.source, opted_out_in_portal: (c.notification_prefs || {}).reminders === false,
    };
  }
  return out;
}

// ── packages ───────────────────────────────────────────────────────────
async function planUsePackage(ws, a) {
  const id = needId(a.booking_id, 'booking_id', 'search_bookings or list_upcoming_bookings');
  const b = (await sql`
    SELECT b.*, s.name AS service_name, c.name AS c_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
     WHERE b.id = ${id} AND b.workspace_id = ${ws}`).rows[0];
  if (!b) throw new Error('Booking not found');
  if (b.cancelled_at) throw new Error("Can't use a package on a cancelled booking");
  if (!b.client_id) throw new Error('This booking has no client record');
  if (b.recurrence_rule) throw new Error(packageErrorMessage('package_recurring_unsupported', 'owner'));
  if (b.client_package_id) throw new Error('This booking already uses a package session');
  const who = clip(b.c_name || b.client_name || 'the client', 60);
  const { rows: pkgs } = await sql`
    SELECT * FROM client_packages WHERE workspace_id = ${ws} AND client_id = ${b.client_id}
     ORDER BY created_at ASC LIMIT 50`;
  let cp;
  if (a.client_package_id) {
    const pid = String(a.client_package_id);
    cp = UUID_RE.test(pid) ? pkgs.find((p) => p.id === pid) : null;
    if (!cp) throw new Error(packageErrorMessage('package_not_found', 'owner'));
  } else {
    const usable = pkgs.filter((p) => !packageBlockCode(p, b.service_id));
    if (!usable.length) throw new Error(`${who} has no package that can pay for this appointment${pkgs.length ? ` (their packages: ${pkgs.map((p) => `"${clip(p.name, 40)}"`).join(', ')})` : ''}`);
    if (usable.length > 1) {
      throw new Error(`${who} has more than one package that covers this. Ask which one, then pass client_package_id: ${usable.map((p) => `"${clip(p.name, 40)}" (${p.credits_remaining} left) = ${p.id}`).join('; ')}`);
    }
    cp = usable[0];
  }
  const code = packageBlockCode(cp, b.service_id);
  if (code) throw new Error(packageErrorMessage(code, 'owner'));
  const left = Number(cp.credits_remaining);
  const appt = `${b.service_name ? `${clip(b.service_name, 50)} ` : ''}on ${fmtDay(b.date)} at ${fmtMin(b.start_min)}`;
  const pkgName = `"${clip(cp.name, 50)}"`;
  return {
    summary: `Use 1 session from ${who}'s ${pkgName} package to pay for their appointment ${appt}. ${left} of ${cp.credits_total} sessions left now, ${left - 1} after.`,
    done: `Used 1 session from ${who}'s ${pkgName} package for their appointment ${appt}`,
    apply: async () => {
      const fresh = (await sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
      if (!fresh) throw new Error('Booking not found');
      const out = await applyPackageSession({ workspaceId: ws, booking: fresh, clientPackageId: cp.id });
      if (out.error) throw new Error(out.error);
      if (out.refusal) throw new Error(packageErrorMessage(out.refusal.code, 'owner'));
      if (out.alreadyApplied) throw new Error('This booking already uses that package');
      return { ok: true, booking_id: id, package: { id: cp.id, name: cp.name, sessions_left: out.package.creditsRemaining } };
    },
  };
}

// ── deposits ───────────────────────────────────────────────────────────
async function planDepositDecision(ws, a, ctx) {
  const id = needId(a.booking_id, 'booking_id', 'list_deposit_reviews');
  const decision = String(a.decision || '');
  if (decision !== 'refund' && decision !== 'keep') throw new Error('decision must be refund or keep');
  const b = (await sql`
    SELECT b.client_name, b.deposit_refund_request_status AS st, b.deposit_refund_request_amount AS amt,
           b.deposit_refund_request_reason AS reason, c.name AS c_name, COALESCE(fs.currency, 'USD') AS currency
      FROM bookings b
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
      LEFT JOIN finance_settings fs ON fs.workspace_id = b.workspace_id
     WHERE b.id = ${id} AND b.workspace_id = ${ws}`).rows[0];
  if (!b) throw new Error('Booking not found');
  if (b.st !== 'pending') {
    throw new Error(b.st ? `That deposit was already decided (${b.st === 'kept' ? 'kept' : 'refund approved'})` : 'That booking has no deposit waiting for a decision (see list_deposit_reviews)');
  }
  const first = clip(firstName(b.c_name || b.client_name), 40);
  const cur = String(b.currency || 'USD').toUpperCase();
  const amt = fmtAmount(Math.round(Number(b.amt || 0) * 100), cur);
  const why = b.reason ? ` (${clip(b.reason, 120)})` : '';
  const refund = decision === 'refund';
  return {
    summary: refund
      ? `Refund ${first}'s ${amt} deposit?${why} The money goes back to their card and they get a receipt by email.`
      : `Keep ${first}'s ${amt} deposit${why}. Nothing is refunded and the request is closed.`,
    done: refund ? `Refunded ${first}'s ${amt} deposit` : `Kept ${first}'s ${amt} deposit (nothing refunded)`,
    apply: async () => {
      const out = await decideDepositRefund({ workspaceId: ws, bookingId: id, decision, userId: ctx?.userId || null });
      if (out.notFound) throw new Error('Booking not found');
      if (out.alreadyDecided) throw new Error(`That deposit was already decided (${out.status === 'kept' ? 'kept' : 'refund approved'})`);
      if (out.error) throw new Error(`The refund did not go through (${out.error}). It is still waiting in Deposits to review`);
      await audit(ctx, refund ? 'booking.deposit_refund_approved' : 'booking.deposit_kept', { kind: 'booking', id },
        refund ? { amount: (out.refunded || 0) / 100 } : {});
      return { ok: true, booking_id: id, decision, refunded: refund ? (out.refunded || 0) / 100 : 0 };
    },
  };
}

async function readDepositReviews({ workspaceId }) {
  const rows = await listDepositReviews(workspaceId);
  return {
    deposits: rows.map((r) => ({
      booking_id: r.bookingId, client: r.clientName, service: r.serviceName, date: r.date, time: fmtMin(r.startMin),
      amount: fmtAmount(Math.round(r.amount * 100), r.currency), reason: r.reason,
      cancelled_by: r.cancelledBy === 'owner' ? 'you' : 'the client',
    })),
    manage: '[Calendar](/calendar)',
  };
}

// ── cancellation policy ────────────────────────────────────────────────
const SWITCH_ARGS = {
  require_acceptance: 'requireAcceptance', show_on_booking_page: 'showOnBookingPage',
  show_in_site_footer: 'showInSiteFooter', refund_deposit_outside_window: 'refundDepositOutsideWindow',
};
const SWITCH_WORDS = {
  requireAcceptance: ['Clients must tick a box to accept your cancellation policy when they book', 'Clients no longer have to accept your cancellation policy when they book'],
  showOnBookingPage: ['Show your cancellation policy on your booking page', 'Hide your cancellation policy from your booking page'],
  showInSiteFooter: ['Link your cancellation policy in your website footer', 'Remove the cancellation policy link from your website footer'],
  refundDepositOutsideWindow: [
    'A client who cancels before the cancellation window can get their deposit back (you approve each refund)',
    'Deposits are kept even when a client cancels in time (no refund requests)',
  ],
};

async function planPolicy(ws, a, ctx) {
  if (a.action === 'set_text') {
    if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('text is required (plain text)');
    if (a.text.length > MAX_POLICY_CHARS * 2) throw new Error(`Keep your policy under ${MAX_POLICY_CHARS} characters.`);
    const norm = normalizePolicyText(a.text);
    if (norm.error) throw new Error(norm.error);
    const [cur, settings] = await Promise.all([getCurrentPolicy(ws), getPolicySettings(ws)]);
    if (cur && cur.text === norm.text) throw new Error('That is already your policy wording');
    const where = settings.showOnBookingPage ? 'Clients see the new wording on your booking page from now on' : 'It is not shown on your booking page (that switch is off)';
    return {
      summary: cur
        ? `Replace your cancellation policy (version ${cur.version}) with version ${cur.version + 1}: "${clip(norm.text, 300)}". ${where}; acceptances already recorded keep the version each client agreed to.`
        : `Save your cancellation policy: "${clip(norm.text, 300)}". ${where}.`,
      done: `Saved your cancellation policy as version ${cur ? cur.version + 1 : 1}`,
      apply: async () => {
        const out = await updateCancellationPolicy({ workspaceId: ws, userId: ctx?.userId || null, body: { text: a.text } });
        if (out.error) throw new Error(out.error);
        if (out.createdVersion) {
          await audit(ctx, 'cancellation_policy.update', { kind: 'cancellation_policy', id: out.createdVersion.id },
            { version: out.createdVersion.version, sha256: out.createdVersion.sha256 });
        }
        return { ok: true, version: out.createdVersion?.version || cur?.version || null };
      },
    };
  }
  if (a.action === 'set_switches') {
    const body = {};
    for (const [arg, key] of Object.entries(SWITCH_ARGS)) if (a[arg] !== undefined) body[key] = a[arg];
    const { patch, error } = cleanPolicySettingsPatch(body);
    if (error) throw new Error(error.replace(/^(\w+)/, (k) => Object.keys(SWITCH_ARGS).find((x) => SWITCH_ARGS[x] === k) || k));
    if (!Object.keys(patch).length) throw new Error(`Nothing to change: pass ${Object.keys(SWITCH_ARGS).join(', ')}`);
    const before = await getPolicySettings(ws);
    const changes = Object.keys(patch).filter((k) => before[k] !== patch[k]);
    if (!changes.length) throw new Error('Nothing changes: those switches are already set that way');
    if (patch.requireAcceptance === true && !(await getCurrentPolicy(ws))) {
      throw new Error('Write your cancellation policy first, then turn this on.');
    }
    const parts = changes.map((k) => SWITCH_WORDS[k][patch[k] ? 0 : 1]);
    return {
      summary: `Change your cancellation policy settings: ${parts.join('. ')}.`,
      done: `Changed your cancellation policy settings: ${parts.join('. ')}`,
      apply: async () => {
        const out = await updateCancellationPolicy({ workspaceId: ws, userId: ctx?.userId || null, body: patch });
        if (out.error) throw new Error(out.error);
        if (out.changed.length) {
          await audit(ctx, 'cancellation_policy.update', { kind: 'cancellation_policy', id: ws },
            { settings: Object.fromEntries(out.changed.map((k) => [k, out.after[k]])) });
        }
        return { ok: true, settings: out.after };
      },
    };
  }
  throw new Error('action must be get, set_text or set_switches');
}

async function readPolicy(ws) {
  const [policy, settings, svc] = await Promise.all([
    getCurrentPolicy(ws), getPolicySettings(ws),
    sql`SELECT name, deposit_type, deposit_amount, cancellation_fee_amount, cancellation_window_hours, no_show_fee_amount
          FROM services WHERE workspace_id = ${ws} AND visibility <> 'only_me' ORDER BY display_order, created_at LIMIT 100`,
  ]);
  return {
    policy: policy ? { version: policy.version, text: policy.text, saved_at: policy.createdAt } : null,
    settings,
    service_fees: svc.rows.map((s) => ({
      service: s.name,
      deposit: s.deposit_type && s.deposit_type !== 'none' ? `${s.deposit_type === 'percent' ? `${Number(s.deposit_amount)}%` : fmtAmount(Math.round(Number(s.deposit_amount || 0) * 100))}` : null,
      late_cancel_fee: Number(s.cancellation_fee_amount || 0), window_hours: s.cancellation_window_hours ?? 24,
      no_show_fee: Number(s.no_show_fee_amount || 0),
    })),
    manage: '[Finance](/finance), Services',
  };
}

async function readAcceptances({ workspaceId, args }) {
  const compact = (r) => ({
    client: r.client || undefined, client_id: r.clientId, booking_id: r.bookingId, status: r.status, source: r.source,
    accepted_at: r.acceptedAt, policy_version: r.policyVersion, terms: r.terms,
  });
  if (args?.client_id) {
    const id = needId(args.client_id, 'client_id', 'search_clients');
    const c = (await sql`SELECT name FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
    if (!c) throw new Error('Client not found');
    const list = await listAcceptances({ workspaceId, clientId: id, limit: 25 });
    return { client: c.name, acceptances: list.map(compact) };
  }
  const { rows } = await sql`
    SELECT COALESCE(cm.current_client_id, a.client_id) AS client_id, a.booking_id, a.status, a.source, a.accepted_at,
           a.policy_version, a.terms, c.name AS client_name
      FROM cancellation_policy_acceptances a
      LEFT JOIN client_merges cm ON cm.workspace_id = a.workspace_id AND cm.removed_client_id = a.client_id
      LEFT JOIN clients c ON c.id = COALESCE(cm.current_client_id, a.client_id) AND c.workspace_id = a.workspace_id
     WHERE a.workspace_id = ${workspaceId}
     ORDER BY a.accepted_at DESC LIMIT 25`;
  return {
    acceptances: rows.map((r) => compact({
      client: r.client_name, clientId: r.client_id, bookingId: r.booking_id, status: r.status, source: r.source,
      acceptedAt: r.accepted_at, policyVersion: r.policy_version, terms: r.terms || {},
    })),
  };
}

async function planPolicyRequest(ws, a) {
  const id = needId(a.booking_id, 'booking_id', 'search_bookings or list_upcoming_bookings');
  const loaded = await loadPolicyRequest({ workspaceId: ws, bookingId: id });
  if (loaded.error) throw new Error(loaded.error);
  const b = loaded.booking;
  const who = `${clip(b.client_name || 'the client', 60)} (${b.client_email})`;
  return {
    summary: `Email ${who} a link to read and accept your cancellation policy (version ${loaded.policy.version}) for their ${clip(b.service_name || 'appointment', 50)} on ${fmtDay(b.date)}. The link works once and expires in 30 days.`,
    done: `Emailed ${who} your cancellation policy to accept`,
    apply: async () => {
      const out = await sendPolicyAcceptanceRequest({ workspaceId: ws, bookingId: id });
      if (out.error) throw new Error(out.error);
      if (!out.sent) throw new Error(`The email to ${out.sentTo} did not go out (${emailWhy(out)})`);
      return { ok: true, sent_to: out.sentTo };
    },
  };
}

// ── documents ──────────────────────────────────────────────────────────
// send_document (single client, the older tool) runs the Send button's own
// path: fieldProblemsForSend, then sendDocumentForSigning.
async function planSendDocument(ws, a) {
  const id = needId(a.document_id, 'document_id', 'list_documents');
  const clientId = needId(a.client_id, 'client_id', 'search_clients');
  const doc = await fetchOwnedDoc({ id, workspaceId: ws });
  if (!doc) throw new Error('Document not found');
  if (doc.is_template) throw new Error('That is a template: use send_document_from_template');
  if (doc.status === 'completed') throw new Error('Already completed');
  if (doc.status === 'voided') throw new Error('Document is voided - restore first');
  if (doc.status === 'declined') throw new Error('Document was declined - restore to draft first');
  const c = (await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${ws}`).rows[0];
  if (!c) throw new Error('Unknown client');
  const email = String(c.email || '').toLowerCase().trim();
  if (!email) throw new Error('Client has no email on file');
  const problem = fieldProblemsForSend(doc, 1);
  if (problem) throw new Error(problem);
  const name = String(c.name || email).slice(0, 200);
  const dn = `"${clip(doc.name, 60)}"`;
  return {
    summary: `Send the document ${dn} to ${clip(name, 60)} (${email}) for e-signature. They get an email with a signing link${doc.status === 'sent' ? '; the link sent before stops working' : ''}.`,
    done: `Sent ${dn} to ${email} to sign`,
    apply: async () => {
      const fresh = await fetchOwnedDoc({ id, workspaceId: ws });
      if (!fresh) throw new Error('Document not found');
      if (['completed', 'voided', 'declined'].includes(fresh.status)) throw new Error(`The document is ${fresh.status} now`);
      const r = await sendDocumentForSigning({ workspaceId: ws, doc: fresh, recipients: [{ clientId, name, email }] });
      if (!emailed(r.emailResult)) {
        return {
          ok: true, document_id: id, sent_to: email, email_delivered: false,
          done: `Marked ${dn} sent to ${email}, but the signing email did not go out`,
          warnings: [`The signing email to ${email} did not go out (${emailWhy(r.emailResult)}). The document is marked sent.`],
        };
      }
      return { ok: true, document_id: id, sent_to: email };
    },
  };
}

async function ownerIdentity(ctx) {
  const u = ctx?.userId ? (await sql`SELECT name, email FROM users WHERE id = ${ctx.userId}`).rows[0] : null;
  const branding = await fetchBranding(ctx.workspaceId).catch(() => ({}));
  return { email: u?.email || '', name: u?.name || branding.businessName || 'Business owner' };
}

async function planSendTemplate(ws, a, ctx) {
  needId(a.template_id, 'template_id', 'list_documents with templates_only');
  if (!Array.isArray(a.client_ids) || a.client_ids.length === 0) throw new Error('client_ids is required (a list of client ids)');
  if (a.client_ids.length > MAX_TEMPLATE_RECIPIENTS) throw new Error(`Up to ${MAX_TEMPLATE_RECIPIENTS} clients at a time`);
  if (a.owner_signs != null && a.owner_signs !== 'first' && a.owner_signs !== 'last') throw new Error('owner_signs must be first or last');
  const owner = a.owner_signs ? await ownerIdentity(ctx) : null;
  const args = { workspaceId: ws, templateId: a.template_id, clientIds: a.client_ids, ownerSigns: a.owner_signs || null, owner };
  const prep = await prepareTemplateSend(args);
  if (prep.error) throw new Error(prep.error);
  const skippedBit = prep.skipped.length
    ? ` Skipped: ${prep.skipped.map((s) => `${s.name ? clip(s.name, 40) : 'an unknown client'} (${s.reason})`).join(', ')}.`
    : '';
  if (!prep.sendTo.length) throw new Error(`None of those clients can get it.${skippedBit}`);
  const n = prep.sendTo.length;
  const tn = `"${clip(prep.template.name, 60)}"`;
  const ownerBit = prep.ownerSigns === 'first'
    ? ` You sign each copy first (your links go to ${owner.email}); each client gets theirs after you sign.`
    : prep.ownerSigns === 'last' ? ` You sign each copy after the client (your link goes to ${owner.email}).` : '';
  return {
    summary: `Send ${tn} for e-signature to ${plural(n, 'client')}: ${nameList(prep.sendTo.map((c) => clip(c.name, 40)))}. Each gets their own copy${prep.ownerSigns === 'first' ? '' : ' by email'}.${ownerBit}${skippedBit}`,
    done: `Sent ${tn} to ${plural(n, 'client')} for e-signature`,
    apply: async () => {
      const out = await sendTemplateToClients({ ...args, owner: a.owner_signs ? await ownerIdentity(ctx) : null });
      if (out.error) throw new Error(out.error);
      const notEmailed = out.sent.filter((s) => !s.emailed).length;
      const warnings = notEmailed
        ? [`${plural(notEmailed, 'signing email')} did not go out (a client may have turned off document emails). Those copies are marked sent; you can resend them from Documents.`]
        : [];
      return {
        ok: true, sent: out.sent.map((s) => ({ client_id: s.clientId, document_id: s.documentId })), skipped: out.skipped,
        done: `Sent ${tn} to ${plural(out.sent.length, 'client')} for e-signature`,
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}

async function planVoidDocument(ws, a) {
  const id = needId(a.document_id, 'document_id', 'list_documents');
  const doc = await fetchOwnedDoc({ id, workspaceId: ws });
  if (!doc) throw new Error('Document not found');
  if (doc.status === 'completed') throw new Error("Can't void a completed document");
  if (doc.status === 'voided') throw new Error('That document is already void');
  const dn = `"${clip(doc.name, 60)}"`;
  const to = doc.recipient_name || doc.recipient_email;
  return {
    summary: `Void the document ${dn}${to ? ` (sent to ${clip(to, 60)})` : ''}. ${doc.status === 'sent' ? 'Its signing link stops working right away. ' : ''}Nobody is emailed. You can edit it and send it again later.`,
    done: `Voided ${dn}; its signing link no longer works`,
    apply: async () => {
      const out = await voidDocument({ workspaceId: ws, id });
      if (out.error) throw new Error(out.error);
      return { ok: true, document_id: id, status: out.row.status };
    },
  };
}

async function planResendDocument(ws, a) {
  const id = needId(a.document_id, 'document_id', 'list_documents');
  const found = await resendTarget({ workspaceId: ws, id });
  if (found.error) throw new Error(found.error);
  const { doc, target } = found;
  const dn = `"${clip(doc.name, 60)}"`;
  const who = `${clip(target.name || target.email, 60)} (${target.email})`;
  return {
    summary: `Email ${who} a reminder to sign ${dn}. A new signing link replaces the one sent before.`,
    done: `Emailed ${who} a reminder to sign ${dn}`,
    apply: async () => {
      const out = await resendDocument({ workspaceId: ws, id });
      if (out.error) throw new Error(out.error);
      if (!emailed(out.emailResult)) throw new Error(`A new signing link was made, but the email to ${out.target.email} did not go out (${emailWhy(out.emailResult)})`);
      return { ok: true, document_id: id, sent_to: out.target.email };
    },
  };
}

// ── autopay ────────────────────────────────────────────────────────────
async function loadSeriesFor(ws, seriesId) {
  const id = needId(seriesId, 'series_id', 'autopay with action status');
  const s = (await sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!s) throw new Error('Recurring invoice not found');
  return s;
}

async function planAutopay(ws, a, ctx) {
  if (a.action !== 'request' && a.action !== 'turn_off') throw new Error('action must be status, request or turn_off');
  const s = await loadSeriesFor(ws, a.series_id);
  const sn = `"${clip(s.name, 60)}"`;
  const { rows: agreements } = await sql`
    SELECT * FROM autopay_agreements
     WHERE workspace_id = ${ws} AND recurring_invoice_id = ${s.id} AND status IN ('requested', 'active')`;
  const active = agreements.find((x) => x.status === 'active' && x.client_id === s.client_id) || null;
  const requested = agreements.find((x) => x.status === 'requested' && x.client_id === s.client_id) || null;
  const c = s.client_id ? (await sql`SELECT id, name, email, payment_method_id FROM clients WHERE id = ${s.client_id} AND workspace_id = ${ws}`).rows[0] : null;
  const first = clip(firstName(c?.name || s.client_name), 40);

  if (a.action === 'turn_off') {
    if (!agreements.length) throw new Error(`Autopay is already off for ${sn}`);
    const ok = agreements.find((x) => x.status === 'active');
    return {
      summary: ok
        ? `Turn off automatic payments for ${sn}. ${first}'s approval (${cardLong(ok.card_brand, ok.card_last4)}) ends and they get an email saying it stopped. Future invoices are emailed for them to pay.`
        : `Withdraw the request asking ${first} to approve automatic payments for ${sn}. Nothing was charged; invoices keep being emailed for them to pay.`,
      done: `Turned off automatic payments for ${sn}`,
      apply: async () => {
        const n = await ownerTurnOff({ workspaceId: ws, seriesId: s.id });
        if (!n) throw new Error(`Autopay was already off for ${sn}`);
        return { ok: true, series_id: s.id, ended: n };
      },
    };
  }

  if (s.status === 'ended') throw new Error('This series has ended. Start a new series to use automatic payments.');
  if (!c) throw new Error('Pick a client for this series first.');
  const avail = await autopayAvailability(ws);
  if (!avail.ok) throw new Error(avail.message);
  if (!c.email) throw new Error('This client has no email address. Add one so they can approve automatic payments.');
  const total = seriesTotalCents(s);
  if (!(total > 0)) throw new Error('Add line items with a total above zero first.');
  if (active && !requested && total <= Number(active.max_amount_cents || 0) && c.payment_method_id === active.payment_method_id) {
    throw new Error(`Autopay is already on for ${sn} (${cardLong(active.card_brand, active.card_last4)}). Nothing to ask`);
  }
  if (requested?.request_emailed_at && Date.now() - new Date(requested.request_emailed_at).getTime() < 3600_000) {
    throw new Error(`You asked ${first} less than an hour ago. They can approve from that email or their portal; you can ask again after an hour`);
  }
  const amount = `${fmtAmount(total, s.currency)} ${CADENCE_WORDS[s.cadence] || 'each time'}`;
  const again = !!active;
  return {
    summary: `Ask ${clip(c.name, 60)} (${c.email}) to approve automatic payments${again ? ' again' : ''} for ${sn} (${amount}). They get an email and a prompt in their client portal. Nothing is charged until ${first} approves it with their own card; you cannot approve it for them.`,
    done: `Asked ${clip(c.name, 60)} to approve automatic payments for ${sn}. Nothing is charged until they approve`,
    apply: async () => {
      let out;
      try {
        out = await requestAutopay({ workspaceId: ws, seriesId: s.id, userId: ctx?.userId || null });
      } catch (e) {
        if (e instanceof AutopayError) throw new Error(e.message);
        throw e;
      }
      if (out.state === 'on' && !out.created && !out.emailed && !again) throw new Error(`Autopay is already on for ${sn}`);
      return {
        ok: true, series_id: s.id, state: out.state, emailed: !!out.emailed,
        ...(out.emailed ? {} : { warnings: [`The email to ${c.email} did not go out (they may have turned off payment emails). The request still shows in their client portal.`] }),
      };
    },
  };
}

async function readAutopay(ws, a) {
  if (a.invoice_id) {
    const id = needId(a.invoice_id, 'invoice_id', 'search_invoices');
    const inv = (await sql`SELECT * FROM invoices WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
    if (!inv) throw new Error('Invoice not found');
    const s = serializeInvoice(inv);
    return { invoice: { id, number: s.number, status: s.status }, autopay: invoiceAutopayLine(s) || 'This invoice is not paid automatically.' };
  }
  const rows = a.series_id
    ? [await loadSeriesFor(ws, a.series_id)]
    : (await sql`SELECT * FROM recurring_invoices WHERE workspace_id = ${ws} AND status <> 'ended' ORDER BY created_at DESC LIMIT 50`).rows;
  const [map, avail] = await Promise.all([autopayForSeries(ws, rows), autopayAvailability(ws)]);
  return {
    available: !!avail.ok, ...(avail.ok ? {} : { unavailable_reason: avail.message }),
    series: rows.map((s) => {
      const sum = map.get(s.id) || { state: 'off' };
      return {
        series_id: s.id, name: s.name, client: s.client_name, status: s.status,
        amount: `${fmtAmount(seriesTotalCents(s), s.currency)} ${CADENCE_WORDS[s.cadence] || ''}`.trim(),
        autopay: seriesAutopayLabel(sum),
        ...(sum.overApproved ? { note: 'The amount is now above what the client approved; ask again.' } : {}),
        ...(sum.cardChanged ? { card_note: 'The client changed their saved card; ask again.' } : {}),
      };
    }),
    manage: '[Finance](/finance), Recurring',
  };
}

// ── client invites ─────────────────────────────────────────────────────
async function inviteSetting(ws) {
  const { rows } = await sql`SELECT invite_new_clients FROM calendar_settings WHERE workspace_id = ${ws}`;
  return rows[0]?.invite_new_clients !== false;
}

async function planInviteSettings(ws, a) {
  if (a.action !== 'update') throw new Error('action must be get or update');
  if (typeof a.invite_new_clients !== 'boolean') throw new Error('invite_new_clients must be true or false');
  const now = await inviteSetting(ws);
  const on = a.invite_new_clients;
  if (now === on) throw new Error(`"Invite new clients automatically" is already ${on ? 'on' : 'off'}`);
  return {
    summary: on
      ? 'Turn on "Invite new clients automatically": each new client with an email (added by you, by me, or by a booking) gets one email inviting them to your client portal. Imports stay quiet.'
      : 'Turn off "Invite new clients automatically": new clients no longer get a client portal invite email unless you send one. Clients already invited are not affected.',
    done: `Turned ${on ? 'on' : 'off'} "Invite new clients automatically"`,
    apply: async () => ({ ok: true, invite_new_clients: await setInviteNewClients(ws, on) }),
  };
}

async function planResendInvite(ws, a) {
  const id = needId(a.client_id, 'client_id', 'search_clients');
  const c = (await sql`SELECT id, name, email, user_id, invite_sent_at FROM clients WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  const problem = resendInviteProblem(c);
  if (problem) throw new Error(problem);
  if (c.invite_sent_at && Date.now() - new Date(c.invite_sent_at).getTime() < 10 * 60_000) {
    throw new Error(`${c.name} was invited a few minutes ago. Give it a little while before sending another`);
  }
  const who = `${clip(c.name, 60)} (${c.email})`;
  return {
    summary: `Email ${who} a reminder to set up their client portal account${c.invite_sent_at ? ` (last invited ${fmtStamp(c.invite_sent_at)})` : ''}.`,
    done: `Emailed ${who} a reminder to set up their client portal account`,
    apply: async () => {
      const out = await resendClientInvite({ workspaceId: ws, clientId: id });
      if (out.error) throw new Error(out.error);
      if (!out.sent) throw new Error(`The invite email did not go out (${emailWhy(out)})`);
      return { ok: true, client_id: id, invite_sent_at: out.inviteSentAt };
    },
  };
}

// ── duplicate clients ──────────────────────────────────────────────────
// Same detection and the same one-transaction merge as Clients > Possible
// duplicates (api/_lib/clientDuplicates.js, api/_lib/clientMerge.js).
async function readDuplicates({ workspaceId, args }) {
  const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
  const { total, pairs } = await listDuplicatePairs(workspaceId, { limit });
  const side = (c) => ({
    id: c.id, name: c.name, email: c.email || null, phone: c.phone || null, stage: c.stage,
    created: c.createdAt ? fmtStamp(c.createdAt) : null, portal_account: !!c.portalClaimed,
    ...(c.counts ? { has: movesPhrase(c.counts) || 'nothing yet' } : {}),
  });
  return {
    total,
    pairs: pairs.map((p) => ({
      confidence: p.label, reasons: p.reasons,
      suggested_keep_client_id: p.keepId,
      a: side(p.a), b: side(p.b),
    })),
    review: '[Possible duplicates](/clients?duplicates=1)',
    note: total ? 'Merging needs the owner\'s approval and cannot be undone. Ask which record to keep when it is not obvious.' : 'No possible duplicates right now.',
  };
}

const FIELD_WORDS = { name: 'Name', email: 'Email', phone: 'Phone', address: 'Address', birthday: 'Birthday', stage: 'Stage' };

async function planMergeClients(ws, a, ctx) {
  const keepId = needId(a.keep_client_id, 'keep_client_id', 'find_duplicate_clients or search_clients');
  const removeId = needId(a.remove_client_id, 'remove_client_id', 'find_duplicate_clients or search_clients');
  if (keepId.toLowerCase() === removeId.toLowerCase()) throw new Error('Pick two different clients to merge');
  const refusal = await mergeRefusal(ws, keepId, removeId);
  if (refusal) throw new Error(refusal.message.replace(/\.$/, ''));
  const preview = await mergePreview(ws, keepId, removeId);
  const choices = cleanFieldChoices(a.field_choices);
  // Say which values change on the kept record (only real differences).
  const wins = [];
  const STAGE_RANK = { active: 3, paused: 2, lead: 1 };
  for (const f of preview.fields) {
    if (!f.remove) continue;
    let fromRemove = choices[f.field] === 'remove' || !f.keep;
    // Stage: the more active one wins unless the owner said otherwise.
    if (f.field === 'stage' && !choices.stage) fromRemove = (STAGE_RANK[f.remove] || 0) > (STAGE_RANK[f.keep] || 0);
    if (fromRemove && (f.keep || '').toLowerCase() !== f.remove.toLowerCase()) {
      wins.push(`${FIELD_WORDS[f.field]} becomes ${clip(f.remove, 60)}`);
    }
  }
  const { from, into } = mergeNames(preview);
  const moves = movesPhrase(preview.remove.counts);
  return {
    summary: `${mergeSentence(preview)}${wins.length ? ` ${wins.join('. ')}.` : ''}`,
    done: `Merged ${from} into ${into}${moves ? `: ${moves} moved to ${into}` : ''}. ${from} was removed`,
    apply: async () => {
      const out = await mergeClients({
        workspaceId: ws, keepId, removeId, fieldChoices: choices, actor: { id: ctx?.userId || null }, via: 'ivy',
      });
      return {
        ok: true, client_id: out.keptClientId, already_merged: out.alreadyMerged, moved: out.moved,
        ...(out.alreadyMerged ? { done: `${from} was already merged into ${into}` } : {}),
      };
    },
  };
}

async function planDismissDuplicate(ws, a, ctx) {
  const idA = needId(a.client_id_a, 'client_id_a', 'find_duplicate_clients');
  const idB = needId(a.client_id_b, 'client_id_b', 'find_duplicate_clients');
  if (idA.toLowerCase() === idB.toLowerCase()) throw new Error('Pick two different clients');
  const { rows } = await sql`SELECT id, name, email, phone FROM clients WHERE workspace_id = ${ws} AND id = ANY(${[idA, idB]}::uuid[])`;
  if (rows.length !== 2) throw new Error('Client not found');
  const sameName = String(rows[0].name || '').trim().toLowerCase() === String(rows[1].name || '').trim().toLowerCase();
  const nameOf = (id) => {
    const c = rows.find((r) => r.id === id.toLowerCase()) || {};
    const n = clip(c.name || 'the client', 60);
    return sameName && (c.email || c.phone) ? `${n} (${c.email || c.phone})` : n;
  };
  const pair = `${nameOf(idA)} and ${nameOf(idB)}`;
  return {
    summary: `Mark ${pair} as different people, so they are not suggested as duplicates again.`,
    done: `Marked ${pair} as different people`,
    apply: async () => {
      const out = await dismissDuplicatePair(ws, idA, idB, ctx?.userId || null);
      if (!out.ok) throw new Error(out.error);
      return { ok: true };
    },
  };
}

const PLANS = {
  merge_clients: planMergeClients,
  dismiss_duplicate: planDismissDuplicate,
  reminder_settings: planReminders,
  use_package_session: planUsePackage,
  review_deposit_refund: planDepositDecision,
  cancellation_policy: planPolicy,
  send_policy_for_acceptance: planPolicyRequest,
  send_document: planSendDocument,
  send_document_from_template: planSendTemplate,
  void_document: planVoidDocument,
  resend_document: planResendDocument,
  autopay: planAutopay,
  client_invite_settings: planInviteSettings,
  resend_client_invite: planResendInvite,
};

export async function planAppAction(name, args, ctx) {
  const fn = PLANS[name];
  if (!fn) return null;
  if (!ctx?.workspaceId) throw new Error('No workspace');
  return fn(ctx.workspaceId, args && typeof args === 'object' ? args : {}, ctx);
}

export async function describeAppAction(name, a, ctx) {
  if (!PLANS[name] || appCallIsRead(name, a)) return null;
  return (await planAppAction(name, a, ctx))?.summary || null;
}

export async function refuseAppAction(name, a, ctx) {
  if (!PLANS[name] || appCallIsRead(name, a)) return null;
  try {
    await planAppAction(name, a, ctx);
    return null;
  } catch (err) {
    return `${err?.message || 'That is not possible'}. Nothing was changed.`;
  }
}

// ── handlers ───────────────────────────────────────────────────────────
function writeHandler(name, read = null) {
  return async (ctx) => {
    if (read && appCallIsRead(name, ctx.args)) return read(ctx.workspaceId, ctx.args || {});
    const plan = await planAppAction(name, ctx.args, ctx);
    const result = await plan.apply();
    return { ...result, done: result.done || plan.done, summary: plan.summary };
  };
}

export const APP_HANDLERS = {
  list_deposit_reviews: readDepositReviews,
  list_policy_acceptances: readAcceptances,
  find_duplicate_clients: readDuplicates,
  reminder_settings: writeHandler('reminder_settings', readReminders),
  cancellation_policy: writeHandler('cancellation_policy', readPolicy),
  autopay: writeHandler('autopay', readAutopay),
  client_invite_settings: writeHandler('client_invite_settings', async (ws) => ({
    invite_new_clients: await inviteSetting(ws), manage: '[Clients](/clients)',
  })),
  ...Object.fromEntries(APP_SENSITIVE.map((n) => [n, writeHandler(n)])),
};

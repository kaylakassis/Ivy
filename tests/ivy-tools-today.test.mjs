// Ivy tools for the features that shipped with their own screens
// (api/_lib/ivyAppTools.js): reminders, package sessions, deposit
// refunds, the cancellation policy, documents from templates, autopay and
// client portal invites. For each write: nothing happens before the
// owner's Approve, the right thing happens after it (through the same
// server function the app's button uses), invalid input is refused before
// any card, another workspace can never reach it, and the ledger tells the
// truth. Also: cancel_booking turns a paid deposit into a review request.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-tools-today.test.mjs
process.env.STRIPE_SECRET_KEY = 'sk_test_ivytoday';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, runApprovedTool, ledgerEntry, SENSITIVE_TOOLS, IVY_TOOLS } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Outbound network mocked: Stripe + mail ─────────────────────────────
const stripe = { calls: [], n: 0 };
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripe.calls.push({ url: u, method: init.method || 'GET', body });
    const n = ++stripe.n;
    if (/\/v1\/refunds$/.test(u)) return json({ id: `re_${n}`, status: 'succeeded', amount: Number(body.amount) });
    return json({ id: `obj_${n}` });
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const refunds = () => stripe.calls.filter((c) => /\/v1\/refunds$/.test(c.url));
const mailTo = (addr) => emails.filter((e) => JSON.stringify(e.to || '').includes(addr));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const S = Date.now();
async function mkBiz(tag) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ivytoday-${tag}-${S}@example.com`}, 'x', 'Kim Owner', NOW()) RETURNING id`).rows[0].id;
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, 'Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${w}, ${`Studio ${tag}`}, ${`ivytoday-${tag}-${S}`}, 'UTC')
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = EXCLUDED.biz_name, slug = EXCLUDED.slug`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
    VALUES (${w}, ${`acct_ivytoday_${tag}_${S}`}, 'complete', 'USD')`;
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${w}, 'Haircut', 60, 60) RETURNING id`).rows[0].id;
  return { userId: u, workspaceId: w, svc, ctx: { workspaceId: w, userId: u } };
}
async function mkClient(biz, name, email, extra = {}) {
  const r = await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${biz.workspaceId}, ${name}, ${email}, 'active', ${extra.userId || null}) RETURNING id`;
  return r.rows[0].id;
}
async function mkBooking(biz, clientId, name, extra = {}) {
  const r = await sql`
    INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, source,
      deposit_required, deposit_paid, deposit_paid_at, deposit_payment_intent)
    VALUES (${biz.workspaceId}, ${biz.svc}, ${clientId}, ${name}, ${extra.email || null}, CURRENT_DATE + ${extra.days || 7}::int, 600, 660,
      ${extra.source || 'owner'}, ${extra.deposit || 0}, ${extra.deposit || 0},
      ${extra.deposit ? new Date().toISOString() : null}, ${extra.deposit ? `pi_dep_${Math.random().toString(36).slice(2)}` : null})
    RETURNING *`;
  return r.rows[0];
}
const one = async (q) => (await q).rows[0];

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('a');
  const B = await mkBiz('b');
  const ctx = A.ctx;
  const ws = A.workspaceId;
  const pending = async () => (await one(sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${ws}`)).n;

  // Held (and `unchanged` still true), then approved through the stored row.
  async function gated(name, args, unchanged, label) {
    const n0 = await pending();
    const held = await executeIvyTool(name, args, ctx);
    assert(held.needs_confirmation === true && (await pending()) === n0 + 1, `${label}: held for approval`);
    assert(await unchanged(), `${label}: nothing written before approval`);
    const w = ledgerEntry(name, args, held);
    assert(w?.status === 'waiting' && w.summary === held.summary, `${label}: ledger says waiting with the card text`);
    const row = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
    const out = await executePendingAction({ row, workspaceId: ws, userId: A.userId });
    const done = out.result;
    const l = ledgerEntry(name, args, done);
    return { held, done, ledger: l, text: out.text, actions: out.actions };
  }
  async function refused(name, args, re, label, c = ctx) {
    const n0 = await pending();
    const r = await executeIvyTool(name, args, c);
    assert(!r.needs_confirmation && re.test(r.error || '') && (await pending()) === n0, `${label} (${r.error})`);
  }

  console.log('[0] registered, gated, compact');
  {
    const writes = ['use_package_session', 'review_deposit_refund', 'send_policy_for_acceptance', 'send_document_from_template',
      'void_document', 'resend_document', 'resend_client_invite', 'send_document'];
    const mixed = ['reminder_settings', 'cancellation_policy', 'autopay', 'client_invite_settings'];
    const reads = ['list_deposit_reviews', 'list_policy_acceptances'];
    const names = IVY_TOOLS.map((t) => t.name);
    assert([...writes, ...mixed, ...reads].every((n) => names.includes(n)), 'every new tool is registered');
    assert(writes.every((n) => SENSITIVE_TOOLS.has(n)), 'every write-only tool is approval-gated by name');
    const fresh = IVY_TOOLS.filter((t) => [...writes, ...mixed, ...reads].includes(t.name) && t.name !== 'send_document');
    const size = JSON.stringify(fresh).length;
    assert(size < 6000, `new schemas stay compact (${size} chars for ${fresh.length} tools)`);
    assert(!names.some((n) => /authori[sz]e/.test(n)) && !JSON.stringify(IVY_TOOLS.find((t) => t.name === 'autopay')).includes('authorize'),
      'no tool or action can authorize autopay for a client');
  }

  console.log('[1] reminder_settings');
  {
    const n0 = await pending();
    const got = await executeIvyTool('reminder_settings', { action: 'get' }, ctx);
    assert(!got.needs_confirmation && got.clients.schedule === '1 day, 8 hours and 1 hour before' && (await pending()) === n0, 'get reads straight away (no card)');
    assert(ledgerEntry('reminder_settings', { action: 'get' }, got) === null, 'a read is not in the ledger');
    const stored = async () => (await one(sql`SELECT client_reminders FROM calendar_settings WHERE workspace_id = ${ws}`)).client_reminders;
    const r = await gated('reminder_settings', { action: 'update', audience: 'clients', minutes: [60, 1440] }, async () => (await stored()) == null, 'clients schedule');
    assert(r.held.summary === 'Change appointment reminders: Clients get reminders 1 day and 1 hour before (was 1 day, 8 hours, 1 hour).', `card: ${r.held.summary}`);
    const after = await stored();
    assert(JSON.stringify(after.minutes) === '[1440,60]' && after.enabled === true, 'saved after approval');
    assert(r.ledger.status === 'done' && /Changed appointment reminders: Clients get reminders 1 day and 1 hour before/.test(r.ledger.summary), `ledger: ${r.ledger.summary}`);
    assert(/^Done\. Changed appointment reminders/.test(r.text), `done message: ${r.text}`);
    assert((await one(sql`SELECT client_reminders FROM calendar_settings WHERE workspace_id = ${B.workspaceId}`)).client_reminders == null, "another business's reminders untouched");
    const off = await gated('reminder_settings', { action: 'update', audience: 'owner', enabled: false }, async () => true, 'owner off');
    assert(/Your own appointment reminders: off \(clients still get theirs\)/.test(off.held.summary), `card: ${off.held.summary}`);
    assert((await one(sql`SELECT owner_reminders FROM calendar_settings WHERE workspace_id = ${ws}`)).owner_reminders.enabled === false, 'owner reminders off');
    await refused('reminder_settings', { action: 'update', audience: 'clients', minutes: [17] }, /not one of the choices/, 'a time not on the list is refused before a card');
    await refused('reminder_settings', { action: 'update', audience: 'owner', channels: { sms: true } }, /not text/, 'texting the owner is refused');
    await refused('reminder_settings', { action: 'update', audience: 'clients', minutes: [1440, 60] }, /Nothing changes/, 'a no-op is refused');
    await refused('reminder_settings', { action: 'delete' }, /action must be get or update/, 'unknown action refused');

    const jordan = await mkClient(A, 'Jordan Lee', `jordan-${S}@example.com`);
    const ov = async () => (await one(sql`SELECT reminder_settings FROM clients WHERE id = ${jordan}`)).reminder_settings;
    const c = await gated('reminder_settings', { action: 'update', client_id: jordan, mode: 'custom', minutes: [120] }, async () => (await ov()) == null, 'one client');
    assert(c.held.summary === 'Jordan Lee gets reminders 2 hours before (was your business reminders (1 day and 1 hour before)).', `card: ${c.held.summary}`);
    assert(JSON.stringify(await ov()) === '{"mode":"custom","minutes":[120]}', 'client override saved');
    await refused('reminder_settings', { action: 'update', client_id: jordan, mode: 'custom', minutes: [] }, /at least one/, 'empty custom schedule refused');
    await refused('reminder_settings', { action: 'update', client_id: jordan, mode: 'off' }, /Client not found/, "another business can't touch this client", B.ctx);
    const gotC = await executeIvyTool('reminder_settings', { action: 'get', client_id: jordan }, ctx);
    assert(gotC.client?.gets === '2 hours before', 'get shows what this client gets');
    A.jordan = jordan;
  }

  console.log('[2] use_package_session + create_package');
  {
    const cp = (await one(sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining)
      VALUES (${ws}, ${A.jordan}, '10 Pack', 10, 7) RETURNING id`)).id;
    const bk = await mkBooking(A, A.jordan, 'Jordan Lee');
    const state = async () => ({
      left: (await one(sql`SELECT credits_remaining FROM client_packages WHERE id = ${cp}`)).credits_remaining,
      link: (await one(sql`SELECT client_package_id FROM bookings WHERE id = ${bk.id}`)).client_package_id,
    });
    await refused('use_package_session', { booking_id: bk.id }, /Booking not found/, 'another business cannot use it', B.ctx);
    await refused('use_package_session', { booking_id: bk.id, client_package_id: '00000000-0000-4000-8000-000000000000' }, /doesn't belong to this client/, 'a package that is not theirs is refused');
    const r = await gated('use_package_session', { booking_id: bk.id }, async () => { const s = await state(); return s.left === 7 && !s.link; }, 'use a session');
    assert(/^Use 1 session from Jordan Lee's "10 Pack" package to pay for their appointment Haircut on .* at 10:00 AM\. 7 of 10 sessions left now, 6 after\.$/.test(r.held.summary), `card: ${r.held.summary}`);
    const s = await state();
    assert(s.left === 6 && s.link === cp, 'one session spent and linked, through the Calendar path');
    assert(/Used 1 session from Jordan Lee's "10 Pack" package/.test(r.ledger.summary), `ledger: ${r.ledger.summary}`);
    await refused('use_package_session', { booking_id: bk.id }, /already uses a package session/, 'twice is refused');
    const cancelled = await mkBooking(A, A.jordan, 'Jordan Lee');
    await sql`UPDATE bookings SET cancelled_at = NOW() WHERE id = ${cancelled.id}`;
    await refused('use_package_session', { booking_id: cancelled.id }, /cancelled booking/, 'cancelled booking refused');

    const pk = await executeIvyTool('create_package', { name: `Dup ${S}`, session_count: 5, price: 200, service_ids: [A.svc, A.svc, A.svc.toUpperCase()] }, ctx);
    const row = pk.package ? await one(sql`SELECT service_ids FROM packages WHERE id = ${pk.package.id}`) : null;
    assert(row && row.service_ids.length === 1, `create_package with a repeated service id works (${pk.error || 'ok'})`);
    const pkB = await executeIvyTool('create_package', { name: 'Steal', session_count: 5, price: 1, service_ids: [A.svc] }, B.ctx);
    assert(/not in this workspace/.test(pkB.error || ''), "create_package refuses another business's service");
  }

  console.log('[3] deposits to review');
  {
    const bk = await mkBooking(A, A.jordan, 'Jordan Lee', { deposit: 20 });
    await sql`UPDATE bookings SET cancelled_at = NOW(), cancelled_by = 'client', deposit_refund_request_status = 'pending',
      deposit_refund_request_amount = 20, deposit_refund_request_reason = 'cancelled 2 days ahead, your policy refunds it',
      deposit_refund_requested_at = NOW() WHERE id = ${bk.id}`;
    const list = await executeIvyTool('list_deposit_reviews', {}, ctx);
    assert(list.deposits.some((d) => d.booking_id === bk.id && d.amount === '$20.00' && d.cancelled_by === 'the client'), 'list_deposit_reviews shows it');
    assert((await executeIvyTool('list_deposit_reviews', {}, B.ctx)).deposits.length === 0, 'another business sees none');
    await refused('review_deposit_refund', { booking_id: bk.id, decision: 'refund' }, /Booking not found/, 'another business cannot decide it', B.ctx);
    await refused('review_deposit_refund', { booking_id: bk.id, decision: 'maybe' }, /decision must be refund or keep/, 'bad decision refused');
    stripe.calls.length = 0;
    const st = async () => (await one(sql`SELECT deposit_refund_request_status AS s, deposit_refunded_amount AS amt FROM bookings WHERE id = ${bk.id}`));
    const r = await gated('review_deposit_refund', { booking_id: bk.id, decision: 'refund' }, async () => refunds().length === 0 && (await st()).s === 'pending', 'refund');
    assert(r.held.summary.startsWith("Refund Jordan's $20.00 deposit? (cancelled 2 days ahead, your policy refunds it)"), `card: ${r.held.summary}`);
    const after = await st();
    assert(refunds().length === 1 && refunds()[0].body.amount === '2000' && after.s === 'approved' && Number(after.amt) === 20, 'refunded once through decideDepositRefund');
    assert(r.ledger.summary === "Refunded Jordan's $20.00 deposit" && r.text === "Done. Refunded Jordan's $20.00 deposit", `ledger + done: ${r.text}`);
    const audit = await one(sql`SELECT meta FROM audit_events WHERE workspace_id = ${ws} AND action = 'booking.deposit_refund_approved' AND target_id = ${String(bk.id)}`);
    assert(audit?.meta?.via === 'ivy', 'audit row records it came through Ivy');
    await refused('review_deposit_refund', { booking_id: bk.id, decision: 'refund' }, /already decided/, 'deciding twice is refused');

    const k = await mkBooking(A, A.jordan, 'Jordan Lee', { deposit: 15 });
    await sql`UPDATE bookings SET cancelled_at = NOW(), deposit_refund_request_status = 'pending', deposit_refund_request_amount = 15,
      deposit_refund_request_reason = 'you cancelled the booking', deposit_refund_requested_at = NOW() WHERE id = ${k.id}`;
    stripe.calls.length = 0;
    const kept = await gated('review_deposit_refund', { booking_id: k.id, decision: 'keep' }, async () => true, 'keep');
    assert(/^Keep Jordan's \$15\.00 deposit \(you cancelled the booking\)\. Nothing is refunded/.test(kept.held.summary), `card: ${kept.held.summary}`);
    assert(refunds().length === 0 && (await one(sql`SELECT deposit_refund_request_status AS s FROM bookings WHERE id = ${k.id}`)).s === 'kept', 'kept: no money moved');
  }

  console.log('[4] cancel_booking: a paid deposit becomes a review request');
  {
    const bk = await mkBooking(A, A.jordan, 'Jordan Lee', { deposit: 25, days: 9 });
    stripe.calls.length = 0;
    const b = async () => one(sql`SELECT cancelled_at, cancelled_by, deposit_refund_request_status AS s, deposit_refund_request_reason AS reason FROM bookings WHERE id = ${bk.id}`);
    const r = await gated('cancel_booking', { booking_id: bk.id }, async () => !(await b()).cancelled_at, 'cancel');
    assert(/Their \$25\.00 deposit is not refunded yet: it goes to Deposits to review, where you tap Refund or Keep\./.test(r.held.summary), `card: ${r.held.summary}`);
    const after = await b();
    assert(after.cancelled_at && after.cancelled_by === 'owner', 'cancelled by the business');
    assert(after.s === 'pending' && after.reason === 'you cancelled the booking' && refunds().length === 0, 'deposit waits for Refund or Keep; nothing refunded, nothing forgotten');
    assert(/Their \$25\.00 deposit is waiting in Deposits to review/.test(r.ledger.summary), `ledger: ${r.ledger.summary}`);
    const listed = await executeIvyTool('list_deposit_reviews', {}, ctx);
    assert(listed.deposits.some((d) => d.booking_id === bk.id && d.cancelled_by === 'you'), 'it shows in Deposits to review');
    // A package booking gets its session back.
    const cp = (await one(sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining)
      VALUES (${ws}, ${A.jordan}, '5 Pack', 5, 4) RETURNING id`)).id;
    const pb = await mkBooking(A, A.jordan, 'Jordan Lee');
    await sql`UPDATE bookings SET client_package_id = ${cp} WHERE id = ${pb.id}`;
    const pr = await gated('cancel_booking', { booking_id: pb.id }, async () => true, 'cancel package booking');
    assert(/Their package session is given back/.test(pr.held.summary), `card: ${pr.held.summary}`);
    assert((await one(sql`SELECT credits_remaining FROM client_packages WHERE id = ${cp}`)).credits_remaining === 5, 'package session given back');
    const x = await runApprovedTool('cancel_booking', { booking_id: bk.id }, B.ctx);
    assert(/not found/.test(x.error || ''), 'another business cannot cancel it');
  }

  console.log('[5] cancellation policy');
  {
    const got = await executeIvyTool('cancellation_policy', { action: 'get' }, ctx);
    assert(got.policy === null && got.settings.requireAcceptance === false && !got.needs_confirmation, 'get reads straight away');
    await refused('cancellation_policy', { action: 'set_switches', require_acceptance: true }, /Write your cancellation policy first/, 'switch needs text first');
    await refused('cancellation_policy', { action: 'set_text', text: 'too short' }, /at least 20 characters/, 'short text refused');
    await refused('cancellation_policy', { action: 'set_switches', show_in_site_footer: 'yes' }, /show_in_site_footer must be true or false/, 'non-boolean switch refused');
    const versions = async () => (await one(sql`SELECT COUNT(*)::int AS n FROM cancellation_policy_versions WHERE workspace_id = ${ws}`)).n;
    const text = 'Please give 24 hours notice to cancel. Late cancellations pay the fee shown when you book.';
    const t = await gated('cancellation_policy', { action: 'set_text', text }, async () => (await versions()) === 0, 'set text');
    assert(t.held.summary.startsWith(`Save your cancellation policy: "${text}". Clients see the new wording on your booking page`), `card: ${t.held.summary}`);
    assert((await versions()) === 1 && t.ledger.summary === 'Saved your cancellation policy as version 1', `saved, ledger: ${t.ledger.summary}`);
    await refused('cancellation_policy', { action: 'set_text', text }, /already your policy wording/, 'same text refused');
    const req = async () => (await one(sql`SELECT require_acceptance FROM cancellation_policy_settings WHERE workspace_id = ${ws}`))?.require_acceptance;
    const sw = await gated('cancellation_policy', { action: 'set_switches', require_acceptance: true, refund_deposit_outside_window: false }, async () => !(await req()), 'switches');
    assert(sw.held.summary === 'Change your cancellation policy settings: Clients must tick a box to accept your cancellation policy when they book. Deposits are kept even when a client cancels in time (no refund requests).', `card: ${sw.held.summary}`);
    const set = await one(sql`SELECT require_acceptance, refund_deposit_outside_window FROM cancellation_policy_settings WHERE workspace_id = ${ws}`);
    assert(set.require_acceptance === true && set.refund_deposit_outside_window === false, 'switches saved through the same path as the screen');
    assert((await executeIvyTool('cancellation_policy', { action: 'get' }, B.ctx)).policy === null, 'another business still has no policy');

    // Acceptance records.
    const v = await one(sql`SELECT id, version, body_sha256 FROM cancellation_policy_versions WHERE workspace_id = ${ws}`);
    const bk = await mkBooking(A, A.jordan, 'Jordan Lee', { email: `jordan-${S}@example.com` });
    await sql`INSERT INTO cancellation_policy_acceptances (workspace_id, client_id, booking_id, policy_version_id, policy_version, policy_text, policy_sha256, status, terms, ip)
      VALUES (${ws}, ${A.jordan}, ${bk.id}, ${v.id}, ${v.version}, ${text}, ${v.body_sha256}, 'accepted', '{"lateCancelFee":20}'::jsonb, '203.0.113.9')`;
    const acc = await executeIvyTool('list_policy_acceptances', { client_id: A.jordan }, ctx);
    assert(acc.acceptances.length === 1 && acc.acceptances[0].status === 'accepted' && !JSON.stringify(acc).includes('203.0.113.9'), 'client acceptances listed (no IP address)');
    assert((await executeIvyTool('list_policy_acceptances', {}, ctx)).acceptances.some((x) => x.client === 'Jordan Lee'), 'latest across the business');
    const accB = await executeIvyTool('list_policy_acceptances', { client_id: A.jordan }, B.ctx);
    assert(/Client not found/.test(accB.error || '') && (await executeIvyTool('list_policy_acceptances', {}, B.ctx)).acceptances.length === 0, 'another business sees none');

    // Send the policy for acceptance.
    const reqs = async () => (await one(sql`SELECT COUNT(*)::int AS n FROM cancellation_policy_requests WHERE booking_id = ${bk.id}`)).n;
    await refused('send_policy_for_acceptance', { booking_id: bk.id }, /Booking not found/, 'another business cannot send it', B.ctx);
    const before = mailTo(`jordan-${S}@example.com`).length;
    const s = await gated('send_policy_for_acceptance', { booking_id: bk.id }, async () => (await reqs()) === 0 && mailTo(`jordan-${S}@example.com`).length === before, 'send policy');
    assert(new RegExp(`^Email Jordan Lee \\(jordan-${S}@example\\.com\\) a link to read and accept your cancellation policy \\(version 1\\) for their Haircut on`).test(s.held.summary), `card: ${s.held.summary}`);
    await settle();
    assert((await reqs()) === 1 && mailTo(`jordan-${S}@example.com`).some((e) => /cancellation policy/.test(e.subject || '')), 'link recorded and emailed');
    await refused('send_policy_for_acceptance', { booking_id: bk.id }, /just sent this/, 'a second send within minutes is refused');

    // Writing a policy from plain choices: the same writer as the app's
    // "Help me write it", starting from the business's real settings.
    await sql`UPDATE services SET cancellation_fee_amount = 25, cancellation_window_hours = 48 WHERE id = ${A.svc} AND workspace_id = ${ws}`;
    const choices = { tone: 'firm', notice_hours: 48, late: 'fee', late_fee: 25 };
    const n0 = await pending();
    const v0 = await versions();
    const d = await executeIvyTool('cancellation_policy', { action: 'draft', options: choices }, ctx);
    assert(!d.needs_confirmation && (await pending()) === n0 && (await versions()) === v0, 'draft reads straight away and saves nothing');
    assert(typeof d.draft === 'string' && d.draft.startsWith('Studio a: cancellation policy') && d.draft.includes("48 hours' notice")
      && d.draft.includes('For a late cancellation, I charge a fee of $25.') && d.draft.includes('By booking, you confirm you have read and agree to this policy.'),
    'draft uses the choices and the business name');
    assert(!d.check_with_owner, `matching choices raise nothing to check (${JSON.stringify(d.check_with_owner)})`);
    assert(ledgerEntry('cancellation_policy', { action: 'draft' }, d) === null, 'a draft is not in the ledger');
    const off = await executeIvyTool('cancellation_policy', { action: 'draft', options: { late_fee: 30, notice_hours: 24 } }, ctx);
    assert(off.check_with_owner?.some((c) => /charge a late cancellation fee of \$25, not \$30/.test(c))
      && off.check_with_owner.some((c) => /window of 48 hours, not 24 hours/.test(c)), `choices that differ from the services are flagged: ${JSON.stringify(off.check_with_owner)}`);
    await refused('cancellation_policy', { action: 'draft', options: { tone: 'loud' } }, /options\.tone must be gentle, standard or firm/, 'unknown tone refused');
    await refused('cancellation_policy', { action: 'draft', options: { late: 'none', late_fee: 20 } }, /late_fee must be used only with late: fee/, 'a fee with no charge refused');
    await refused('cancellation_policy', { action: 'set_text', options: { notice_hours: 1 } }, /notice_hours must be a whole number/, 'bad window refused before a card');

    const held = await executeIvyTool('cancellation_policy', { action: 'set_text', options: choices }, ctx);
    assert(held.needs_confirmation === true && (await pending()) === n0 + 1 && (await versions()) === v0, 'set_text from options is held, nothing saved');
    assert(held.summary.startsWith('Replace your cancellation policy (version 1) with version 2, written from your choices:') && held.summary.includes(d.draft),
      'the card shows every word that will be saved');
    const prow = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
    const ran = await executePendingAction({ row: prow, workspaceId: ws, userId: A.userId });
    const saved = await one(sql`SELECT version, body FROM cancellation_policy_versions WHERE workspace_id = ${ws} ORDER BY version DESC LIMIT 1`);
    assert(saved.version === 2 && saved.body === d.draft, 'approval saves exactly the drafted text as a new version');
    assert(/^Done\. Saved your cancellation policy as version 2/.test(ran.text), `done message: ${ran.text}`);
    await refused('cancellation_policy', { action: 'set_text', options: choices }, /already your policy wording/, 'same drafted text refused');
    const bd = await executeIvyTool('cancellation_policy', { action: 'draft', options: { late: 'fee' } }, B.ctx);
    assert(bd.draft.startsWith('Studio b: cancellation policy') && !bd.draft.includes('$25') && bd.draft.includes('the fee shown when you book')
      && bd.check_with_owner?.some((c) => /None of your services has a late cancellation fee/.test(c)), 'another business drafts from its own settings only');
    await sql`UPDATE services SET cancellation_fee_amount = 0, cancellation_window_hours = 24 WHERE id = ${A.svc} AND workspace_id = ${ws}`;
  }

  console.log('[6] documents');
  {
    const sam = await mkClient(A, 'Sam Park', `sam-${S}@example.com`);
    const ned = await mkClient(A, 'Ned Nomail', null);
    const fields = JSON.stringify([{ id: 'sig', type: 'signature', label: 'Signature', signerIndex: 0 }]);
    const tpl = (await one(sql`INSERT INTO documents (workspace_id, name, kind, content_html, fields, is_template)
      VALUES (${ws}, 'Consent form', 'written', '<p>I agree.</p>', ${fields}::jsonb, TRUE) RETURNING id`)).id;
    const copies = async () => (await one(sql`SELECT COUNT(*)::int AS n FROM documents WHERE template_id = ${tpl}`)).n;
    await refused('send_document_from_template', { template_id: tpl, client_ids: [A.jordan] }, /Template not found/, 'another business cannot use the template', B.ctx);
    await refused('send_document_from_template', { template_id: tpl, client_ids: Array.from({ length: 51 }, () => A.jordan) }, /Up to 50 clients/, 'more than 50 refused');
    await refused('send_document_from_template', { template_id: tpl, client_ids: [A.jordan], owner_signs: 'first' }, /Signer 2 has no fields/, 'owner signing a one-signer template refused');
    const e0 = emails.length;
    const r = await gated('send_document_from_template', { template_id: tpl, client_ids: [A.jordan, sam, ned] }, async () => (await copies()) === 0 && emails.length === e0, 'template send');
    assert(r.held.summary === 'Send "Consent form" for e-signature to 2 clients: Jordan Lee, Sam Park. Each gets their own copy by email. Skipped: Ned Nomail (no email).', `card: ${r.held.summary}`);
    await settle();
    const sent = (await sql`SELECT id, status, recipient_email FROM documents WHERE template_id = ${tpl}`).rows;
    assert(sent.length === 2 && sent.every((d) => d.status === 'sent'), 'two copies sent through sendTemplateToClients');
    assert(mailTo(`sam-${S}@example.com`).some((e) => /sign "Consent form - Sam Park"/.test(e.subject || '')), 'Sam got the signing email');
    assert(r.ledger.summary === 'Sent "Consent form" to 2 clients for e-signature', `ledger: ${r.ledger.summary}`);

    // send_document (single) through sendDocumentForSigning.
    const draft = (await one(sql`INSERT INTO documents (workspace_id, name, kind, content_html, fields, recipient_client_id)
      VALUES (${ws}, 'Waiver', 'written', '<p>Waiver</p>', ${fields}::jsonb, ${sam}) RETURNING id`)).id;
    const noFields = (await one(sql`INSERT INTO documents (workspace_id, name, kind, content_html, fields)
      VALUES (${ws}, 'Blank', 'written', '<p>x</p>', '[]'::jsonb) RETURNING id`)).id;
    await refused('send_document', { document_id: noFields, client_id: sam }, /Signer 1 has no fields/, 'send_document checks fields like the Send button');
    await refused('send_document', { document_id: tpl, client_id: sam }, /send_document_from_template/, 'a template is pointed to the template tool');
    await refused('send_document', { document_id: draft, client_id: sam }, /Document not found/, 'another business cannot send it', B.ctx);
    const status = async (id) => (await one(sql`SELECT status FROM documents WHERE id = ${id}`)).status;
    const sd = await gated('send_document', { document_id: draft, client_id: sam }, async () => (await status(draft)) === 'draft', 'send one');
    assert(sd.held.summary === `Send the document "Waiver" to Sam Park (sam-${S}@example.com) for e-signature. They get an email with a signing link.`, `card: ${sd.held.summary}`);
    const signers = (await sql`SELECT status, sign_token_hash FROM document_signers WHERE document_id = ${draft}`).rows;
    assert((await status(draft)) === 'sent' && signers.length === 1 && signers[0].status === 'awaiting', 'sent with one signer row');
    assert(sd.ledger.summary === `Sent "Waiver" to sam-${S}@example.com to sign`, `ledger: ${sd.ledger.summary}`);

    // resend
    const hash0 = signers[0].sign_token_hash;
    await refused('resend_document', { document_id: noFields }, /use Send instead/, 'a draft cannot be resent');
    const rs = await gated('resend_document', { document_id: draft }, async () => (await one(sql`SELECT sign_token_hash FROM document_signers WHERE document_id = ${draft}`)).sign_token_hash === hash0, 'resend');
    assert(rs.held.summary === `Email Sam Park (sam-${S}@example.com) a reminder to sign "Waiver". A new signing link replaces the one sent before.`, `card: ${rs.held.summary}`);
    assert((await one(sql`SELECT sign_token_hash FROM document_signers WHERE document_id = ${draft}`)).sign_token_hash !== hash0, 'fresh link after approval');
    await settle();
    assert(mailTo(`sam-${S}@example.com`).some((e) => /Reminder: please sign "Waiver"/.test(e.subject || '')), 'reminder emailed');

    // list_documents: signer status + signed PDF link
    await sql`UPDATE documents SET status = 'completed', final_pdf_url = 'https://blob.example/x.pdf', completed_at = NOW() WHERE id = ${sent[0].id}`;
    const ld = await executeIvyTool('list_documents', {}, ctx);
    const waiver = ld.documents.find((d) => d.id === draft);
    const done = ld.documents.find((d) => d.id === sent[0].id);
    assert(waiver?.signers?.[0]?.status === 'awaiting' && waiver.signers[0].name === 'Sam Park', 'list_documents shows signer status');
    assert(/\/api\/documents\/file\?t=/.test(done?.final_pdf_url || '') && !JSON.stringify(ld).includes('blob.example'), 'signed PDF as a signed link, never the storage address');
    assert((await executeIvyTool('list_documents', {}, B.ctx)).documents.length === 0, 'another business lists none');

    // void
    await refused('void_document', { document_id: sent[0].id }, /completed document/, 'a completed document cannot be voided');
    await refused('void_document', { document_id: draft }, /Document not found/, 'another business cannot void it', B.ctx);
    const v = await gated('void_document', { document_id: draft }, async () => (await status(draft)) === 'sent', 'void');
    assert(v.held.summary === 'Void the document "Waiver" (sent to Sam Park). Its signing link stops working right away. Nobody is emailed. You can edit it and send it again later.', `card: ${v.held.summary}`);
    const tok = (await sql`SELECT sign_token_hash FROM document_signers WHERE document_id = ${draft}`).rows;
    assert((await status(draft)) === 'voided' && tok.every((x) => !x.sign_token_hash), 'voided and every link dead');
    await refused('void_document', { document_id: draft }, /already void/, 'voiding twice refused');
  }

  console.log('[7] autopay');
  {
    const series = (await one(sql`INSERT INTO recurring_invoices (workspace_id, name, client_id, client_name, client_email, items, cadence, next_run_at)
      VALUES (${ws}, 'Monthly coaching', ${A.jordan}, 'Jordan Lee', ${`jordan-${S}@example.com`}, '[{"description":"Coaching","quantity":1,"rate":100}]'::jsonb, 'monthly', CURRENT_DATE + 10)
      RETURNING id`)).id;
    const st = await executeIvyTool('autopay', { action: 'status' }, ctx);
    assert(st.available === true && st.series.some((x) => x.series_id === series && x.autopay === 'Autopay off' && x.amount === '$100.00 every month'), 'status lists the series (read, no card)');
    assert((await executeIvyTool('autopay', { action: 'status' }, B.ctx)).series.length === 0, 'another business sees none');
    await refused('autopay', { action: 'authorize', series_id: series }, /action must be status, request or turn_off/, 'authorize is not an action');
    await refused('autopay', { action: 'request', series_id: series }, /Recurring invoice not found/, 'another business cannot ask', B.ctx);
    const agreements = async () => (await sql`SELECT status FROM autopay_agreements WHERE recurring_invoice_id = ${series}`).rows.map((x) => x.status);
    const e0 = mailTo(`jordan-${S}@example.com`).length;
    const r = await gated('autopay', { action: 'request', series_id: series }, async () => (await agreements()).length === 0 && mailTo(`jordan-${S}@example.com`).length === e0, 'request');
    assert(r.held.summary === `Ask Jordan Lee (jordan-${S}@example.com) to approve automatic payments for "Monthly coaching" ($100.00 every month). They get an email and a prompt in their client portal. Nothing is charged until Jordan approves it with their own card; you cannot approve it for them.`, `card: ${r.held.summary}`);
    assert(JSON.stringify(await agreements()) === '["requested"]', 'only a request exists: nothing is approved on the client\'s behalf');
    await settle();
    assert(mailTo(`jordan-${S}@example.com`).some((e) => /asked about automatic payments/.test(e.subject || '')), 'client emailed the request');
    assert(/Asked Jordan Lee to approve automatic payments for "Monthly coaching"/.test(r.ledger.summary), `ledger: ${r.ledger.summary}`);
    await refused('autopay', { action: 'request', series_id: series }, /less than an hour ago/, 'asking again within the hour refused');
    const st2 = await executeIvyTool('autopay', { action: 'status', series_id: series }, ctx);
    assert(st2.series[0].autopay === 'Waiting for client to authorize', 'status shows waiting');
    const off = await gated('autopay', { action: 'turn_off', series_id: series }, async () => JSON.stringify(await agreements()) === '["requested"]', 'turn off');
    assert(/^Withdraw the request asking Jordan to approve automatic payments for "Monthly coaching"/.test(off.held.summary), `card: ${off.held.summary}`);
    assert(JSON.stringify(await agreements()) === '["ended"]', 'ended after approval');
    await refused('autopay', { action: 'turn_off', series_id: series }, /already off/, 'turning off twice refused');
    const inv = (await one(sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, autopay_status, autopay_card_last4, autopay_card_brand)
      VALUES (${ws}, ${`AP-${S}`}, ${A.jordan}, 'Jordan Lee', '[{"description":"Coaching","quantity":1,"rate":100}]'::jsonb, 'paid', 'succeeded', '4242', 'visa') RETURNING id`)).id;
    const il = await executeIvyTool('autopay', { action: 'status', invoice_id: inv }, ctx);
    assert(il.autopay === 'Paid automatically with Visa ending in 4242.', `invoice line: ${il.autopay}`);
    assert(/Invoice not found/.test((await executeIvyTool('autopay', { action: 'status', invoice_id: inv }, B.ctx)).error || ''), "another business can't read it");
  }

  console.log('[8] client portal invites');
  {
    const setting = async () => (await one(sql`SELECT invite_new_clients FROM calendar_settings WHERE workspace_id = ${ws}`)).invite_new_clients;
    const got = await executeIvyTool('client_invite_settings', { action: 'get' }, ctx);
    assert(got.invite_new_clients === true && !got.needs_confirmation, 'get reads (on by default)');
    await refused('client_invite_settings', { action: 'update' }, /must be true or false/, 'missing value refused');
    const r = await gated('client_invite_settings', { action: 'update', invite_new_clients: false }, async () => (await setting()) !== false, 'turn off');
    assert(/^Turn off "Invite new clients automatically"/.test(r.held.summary) && (await setting()) === false, `turned off (card: ${r.held.summary})`);
    assert(r.ledger.summary === 'Turned off "Invite new clients automatically"', `ledger: ${r.ledger.summary}`);
    assert((await one(sql`SELECT invite_new_clients FROM calendar_settings WHERE workspace_id = ${B.workspaceId}`)).invite_new_clients !== false, 'another business keeps its setting');
    await refused('client_invite_settings', { action: 'update', invite_new_clients: false }, /already off/, 'no-op refused');

    const pat = await mkClient(A, 'Pat Rivera', `pat-${S}@example.com`);
    const claimedUser = (await one(sql`INSERT INTO users (email, password_hash, name) VALUES (${`claimed-${S}@example.com`}, 'x', 'C') RETURNING id`)).id;
    const claimed = await mkClient(A, 'Cara Claimed', `claimed-${S}@example.com`, { userId: claimedUser });
    await refused('resend_client_invite', { client_id: claimed }, /already claimed/, 'a client who already joined is refused');
    await refused('resend_client_invite', { client_id: pat }, /Client not found/, 'another business cannot invite', B.ctx);
    const e0 = mailTo(`pat-${S}@example.com`).length;
    const inv = await gated('resend_client_invite', { client_id: pat }, async () => mailTo(`pat-${S}@example.com`).length === e0, 'resend invite');
    assert(inv.held.summary === `Email Pat Rivera (pat-${S}@example.com) a reminder to set up their client portal account.`, `card: ${inv.held.summary}`);
    await settle();
    assert(mailTo(`pat-${S}@example.com`).some((e) => /Reminder: claim your account/.test(e.subject || '')), 'invite emailed');
    assert((await one(sql`SELECT invite_sent_at FROM clients WHERE id = ${pat}`)).invite_sent_at, 'invite stamped only after it went out');
    await refused('resend_client_invite', { client_id: pat }, /a few minutes ago/, 'a second nudge right away is refused');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

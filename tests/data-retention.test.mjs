// 7-day data retention after a paid subscription ends.
// Run: node --import ./tests/bootstrap.mjs ./tests/data-retention.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { runDataRetention, scheduleDeletions, sendReminders, clearRescued, purgeDue, RETAINED_TABLES, TRIAL_RETENTION_DAYS } from '../api/_lib/dataRetention.js';
import { userContext } from '../api/_lib/clientPortal.js';
import { renderDataDeletionScheduled, renderDataDeletionReminder, renderDataDeleted, renderPlanEnding, renderSubscriptionCancelled } from '../api/_lib/subscriptionNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function ws(tag, cols) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`dr-${tag}-${S}@example.com`}, 'x', 'Owner Person', NOW()) RETURNING id, email`;
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 2}`);
  const w = await sql.query(
    `INSERT INTO workspaces (owner_id, name, ${keys.join(', ')}) VALUES ($1, 'Glow Studio', ${vals.join(', ')}) RETURNING id`,
    [u.rows[0].id, ...keys.map((k) => cols[k])],
  );
  return { id: w.rows[0].id, ownerId: u.rows[0].id, email: u.rows[0].email };
}
const row = async (id) => (await sql`SELECT * FROM workspaces WHERE id = ${id}`).rows[0];
const d = (days) => new Date(Date.now() + days * 864e5);

async function main() {
  await ensureSchemaApplied();
  const lapsed    = await ws('lapsed',   { subscription_status: 'cancelled', subscription_period_end: d(-1), converted_at: d(-60), subscription_source: 'stripe' });
  const suspended = await ws('susp',     { subscription_status: 'suspended', subscription_period_end: d(-20), converted_at: d(-90) });
  const trialOnly = await ws('trial',    { subscription_status: 'trialing', trial_ends_at: d(-3), trial_started_at: d(-17) });
  const activePaid= await ws('active',   { subscription_status: 'active', subscription_period_end: d(5), converted_at: d(-30) });
  const comped    = await ws('comped',   { subscription_status: 'cancelled', subscription_period_end: d(-5), converted_at: d(-30), comp_until: d(30) });
  const pastDue   = await ws('pastdue',  { subscription_status: 'past_due', subscription_period_end: d(-2), converted_at: d(-30) });
  const cancelling= await ws('cancelling',{ subscription_status: 'active', subscription_period_end: d(2), converted_at: d(-30), cancel_at_period_end: true });

  console.log('\n[1] scheduling: only paid-and-lapsed workspaces get a deletion date');
  const n = await scheduleDeletions();
  assert(n >= 2, `scheduled ${n}`);
  const L = await row(lapsed.id);
  assert(!!L.data_deletion_at && Math.abs(new Date(L.data_deletion_at) - d(7)) < 60_000, '7 days from now for the cancelled workspace');
  assert(!!L.data_deletion_notice_sent_at, 'notice stamped');
  assert(!!(await row(suspended.id)).data_deletion_at, 'suspended (dunning exhausted) workspace scheduled too');
  const T = await row(trialOnly.id);
  assert(!!T.data_deletion_at && Math.abs(new Date(T.data_deletion_at) - d(TRIAL_RETENTION_DAYS - 3)) < 60_000, `expired unpaid trial: deletion 4 weeks after trial end (${T.data_deletion_at})`);
  const tnotif = (await sql`SELECT title, body FROM notifications WHERE workspace_id = ${trialOnly.id} ORDER BY created_at DESC LIMIT 1`).rows[0];
  assert(!!tnotif && /trial has ended/i.test(tnotif.title) && /pick a plan/.test(tnotif.body), `trial notice: ${tnotif?.title}`);
  const oldTrial = await ws('oldtrial', { subscription_status: 'trialing', trial_ends_at: d(-60), trial_started_at: d(-74) });
  const liveTrial = await ws('livetrial', { subscription_status: 'trialing', trial_ends_at: d(5), trial_started_at: d(-9) });
  await scheduleDeletions();
  const OT = await row(oldTrial.id);
  assert(!!OT.data_deletion_at && Math.abs(new Date(OT.data_deletion_at) - d(7)) < 60_000, 'trial that ended long ago still gets a 7-day notice window');
  assert(!(await row(liveTrial.id)).data_deletion_at, 'live trial: not scheduled');
  assert(!(await row(activePaid.id)).data_deletion_at, 'active paid: not scheduled');
  assert(!(await row(comped.id)).data_deletion_at, 'comped: not scheduled');
  assert(!(await row(pastDue.id)).data_deletion_at, 'past_due (in grace): not scheduled');
  assert(!(await row(cancelling.id)).data_deletion_at, 'cancelling with time left: not scheduled yet');
  const notif = (await sql`SELECT title, body FROM notifications WHERE workspace_id = ${lapsed.id} ORDER BY created_at DESC LIMIT 1`).rows[0];
  assert(!!notif && /access has ended/i.test(notif.title) && /permanently deleted/.test(notif.body), `in-app notice: ${notif?.title}`);
  const again = await scheduleDeletions();
  assert(again === 0, 'second run schedules nothing new');

  console.log('\n[2] the paywall payload carries the date');
  const ctx = await userContext({ id: lapsed.ownerId, email: lapsed.email });
  assert(ctx.subscription?.isActive === false && !!ctx.subscription?.dataDeletionAt, `subscription.dataDeletionAt = ${ctx.subscription?.dataDeletionAt}`);
  const ctxA = await userContext({ id: activePaid.ownerId, email: activePaid.email });
  assert(ctxA.subscription?.dataDeletionAt == null, 'active workspace has no deletion date');

  console.log('\n[3] reminder 2 days out, once');
  await sql`UPDATE workspaces SET data_deletion_at = NOW() + INTERVAL '36 hours' WHERE id = ${lapsed.id}`;
  assert((await sendReminders()) >= 1, 'reminder sent');
  assert(!!(await row(lapsed.id)).data_deletion_reminder_sent_at, 'reminder stamped');
  assert((await sendReminders()) === 0, 'not sent twice');
  assert(!(await row(suspended.id)).data_deletion_reminder_sent_at, 'suspended one (6+ days out) not reminded yet');

  console.log('\n[4] resubscribing before the date calls it off');
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '7 days' WHERE id = ${lapsed.id}`;
  assert((await clearRescued()) >= 1, 'rescued');
  const R = await row(lapsed.id);
  assert(!R.data_deletion_at && !R.data_deletion_notice_sent_at && !R.data_deletion_reminder_sent_at, 'all stamps cleared');

  console.log('\n[5] purge on the date: business data gone, login + billing history kept');
  const P = suspended;
  const c = await sql`INSERT INTO clients (workspace_id, name) VALUES (${P.id}, 'A Client') RETURNING id`;
  await sql`INSERT INTO tasks (workspace_id, title) VALUES (${P.id}, 'Follow up')`;
  await sql`INSERT INTO services (workspace_id, name, duration_minutes) VALUES (${P.id}, 'Session', 60)`;
  const t = await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${P.id}, ${c.rows[0].id}) RETURNING id`;
  await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${t.rows[0].id}, 'biz', 'hello')`;
  const sess = await sql`INSERT INTO ivy_sessions (workspace_id) VALUES (${P.id}) RETURNING id`;
  await sql`INSERT INTO ivy_messages (session_id, role, text) VALUES (${sess.rows[0].id}, 'me', 'private question')`;
  await sql`INSERT INTO documents (workspace_id, name) VALUES (${P.id}, 'Contract')`;
  await sql`INSERT INTO websites (workspace_id) VALUES (${P.id})`;
  await sql`INSERT INTO ivy_usage (workspace_id, day, model, request_count, output_tokens) VALUES (${P.id}, CURRENT_DATE, 'm', 3, 10)`;
  await sql`UPDATE workspaces SET data_deletion_at = NOW() - INTERVAL '1 hour', business_type = 'service', onboarded_at = NOW() WHERE id = ${P.id}`;
  // Not-yet-due neighbour must be untouched.
  const neighbour = await ws('neighbour', { subscription_status: 'cancelled', subscription_period_end: d(-1), converted_at: d(-60), data_deletion_at: d(3) });
  await sql`INSERT INTO clients (workspace_id, name) VALUES (${neighbour.id}, 'Keep Me')`;

  const purged = await purgeDue();
  assert(purged === 1, `purged exactly one (${purged})`);
  const count = async (q) => Number((await q).rows[0].n);
  assert(await count(sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${P.id}`) === 0, 'clients deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM tasks WHERE workspace_id = ${P.id}`) === 0, 'tasks deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM services WHERE workspace_id = ${P.id}`) === 0, 'services deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM messages WHERE thread_id = ${t.rows[0].id}`) === 0, 'messages deleted through their thread');
  assert(await count(sql`SELECT COUNT(*)::int n FROM ivy_messages WHERE session_id = ${sess.rows[0].id}`) === 0, 'Ivy chat history deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM documents WHERE workspace_id = ${P.id}`) === 0, 'documents deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM websites WHERE workspace_id = ${P.id}`) === 0, 'website deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM notifications WHERE workspace_id = ${P.id}`) === 0, 'notifications deleted');
  assert(await count(sql`SELECT COUNT(*)::int n FROM ivy_usage WHERE workspace_id = ${P.id}`) === 1, 'usage counters (no personal data) retained for cost reporting');
  const W = await row(P.id);
  assert(!!W, 'workspace row still exists');
  assert(W.name == null && W.business_type === 'both' && W.onboarded_at == null && W.streak_days === 0, 'business fields reset to defaults');
  assert(!!W.converted_at && W.subscription_status === 'suspended' && !!W.data_purged_at && !W.data_deletion_at, 'billing history kept, purge stamped, deletion date cleared');
  const owner = (await sql`SELECT email, deleted_at FROM users WHERE id = ${P.ownerId}`).rows[0];
  assert(owner && owner.email === P.email && !owner.deleted_at, 'owner login kept');
  assert(await count(sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${neighbour.id}`) === 1, 'not-yet-due workspace untouched');
  const audit = (await sql`SELECT action, meta FROM audit_events WHERE target_user_id = ${P.ownerId} AND action = 'workspace.retention_purge'`).rows;
  assert(audit.length === 1 && audit[0].meta.tables.clients === 1, 'audit event recorded with per-table counts');
  assert((await purgeDue()) === 0, 'second run purges nothing');
  assert(RETAINED_TABLES.has('abuse_reports') && RETAINED_TABLES.has('audit_events'), 'moderation + audit records are on the retain list');

  console.log('\n[6] a purged workspace cannot claim a second free trial (checkout eligibility rule)');
  assert(!!W.trial_started_at || !!W.converted_at, 'trial_started_at/converted_at survive the reset');

  console.log('\n[7] the whole runner');
  const r = await runDataRetention();
  assert(typeof r.scheduled === 'number' && typeof r.purged === 'number', `runner returns counts ${JSON.stringify(r)}`);

  console.log('\n[8] copy');
  const e1 = renderDataDeletionScheduled({ deleteAt: d(7), endedAt: d(0), firstName: 'Kay', businessName: 'Glow', source: 'stripe' });
  assert(/7 days to download/.test(e1.html) && /permanently deleted/.test(e1.html) && /cannot be undone/.test(e1.html), 'scheduled email: 7 days, permanent, irreversible');
  assert(/Download my data/.test(e1.html) && /Email me a copy/.test(e1.html), 'scheduled email names both export paths');
  const e2 = renderDataDeletionReminder({ deleteAt: d(2), firstName: 'Kay', businessName: 'Glow' });
  assert(/2 days left/.test(e2.subject), 'reminder subject');
  const t1 = renderDataDeletionScheduled({ deleteAt: d(28), endedAt: d(0), firstName: 'Kay', businessName: 'Glow', trial: true });
  assert(/4 weeks/.test(t1.html) && /Pick a plan/.test(t1.html) && /permanently deleted/.test(t1.html) && !/resubscribe/i.test(t1.html), 'trial notice: 4 weeks, pick a plan, permanent');
  const t2 = renderDataDeletionReminder({ deleteAt: d(2), firstName: 'Kay', businessName: 'Glow', trial: true });
  assert(/pick a plan/.test(t2.html) && /Pick a plan/.test(t2.html), 'trial reminder points at picking a plan');
  const e3 = renderDataDeleted({ firstName: 'Kay' });
  assert(/permanently deleted/.test(e3.html) && /login still works/.test(e3.html), 'deleted email');
  const pe = renderPlanEnding({ endsAt: d(2), firstName: 'Kay', businessName: 'Glow', source: 'stripe' });
  const sc = renderSubscriptionCancelled({ endsAt: d(2), firstName: 'Kay', businessName: 'Glow' });
  assert(/7 days/.test(pe.html) && /permanently deleted/.test(pe.html) && !/Nothing is deleted/.test(pe.html), 'plan-ending email states the 7-day deletion');
  assert(/7 days/.test(sc.html) && /permanently deleted/.test(sc.html) && !/Nothing is deleted|free account/.test(sc.html), 'cancellation email states the 7-day deletion');
  assert(!/<script|claude|anthropic/i.test(e1.html + e2.html + e3.html), 'no scripts, no vendor names');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });

// Ivy's owner-parity tools (api/_lib/ivyOwnerTools.js): every write is
// held for approval with a card that says exactly what changes, runs only
// after approval, is refused for invalid input, never reaches another
// workspace, and is recorded truthfully in the action ledger.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-owner-tools.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, runApprovedTool, ledgerEntry, SENSITIVE_TOOLS, IVY_TOOLS, isReadOnlyIvyTool } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivyown-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

async function run() {
  await ensureSchemaApplied();
  const A = await owner('a');
  const B = await owner('b');
  const ctx = { workspaceId: A.workspaceId, userId: A.userId };
  const ctxB = { workspaceId: B.workspaceId, userId: B.userId };
  const ws = A.workspaceId;

  const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${ws}, 'Haircut', 45, 40) RETURNING id`).rows[0].id;
  const rev = (await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text) VALUES (${ws}, 'Dana', 5, 'Loved it') RETURNING id`).rows[0].id;
  const blk = (await sql`INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label, all_day) VALUES (${ws}, CURRENT_DATE + 5, 780, 840, 'Lunch', FALSE) RETURNING id`).rows[0].id;
  const bk = (await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min) VALUES (${ws}, 'Jamie Lee', 'jamie@example.com', CURRENT_DATE - 1, 600, 660) RETURNING id`).rows[0].id;
  const task = (await sql`INSERT INTO tasks (workspace_id, title) VALUES (${ws}, 'Order supplies') RETURNING id`).rows[0].id;
  const wf = (await sql`INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled) VALUES (${ws}, 'Old welcome', 'client_created', '[]'::jsonb, TRUE) RETURNING id`).rows[0].id;
  const prog = (await sql`INSERT INTO programs (workspace_id, title, price_cents) VALUES (${ws}, 'Glow Course', 9900) RETURNING id`).rows[0].id;

  const pendingCount = async () => (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${ws}`).rows[0].n;

  // Hold (asserting `unchanged()` still holds), then approve.
  async function gated(name, args, unchanged, label) {
    const n0 = await pendingCount();
    const held = await executeIvyTool(name, args, ctx);
    assert(held.needs_confirmation === true && (await pendingCount()) === n0 + 1, `${label}: held for approval`);
    assert(await unchanged(), `${label}: nothing written before approval`);
    const w = ledgerEntry(name, args, held);
    assert(w.status === 'waiting' && w.summary === held.summary, `${label}: ledger says waiting`);
    const done = await runApprovedTool(name, args, ctx);
    const l = ledgerEntry(name, args, done);
    return { held, done, ledger: l };
  }

  console.log('[0] registered, gated, compact');
  {
    const names = ['manage_service', 'reply_to_review', 'unblock_calendar_time', 'update_booking_status', 'manage_task', 'delete_workflow', 'create_coupon'];
    assert(names.every((n) => SENSITIVE_TOOLS.has(n) && IVY_TOOLS.some((t) => t.name === n)), 'every write tool is registered and approval-gated');
    assert(IVY_TOOLS.some((t) => t.name === 'list_programs') && !SENSITIVE_TOOLS.has('list_programs') && isReadOnlyIvyTool('list_programs'), 'list_programs is a plain read');
    const size = JSON.stringify(IVY_TOOLS.filter((t) => [...names, 'list_programs'].includes(t.name))).length;
    assert(size < 4000, `new tool schemas stay compact (${size} chars)`);
  }

  console.log('[1] manage_service');
  {
    const price = async () => Number((await sql`SELECT price FROM services WHERE id = ${svc}`).rows[0].price);
    const r = await gated('manage_service', { service_id: svc, action: 'update', price: 55, visibility: 'private' }, async () => (await price()) === 40, 'update');
    assert(/Change the service "Haircut": price from \$40\.00 to \$55\.00; make it bookable by link only/.test(r.held.summary), `card: ${r.held.summary}`);
    const row = (await sql`SELECT price, visibility FROM services WHERE id = ${svc}`).rows[0];
    assert(Number(row.price) === 55 && row.visibility === 'private', 'price and visibility changed after approval');
    assert(r.ledger.status === 'done' && /Updated the service "Haircut"/.test(r.ledger.summary), `ledger: ${r.ledger.summary}`);
    const bad = await executeIvyTool('manage_service', { service_id: svc, action: 'update', price: -5 }, ctx);
    assert(/price must be/.test(bad.error || ''), 'negative price refused');
    const none = await executeIvyTool('manage_service', { service_id: svc, action: 'update' }, ctx);
    assert(/Nothing to change/.test(none.error || ''), 'empty update refused');
    const other = await executeIvyTool('manage_service', { service_id: svc, action: 'delete' }, ctxB);
    assert(/Service not found/.test(other.error || ''), 'another workspace cannot touch it');
    const del = await gated('manage_service', { service_id: svc, action: 'delete' }, async () => (await sql`SELECT 1 FROM services WHERE id = ${svc}`).rows.length === 1, 'delete');
    assert(/Delete the service "Haircut"/.test(del.held.summary), `card: ${del.held.summary}`);
    assert((await sql`SELECT 1 FROM services WHERE id = ${svc}`).rows.length === 0, 'deleted after approval');
  }

  console.log('[2] reply_to_review');
  {
    const resp = async () => (await sql`SELECT owner_response FROM reviews WHERE id = ${rev}`).rows[0].owner_response;
    const r = await gated('reply_to_review', { review_id: rev, response: 'Thank you, Dana!' }, async () => (await resp()) == null, 'reply');
    assert(/Reply publicly to Dana's 5-star review \("Loved it"\) with: "Thank you, Dana!"/.test(r.held.summary), `card: ${r.held.summary}`);
    assert((await resp()) === 'Thank you, Dana!', 'reply saved');
    assert(/Replied publicly to Dana's 5-star review/.test(r.ledger.summary), `ledger: ${r.ledger.summary}`);
    const x = await executeIvyTool('reply_to_review', { review_id: rev, response: 'hacked' }, ctxB);
    assert(/Review not found/.test(x.error || ''), 'another workspace cannot reply');
    const bad = await executeIvyTool('reply_to_review', { review_id: 'not-a-uuid', response: 'x' }, ctx);
    assert(/review_id is required/.test(bad.error || ''), 'malformed id refused');
  }

  console.log('[3] unblock_calendar_time');
  {
    const av = await executeIvyTool('get_availability', {}, ctx);
    assert(av.blocked_dates.some((b) => b.id === blk), 'get_availability returns block ids');
    const exists = async () => (await sql`SELECT 1 FROM calendar_blocks WHERE id = ${blk}`).rows.length === 1;
    const x = await executeIvyTool('unblock_calendar_time', { block_id: blk }, ctxB);
    assert(/not found/.test(x.error || ''), 'another workspace cannot unblock it');
    const r = await gated('unblock_calendar_time', { block_id: blk }, exists, 'unblock');
    assert(/Remove the blocked time on .* 1:00 PM to 2:00 PM, "Lunch"/.test(r.held.summary), `card: ${r.held.summary}`);
    assert(!(await exists()), 'block removed after approval');
  }

  console.log('[4] update_booking_status');
  {
    const b = async () => (await sql`SELECT no_show_at, completion_log, fee_charged_at FROM bookings WHERE id = ${bk}`).rows[0];
    const r = await gated('update_booking_status', { booking_id: bk, status: 'completed', notes: 'Trim and style' }, async () => !Object.keys((await b()).completion_log || {}).length, 'completed');
    assert(/Mark Jamie Lee's appointment on .* at 10:00 AM as completed with the note "Trim and style"/.test(r.held.summary), `card: ${r.held.summary}`);
    assert(Object.keys((await b()).completion_log || {}).length === 1, 'completion recorded');
    const again = await executeIvyTool('update_booking_status', { booking_id: bk, status: 'completed' }, ctx);
    assert(/already marked complete/.test(again.error || ''), 'completing twice is refused');
    await gated('update_booking_status', { booking_id: bk, status: 'undo_completed' }, async () => Object.keys((await b()).completion_log || {}).length === 1, 'undo completed');
    const ns = await gated('update_booking_status', { booking_id: bk, status: 'no_show' }, async () => !(await b()).no_show_at, 'no-show');
    assert(/No fee is charged/.test(ns.held.summary), `card: ${ns.held.summary}`);
    const after = await b();
    assert(after.no_show_at && !after.fee_charged_at, 'marked a no-show, no fee charged');
    const x = await executeIvyTool('update_booking_status', { booking_id: bk, status: 'undo_no_show' }, ctxB);
    assert(/Booking not found/.test(x.error || ''), 'another workspace cannot change it');
    const bad = await executeIvyTool('update_booking_status', { booking_id: bk, status: 'paid' }, ctx);
    assert(/status must be/.test(bad.error || ''), 'unknown status refused');
  }

  console.log('[5] manage_task');
  {
    const t = async () => (await sql`SELECT title, due_date FROM tasks WHERE id = ${task}`).rows[0];
    const r = await gated('manage_task', { task_id: task, action: 'update', title: 'Order shampoo', due_date: '2026-12-01' }, async () => (await t()).title === 'Order supplies', 'update');
    assert(/Change the task "Order supplies": rename it to "Order shampoo"; due /.test(r.held.summary), `card: ${r.held.summary}`);
    assert((await t()).title === 'Order shampoo', 'task updated');
    const bad = await executeIvyTool('manage_task', { task_id: task, action: 'update', due_date: 'tomorrow' }, ctx);
    assert(/due_date must be/.test(bad.error || ''), 'bad date refused');
    await gated('manage_task', { task_id: task, action: 'delete' }, async () => !!(await t()), 'delete');
    assert(!(await t()), 'task deleted');
  }

  console.log('[6] delete_workflow');
  {
    const exists = async () => (await sql`SELECT 1 FROM workflows WHERE id = ${wf}`).rows.length === 1;
    const x = await executeIvyTool('delete_workflow', { workflow_id: wf }, ctxB);
    assert(/Workflow not found/.test(x.error || ''), 'another workspace cannot delete it');
    const r = await gated('delete_workflow', { workflow_id: wf }, exists, 'delete');
    assert(/Delete the automation "Old welcome" \(it is on now; it stops for good\)/.test(r.held.summary), `card: ${r.held.summary}`);
    assert(!(await exists()) && /Deleted the automation "Old welcome"/.test(r.ledger.summary), 'deleted, ledger truthful');
  }

  console.log('[7] create_coupon + list_programs');
  {
    const code = `GLOW${String(S).slice(-5)}`;
    const count = async () => (await sql`SELECT COUNT(*)::int AS n FROM program_coupons WHERE workspace_id = ${ws}`).rows[0].n;
    const r = await gated('create_coupon', { code, percent_off: 20, program_id: prog, max_uses: 10 }, async () => (await count()) === 0, 'create');
    assert(new RegExp(`Create the coupon code ${code}: 20% off "Glow Course" \\(the first payment, up to 10 uses\\)`).test(r.held.summary), `card: ${r.held.summary}`);
    assert((await count()) === 1, 'coupon created');
    const dup = await executeIvyTool('create_coupon', { code, percent_off: 10 }, ctx);
    assert(/already an active code/.test(dup.error || ''), 'duplicate code refused');
    const badPct = await executeIvyTool('create_coupon', { code: 'BIGDEAL', percent_off: 150 }, ctx);
    assert(/between 1 and 100/.test(badPct.error || ''), 'percent over 100 refused');
    const foreign = await executeIvyTool('create_coupon', { code: 'STEAL', percent_off: 10, program_id: prog }, ctxB);
    assert(/Program not found/.test(foreign.error || ''), "another workspace cannot attach a code to this program");
    const lp = await executeIvyTool('list_programs', {}, ctx);
    assert(lp.programs.some((p) => p.title === 'Glow Course' && p.price === 99) && lp.coupons.some((c) => c.code === code), 'list_programs shows programs and codes');
    const lpB = await executeIvyTool('list_programs', {}, ctxB);
    assert(lpB.programs.length === 0 && lpB.coupons.length === 0, 'another workspace sees none of them');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });

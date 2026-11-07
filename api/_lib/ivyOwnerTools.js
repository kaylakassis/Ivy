// More of what the owner can do in the app, as Ivy tools (see
// docs/ivy-capabilities.md for the full parity list).
//
// Same shape as the website tools: each write is planned in one place. The
// plan validates the call against the owner's own data (every lookup scoped
// to ctx.workspaceId), words the approval card, and is rebuilt and run only
// when the owner taps Approve. Every write here is approval-gated.
//
// Deliberately NOT here (owner-only in the app): money movement (fees,
// refunds, payouts), payment-provider connections, billing, auth, staff
// access invites, deleting clients or the account.
import { sql } from './db.js';
import { markComplete, undoComplete, completionLogOf, CompletionError } from './completion.js';
import { cleanCouponInput, ensureStripeCoupon } from './programCommerce.js';
import { fetchFinanceSettings } from './finance.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITY_WORDS = { public: 'listed on your booking page', private: 'bookable by link only', only_me: 'hidden from clients' };

// ── tool definitions (compact: sent with every request) ───────────────
export const OWNER_TOOLS = [
  {
    name: 'list_programs',
    description: 'Programs/courses (id, title, status, price, members) and active coupon codes with how often each was used.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'manage_service',
    description: 'Edit a service (name, price, duration_minutes, description, capacity, visibility) or delete it. service_id from list_services.',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        action: { type: 'string', enum: ['update', 'delete'] },
        name: { type: 'string' }, price: { type: 'number' }, duration_minutes: { type: 'integer' },
        description: { type: 'string' }, capacity: { type: 'integer', description: '1 = one-on-one; more = group/class.' },
        visibility: { type: 'string', enum: ['public', 'private', 'only_me'], description: 'public = listed, private = link only, only_me = hidden.' },
      },
      required: ['service_id', 'action'],
    },
  },
  {
    name: 'reply_to_review',
    description: "Post (or replace) the owner's public reply under a review; an empty response removes the reply. review_id from list_reviews.",
    input_schema: {
      type: 'object',
      properties: { review_id: { type: 'string' }, response: { type: 'string' } },
      required: ['review_id', 'response'],
    },
  },
  {
    name: 'unblock_calendar_time',
    description: 'Remove blocked-off time (block_id from get_availability blocked_dates) so clients can book it again.',
    input_schema: { type: 'object', properties: { block_id: { type: 'string' } }, required: ['block_id'] },
  },
  {
    name: 'update_booking_status',
    description: 'Mark an appointment completed (optional notes) or a no-show, or undo either. Never charges a fee. date = the occurrence (defaults to the booking date).',
    input_schema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'undo_completed', 'no_show', 'undo_no_show'] },
        date: { type: 'string' }, notes: { type: 'string' },
      },
      required: ['booking_id', 'status'],
    },
  },
  {
    name: 'manage_task',
    description: 'Edit a task (title, due_date YYYY-MM-DD or empty to clear, notes), reopen a done one, or delete it. task_id from list_tasks.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' }, action: { type: 'string', enum: ['update', 'reopen', 'delete'] },
        title: { type: 'string' }, due_date: { type: 'string' }, notes: { type: 'string' },
      },
      required: ['task_id', 'action'],
    },
  },
  {
    name: 'delete_workflow',
    description: 'Delete an automation and its run history. workflow_id from list_workflows. To pause one instead, use toggle_workflow.',
    input_schema: { type: 'object', properties: { workflow_id: { type: 'string' } }, required: ['workflow_id'] },
  },
  {
    name: 'create_coupon',
    description: 'Create a coupon code for programs: percent_off (1-100) or amount_off (dollars); duration once|forever (for subscriptions); optional expires_at (ISO), max_uses, program_id (blank = every program).',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' }, percent_off: { type: 'number' }, amount_off: { type: 'number' },
        duration: { type: 'string', enum: ['once', 'forever'] }, expires_at: { type: 'string' },
        max_uses: { type: 'integer' }, program_id: { type: 'string' },
      },
      required: ['code'],
    },
  },
];

export const OWNER_READ_ONLY = ['list_programs'];
export const OWNER_SENSITIVE = OWNER_TOOLS.map((t) => t.name).filter((n) => !OWNER_READ_ONLY.includes(n));

// ── helpers ────────────────────────────────────────────────────────────
const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const money = (n) => `$${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)}`;
const isoOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
function fmtDay(d) {
  const dt = new Date(`${isoOf(d)}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return isoOf(d) || '?';
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtMin(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '?';
  const h = Math.floor(n / 60), mm = n % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function needId(v, what, listTool) {
  const id = String(v || '').trim();
  if (!UUID_RE.test(id)) throw new Error(`${what} is required (get it from ${listTool})`);
  return id;
}

// ── plans ─────────────────────────────────────────────────────────────
async function planService(ws, a) {
  const id = needId(a.service_id, 'service_id', 'list_services');
  const s = (await sql`SELECT * FROM services WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!s) throw new Error('Service not found');
  const nm = `"${clip(s.name, 50)}"`;
  if (a.action === 'delete') {
    const up = (await sql`
      SELECT COUNT(*)::int AS n FROM bookings
       WHERE workspace_id = ${ws} AND service_id = ${id} AND cancelled_at IS NULL AND date >= CURRENT_DATE`).rows[0].n;
    return {
      summary: `Delete the service ${nm}. Clients can no longer book it.${up ? ` Its ${up} upcoming appointment${up === 1 ? '' : 's'} stay booked, without the service attached.` : ''}`,
      done: `Deleted the service ${nm}`,
      apply: async () => {
        const r = await sql`DELETE FROM services WHERE id = ${id} AND workspace_id = ${ws} RETURNING id`;
        if (!r.rows.length) throw new Error('Service not found');
        return { ok: true, deleted: true };
      },
    };
  }
  if (a.action !== 'update') throw new Error('action must be update or delete');
  const set = {};
  const parts = [];
  if (a.name != null) {
    const v = String(a.name).trim().slice(0, 120);
    if (!v) throw new Error('name cannot be empty');
    if (v !== s.name) { set.name = v; parts.push(`name to "${clip(v, 50)}"`); }
  }
  if (a.price != null) {
    const v = Number(a.price);
    if (!Number.isFinite(v) || v < 0 || v > 1_000_000) throw new Error('price must be a non-negative number of dollars');
    const r = Math.round(v * 100) / 100;
    if (r !== Number(s.price)) { set.price = r; parts.push(`price from ${money(s.price)} to ${money(r)}`); }
  }
  if (a.duration_minutes != null) {
    const v = Number(a.duration_minutes);
    if (!Number.isInteger(v) || v <= 0 || v > 24 * 60) throw new Error('duration_minutes must be a whole number from 1 to 1440');
    if (v !== Number(s.duration_minutes)) { set.dur = v; parts.push(`length from ${s.duration_minutes} to ${v} minutes`); }
  }
  if (a.description != null) {
    const v = String(a.description).slice(0, 4000);
    if (v !== (s.description || '')) { set.desc = v || null; parts.push(v ? `description to "${clip(v, 80)}"` : 'description removed'); }
  }
  if (a.capacity != null) {
    const v = Number(a.capacity);
    if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error('capacity must be 1 to 1000');
    if (v !== Number(s.capacity || 1)) { set.cap = v; parts.push(v === 1 ? 'capacity to one-on-one' : `capacity to ${v} people per time`); }
  }
  if (a.visibility != null) {
    if (!VISIBILITY_WORDS[a.visibility]) throw new Error('visibility must be public, private or only_me');
    if (a.visibility !== (s.visibility || 'public')) { set.vis = a.visibility; parts.push(`make it ${VISIBILITY_WORDS[a.visibility]}`); }
  }
  if (!parts.length) throw new Error('Nothing to change: pass a new name, price, duration_minutes, description, capacity or visibility');
  return {
    summary: `Change the service ${nm}: ${parts.join('; ')}${set.price != null || set.dur != null ? '. Appointments already booked keep their price and length' : ''}`,
    done: `Updated the service ${set.name ? `"${clip(set.name, 50)}"` : nm}`,
    apply: async () => {
      const r = await sql`
        UPDATE services SET
          name = COALESCE(${set.name ?? null}, name),
          price = COALESCE(${set.price ?? null}, price),
          duration_minutes = COALESCE(${set.dur ?? null}, duration_minutes),
          description = CASE WHEN ${'desc' in set} THEN ${set.desc ?? null} ELSE description END,
          capacity = COALESCE(${set.cap ?? null}, capacity),
          visibility = COALESCE(${set.vis ?? null}, visibility)
        WHERE id = ${id} AND workspace_id = ${ws}
        RETURNING id, name, price, duration_minutes, capacity, visibility`;
      if (!r.rows.length) throw new Error('Service not found');
      return { ok: true, service: r.rows[0] };
    },
  };
}

async function planReview(ws, a) {
  const id = needId(a.review_id, 'review_id', 'list_reviews');
  const r = (await sql`SELECT reviewer_name, rating, text, owner_response FROM reviews WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!r) throw new Error('Review not found');
  const text = String(a.response ?? '').trim().slice(0, 2000);
  const who = `${r.reviewer_name || 'a client'}'s ${r.rating}-star review`;
  if (!text && !r.owner_response) throw new Error('That review has no reply to remove');
  return {
    summary: text
      ? `${r.owner_response ? 'Replace your public reply on' : 'Reply publicly to'} ${who} ("${clip(r.text, 60)}") with: "${text}". Anyone who sees your reviews can read it.`
      : `Remove your public reply from ${who}`,
    done: text ? `Replied publicly to ${who}` : `Removed your reply from ${who}`,
    apply: async () => {
      const u = await sql`
        UPDATE reviews SET owner_response = ${text || null}, owner_responded_at = ${text ? new Date().toISOString() : null}
         WHERE id = ${id} AND workspace_id = ${ws} RETURNING id`;
      if (!u.rows.length) throw new Error('Review not found');
      return { ok: true, responded: !!text };
    },
  };
}

async function planUnblock(ws, a) {
  const id = needId(a.block_id, 'block_id', 'get_availability');
  const b = (await sql`SELECT date, start_min, end_min, all_day, label FROM calendar_blocks WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!b) throw new Error('That blocked time was not found');
  const when = `${fmtDay(b.date)} ${b.all_day ? '(all day)' : `${fmtMin(b.start_min)} to ${fmtMin(b.end_min)}`}${b.label ? `, "${clip(b.label, 40)}"` : ''}`;
  return {
    summary: `Remove the blocked time on ${when}. Clients can book that time again (within your weekly hours).`,
    done: `Unblocked ${when}`,
    apply: async () => {
      const r = await sql`DELETE FROM calendar_blocks WHERE id = ${id} AND workspace_id = ${ws} RETURNING id`;
      if (!r.rows.length) throw new Error('That blocked time was not found');
      return { ok: true, removed: true, date: isoOf(b.date) };
    },
  };
}

async function planBookingStatus(ws, a, ctx) {
  const id = needId(a.booking_id, 'booking_id', 'search_bookings or list_upcoming_bookings');
  const load = async () => (await sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  const b = await load();
  if (!b) throw new Error('Booking not found');
  const date = a.date ? String(a.date) : isoOf(b.date);
  if (!ISO_DATE.test(date)) throw new Error('date must be YYYY-MM-DD');
  const label = `${b.client_name || 'the client'}'s appointment on ${fmtDay(date)} at ${fmtMin(b.start_min)}`;
  const status = String(a.status || '');
  if (status === 'completed') {
    if (b.cancelled_at) throw new Error("Can't complete a cancelled booking");
    if (b.no_show_at) throw new Error('That appointment is marked as a no-show; undo the no-show first');
    if (completionLogOf(b)[date]) throw new Error('That appointment is already marked complete');
    const notes = a.notes ? String(a.notes).slice(0, 8000) : '';
    return {
      // The note is shown to the client: the card carries every word of it.
      summary: `Mark ${label} as completed${notes ? ` with the note "${notes}"` : ''}`,
      done: `Marked ${label} completed`,
      apply: async () => {
        try {
          await markComplete({ booking: await load(), occurrenceDate: date, userId: ctx?.userId || null, notes, visibleToClient: true });
        } catch (e) { if (e instanceof CompletionError) throw new Error(e.message); throw e; }
        return { ok: true, status: 'completed', date };
      },
    };
  }
  if (status === 'undo_completed') {
    if (!completionLogOf(b)[date]) throw new Error('That appointment is not marked complete');
    return {
      summary: `Undo "completed" on ${label}`,
      done: `Undid "completed" on ${label}`,
      apply: async () => { await undoComplete({ booking: await load(), occurrenceDate: date }); return { ok: true, status: 'not_completed', date }; },
    };
  }
  if (status === 'no_show') {
    if (b.cancelled_at) throw new Error("Can't mark a cancelled booking as a no-show");
    if (b.no_show_at) throw new Error('Already marked as a no-show');
    return {
      summary: `Mark ${label} as a no-show. No fee is charged (to charge a no-show fee, open the appointment in Calendar).`,
      done: `Marked ${label} as a no-show (no fee charged)`,
      apply: async () => {
        const r = await sql`
          UPDATE bookings SET no_show_at = NOW(), updated_at = NOW()
           WHERE id = ${id} AND workspace_id = ${ws} AND cancelled_at IS NULL AND no_show_at IS NULL RETURNING id`;
        if (!r.rows.length) throw new Error('Booking not found, cancelled, or already a no-show');
        return { ok: true, status: 'no_show' };
      },
    };
  }
  if (status === 'undo_no_show') {
    if (!b.no_show_at) throw new Error('That appointment is not marked as a no-show');
    return {
      summary: `Undo the no-show on ${label}${b.fee_charged_at ? ' (a fee already charged is not refunded by this)' : ''}`,
      done: `Undid the no-show on ${label}`,
      apply: async () => {
        // Same as the Calendar's undo: fee records stay untouched.
        const r = await sql`UPDATE bookings SET no_show_at = NULL, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${ws} AND no_show_at IS NOT NULL RETURNING id`;
        if (!r.rows.length) throw new Error('Booking not found or not a no-show');
        return { ok: true, status: 'not_no_show' };
      },
    };
  }
  throw new Error('status must be completed, undo_completed, no_show or undo_no_show');
}

async function planTask(ws, a) {
  const id = needId(a.task_id, 'task_id', 'list_tasks');
  const t = (await sql`SELECT title, due_date, notes, done FROM tasks WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!t) throw new Error('Task not found');
  const nm = `"${clip(t.title, 60)}"`;
  if (a.action === 'delete') {
    return {
      summary: `Delete the task ${nm}`,
      done: `Deleted the task ${nm}`,
      apply: async () => {
        const r = await sql`DELETE FROM tasks WHERE id = ${id} AND workspace_id = ${ws} RETURNING id`;
        if (!r.rows.length) throw new Error('Task not found');
        return { ok: true, deleted: true };
      },
    };
  }
  if (a.action === 'reopen') {
    if (!t.done) throw new Error('That task is not done');
    return {
      summary: `Reopen the task ${nm} (mark it not done)`,
      done: `Reopened the task ${nm}`,
      apply: async () => {
        await sql`UPDATE tasks SET done = FALSE, completed_at = NULL, completed_auto = FALSE, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${ws}`;
        return { ok: true, reopened: true };
      },
    };
  }
  if (a.action !== 'update') throw new Error('action must be update, reopen or delete');
  const set = {};
  const parts = [];
  if (a.title != null) {
    const v = String(a.title).trim().slice(0, 200);
    if (!v) throw new Error('title cannot be empty');
    if (v !== t.title) { set.title = v; parts.push(`rename it to "${clip(v, 60)}"`); }
  }
  if (a.due_date != null) {
    const v = String(a.due_date).trim();
    if (v && !ISO_DATE.test(v)) throw new Error('due_date must be YYYY-MM-DD (or empty to clear)');
    set.due = v || null;
    parts.push(v ? `due ${fmtDay(v)}` : 'no due date');
  }
  if (a.notes != null) { set.notes = String(a.notes).slice(0, 4000); parts.push(set.notes ? `notes to "${clip(set.notes, 80)}"` : 'notes cleared'); }
  if (!parts.length) throw new Error('Nothing to change: pass title, due_date or notes');
  return {
    summary: `Change the task ${nm}: ${parts.join('; ')}`,
    done: `Updated the task ${set.title ? `"${clip(set.title, 60)}"` : nm}`,
    apply: async () => {
      await sql`
        UPDATE tasks SET
          title = COALESCE(${set.title ?? null}, title),
          due_date = CASE WHEN ${'due' in set} THEN ${set.due ?? null}::date ELSE due_date END,
          notes = CASE WHEN ${'notes' in set} THEN ${set.notes || null} ELSE notes END,
          updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${ws}`;
      return { ok: true };
    },
  };
}

async function planDeleteWorkflow(ws, a) {
  const id = needId(a.workflow_id, 'workflow_id', 'list_workflows');
  const w = (await sql`SELECT name, enabled FROM workflows WHERE id = ${id} AND workspace_id = ${ws}`).rows[0];
  if (!w) throw new Error('Workflow not found');
  const nm = `"${clip(w.name, 60)}"`;
  return {
    summary: `Delete the automation ${nm}${w.enabled ? ' (it is on now; it stops for good)' : ''} and its run history. This cannot be undone.`,
    done: `Deleted the automation ${nm}`,
    apply: async () => {
      const r = await sql`DELETE FROM workflows WHERE id = ${id} AND workspace_id = ${ws} RETURNING id`;
      if (!r.rows.length) throw new Error('Workflow not found');
      return { ok: true, deleted: true };
    },
  };
}

async function planCoupon(ws, a) {
  const fin = await fetchFinanceSettings(ws).catch(() => null);
  const isAmount = a.amount_off != null && a.percent_off == null;
  const v = cleanCouponInput({
    code: a.code, kind: isAmount ? 'amount' : 'percent',
    percentOff: a.percent_off, amountOffCents: isAmount ? Math.round(Number(a.amount_off) * 100) : undefined,
    duration: a.duration, expiresAt: a.expires_at, maxRedemptions: a.max_uses, programId: a.program_id,
  }, { currency: (fin?.currency || 'USD').toLowerCase() });
  if (v.error) throw new Error(v.error);
  const c = v.value;
  let programTitle = null;
  if (c.program_id) {
    const p = (await sql`SELECT title FROM programs WHERE id = ${c.program_id} AND workspace_id = ${ws}`).rows[0];
    if (!p) throw new Error('Program not found');
    programTitle = p.title;
  }
  const dup = (await sql`SELECT 1 FROM program_coupons WHERE workspace_id = ${ws} AND code = ${c.code} AND active`).rows[0];
  if (dup) throw new Error('There is already an active code with that name');
  const off = c.kind === 'percent' ? `${c.percent_off}% off` : `${money(c.amount_off_cents / 100)} off`;
  const extra = [
    c.duration === 'forever' ? 'every payment of a subscription' : 'the first payment',
    c.expires_at ? `until ${fmtDay(c.expires_at)}` : null,
    c.max_redemptions ? `up to ${c.max_redemptions} uses` : null,
  ].filter(Boolean).join(', ');
  return {
    summary: `Create the coupon code ${c.code}: ${off} ${programTitle ? `"${clip(programTitle, 50)}"` : 'any program'} (${extra})`,
    done: `Created the coupon code ${c.code} (${off})`,
    apply: async () => {
      let row;
      try {
        row = (await sql`
          INSERT INTO program_coupons (workspace_id, program_id, code, kind, percent_off, amount_off_cents, currency, duration, expires_at, max_redemptions)
          VALUES (${ws}, ${c.program_id}, ${c.code}, ${c.kind}, ${c.percent_off}, ${c.amount_off_cents}, ${c.currency}, ${c.duration}, ${c.expires_at}, ${c.max_redemptions})
          RETURNING *`).rows[0];
      } catch (e) {
        if (e?.code === '23505') throw new Error('There is already an active code with that name');
        throw e;
      }
      // Mirrored on the payment account when connected, same as the
      // Programs screen; otherwise checkout creates it on first use.
      try {
        const { loadStripeCreds } = await import('./stripeCreds.js');
        await ensureStripeCoupon({ coupon: row, creds: await loadStripeCreds(ws) });
      } catch { /* created on first use */ }
      return { ok: true, coupon: { id: row.id, code: row.code } };
    },
  };
}

const PLANS = {
  manage_service: planService,
  reply_to_review: planReview,
  unblock_calendar_time: planUnblock,
  update_booking_status: planBookingStatus,
  manage_task: planTask,
  delete_workflow: planDeleteWorkflow,
  create_coupon: planCoupon,
};

export async function planOwnerAction(name, args, ctx) {
  const fn = PLANS[name];
  if (!fn) return null;
  if (!ctx?.workspaceId) throw new Error('No workspace');
  return fn(ctx.workspaceId, args && typeof args === 'object' ? args : {}, ctx);
}

export async function describeOwnerAction(name, a, ctx) {
  if (!PLANS[name]) return null;
  return (await planOwnerAction(name, a, ctx))?.summary || null;
}

export async function refuseOwnerAction(name, a, ctx) {
  if (!PLANS[name]) return null;
  try {
    await planOwnerAction(name, a, ctx);
    return null;
  } catch (err) {
    return `${err?.message || 'That is not possible'}. Nothing was changed.`;
  }
}

// ── handlers ───────────────────────────────────────────────────────────
async function list_programs({ workspaceId }) {
  const [programs, coupons] = await Promise.all([
    sql`SELECT p.id, p.title, p.status, p.price_cents, p.billing,
               (SELECT COUNT(*)::int FROM program_enrollments e
                 WHERE e.program_id = p.id AND e.workspace_id = p.workspace_id AND e.status = 'active') AS members
          FROM programs p WHERE p.workspace_id = ${workspaceId} AND p.status <> 'archived'
         ORDER BY p.created_at DESC LIMIT 50`,
    sql`SELECT c.id, c.code, c.kind, c.percent_off, c.amount_off_cents, c.duration, c.expires_at, c.max_redemptions, p.title AS program,
               (SELECT COUNT(*)::int FROM program_coupon_redemptions r WHERE r.coupon_id = c.id) AS used
          FROM program_coupons c LEFT JOIN programs p ON p.id = c.program_id
         WHERE c.workspace_id = ${workspaceId} AND c.active ORDER BY c.created_at DESC LIMIT 50`,
  ]);
  return {
    programs: programs.rows.map((p) => ({ ...p, price: Number(p.price_cents || 0) / 100, price_cents: undefined })),
    coupons: coupons.rows,
    manage: '[Programs](/programs)',
  };
}

function writeHandler(name) {
  return async (ctx) => {
    const plan = await planOwnerAction(name, ctx.args, ctx);
    const result = await plan.apply();
    return { ...result, done: plan.done, summary: plan.summary };
  };
}

export const OWNER_HANDLERS = {
  list_programs,
  ...Object.fromEntries(OWNER_SENSITIVE.map((n) => [n, writeHandler(n)])),
};

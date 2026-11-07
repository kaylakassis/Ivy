// Scale guards for the hottest platform-wide queries and payloads:
//   [1] booking-reminders (every 10 minutes) narrows bookings by a date
//       range the date index can answer, instead of reading every booking
//       on the platform each run.
//   [2] review-requests (hourly) finds candidates through the
//       completion_log index, not by unpacking every completed booking.
//   [3] the foreign keys Postgres checks on delete have indexes, so
//       deleting an invoice or a client does not read whole tables.
//   [4] GET /api/calendar?only=setup returns settings + services without
//       the schedule (screens that only need the service list).
//   [5] the setup checklist still sees a real booking / sent invoice after
//       its "is there one" queries stopped counting all history.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/scale-queries.test.mjs

import { createRequire } from 'node:module';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { fetchDueBookings } from '../api/cron/booking-reminders.js';
import { selectDueReviewRequests } from '../api/cron/review-requests.js';
import { computeSetupStatus } from '../api/_lib/setupStatus.js';
const { default: calendarHandler } = await import('../api/calendar/index.js');

const pg = createRequire(import.meta.url)('pg');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture the SQL a function sends, to EXPLAIN it on a second connection.
async function captureSql(fn) {
  const seen = [];
  const orig = pg.Client.prototype.query;
  pg.Client.prototype.query = function (text, params, cb) {
    seen.push({ text: typeof text === 'string' ? text : text?.text, params: Array.isArray(params) ? params : [] });
    return orig.call(this, text, params, cb);
  };
  try { await fn(); } finally { pg.Client.prototype.query = orig; }
  return seen;
}

// Plan with sequential scans priced out: if the query CAN use the index
// with a real condition, the planner does; otherwise it falls back to a
// scan with no Index Cond on that index.
async function planOf(q) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('SET enable_seqscan = off');
    const r = await c.query('EXPLAIN (FORMAT JSON) ' + q.text, q.params);
    return r.rows[0]['QUERY PLAN'][0].Plan;
  } finally { await c.end(); }
}
function nodes(p, out = []) { out.push(p); for (const k of p.Plans || []) nodes(k, out); return out; }

function mkRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; } };
}

const tag = `scaleq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let uid, ws;

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] booking-reminders scan uses the date index');
    const rq = (await captureSql(() => fetchDueBookings(null))).find((q) => /FROM bookings b/.test(q.text));
    const rNodes = nodes(await planOf(rq));
    const dateScan = rNodes.find((n) => n['Index Name'] === 'idx_bookings_date_active');
    assert(!!dateScan, 'plan reads bookings through idx_bookings_date_active');
    assert(/date >=/.test(dateScan?.['Index Cond'] || ''), `with a date range condition (${dateScan?.['Index Cond'] || 'none'})`);

    console.log('\n[2] review-requests finds candidates through the completion_log index');
    const vq = (await captureSql(() => selectDueReviewRequests())).find((q) => /FROM bookings b/.test(q.text));
    const vNodes = nodes(await planOf(vq));
    const logScan = vNodes.find((n) => n['Index Name'] === 'idx_bookings_completion_log');
    assert(!!logScan && /\?\|/.test(logScan['Index Cond'] || ''), `plan uses idx_bookings_completion_log with ?| (${logScan?.['Index Cond'] || 'none'})`);

    console.log('\n[3] delete-time foreign keys and hot sorts have indexes');
    const want = ['idx_bookings_date_active', 'idx_bookings_review_requested', 'idx_clients_ws_recent',
      'idx_bookings_collect_invoice', 'idx_bookings_fee_invoice', 'idx_invoices_client', 'idx_message_threads_client'];
    const have = new Set((await sql`SELECT indexname FROM pg_indexes WHERE indexname = ANY(${want})`).rows.map((r) => r.indexname));
    for (const n of want) assert(have.has(n), `${n} exists`);

    console.log('\n[4] GET /api/calendar?only=setup skips the schedule');
    uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, email_verified_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW(), NOW()) RETURNING id`).rows[0].id;
    ws = (await sql`INSERT INTO workspaces (owner_id, onboarded_at, subscription_status, trial_ends_at)
      VALUES (${uid}, NOW(), 'trialing', NOW() + INTERVAL '10 days') RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${ws}, 'Scale Biz', ${tag})`;
    await sql`INSERT INTO services (workspace_id, name, duration_minutes) VALUES (${ws}, 'Cut', 60)`;
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${ws}, 'Real', ${`${tag}-c@example.com`}, 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, date, start_min, end_min)
      VALUES (${ws}, ${cid}, 'Real', CURRENT_DATE + 1, 600, 660)`;
    const req = (query) => ({ method: 'GET', url: '/api/calendar', query,
      headers: { host: 'localhost:3001', 'user-agent': 'test/1.0', cookie: `ivy_session=${signSession(uid)}` }, on() {} });
    const full = mkRes();
    await calendarHandler(req({}), full);
    assert(full.statusCode === 200 && full.body?.calendar?.bookings?.length === 1, 'plain GET still returns the booking (older apps)');
    const lite = mkRes();
    await calendarHandler(req({ only: 'setup' }), lite);
    assert(lite.statusCode === 200, 'only=setup returns 200');
    assert(lite.body?.calendar?.services?.length === 1 && lite.body.calendar.settings?.bizName === 'Scale Biz', 'settings and services are there');
    assert(Array.isArray(lite.body?.calendar?.bookings) && lite.body.calendar.bookings.length === 0, 'no bookings sent');
    assert(Array.isArray(lite.body?.calendar?.blocks) && lite.body.calendar.blocks.length === 0, 'no blocks sent');

    console.log('\n[5] setup checklist still sees a real booking and a sent invoice');
    let st = await computeSetupStatus({ userId: uid, workspaceId: ws, emailVerifiedAt: new Date() });
    const item = (id) => st.items.find((i) => i.id === id);
    const bookingItem = st.items.find((i) => /book/i.test(i.id) && i.done);
    assert(!!bookingItem, 'a booking item is done with one real booking');
    const invoiceItemBefore = st.items.find((i) => /invoice/i.test(i.id));
    assert(invoiceItemBefore && !invoiceItemBefore.done, 'invoice item open with no sent invoice');
    await sql`INSERT INTO invoices (workspace_id, client_id, number, client_name, status, items) VALUES (${ws}, ${cid}, 'SQ-1', 'Real', 'sent', '[]'::jsonb)`;
    st = await computeSetupStatus({ userId: uid, workspaceId: ws, emailVerifiedAt: new Date() });
    assert(item(invoiceItemBefore.id)?.done === true, 'invoice item done once one is sent');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (ws) {
      await sql`DELETE FROM bookings WHERE workspace_id = ${ws}`.catch(() => {});
      await sql`DELETE FROM invoices WHERE workspace_id = ${ws}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${ws}`.catch(() => {});
    }
    if (uid) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

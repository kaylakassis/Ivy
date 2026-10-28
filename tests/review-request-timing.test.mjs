// Review prompts at the right moment (api/cron/review-requests.js).
// Each rule gets a booking that should be picked and one that must not:
//   • 2 to 3 hours after the session ended, never before
//   • only completed / attended sessions (completion_log), never no-shows
//   • an invoice for the session must be paid first
//   • once per client per business per 30 days
//   • never to blocked clients or clients who opted out of 'marketing'
//   • never from an archived (inactive) workspace
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/review-request-timing.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { selectDueReviewRequests, dueReviewRequests } from '../api/cron/review-requests.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const tag = `rrt-${Date.now()}`;
const TZ = 'America/Chicago';
// A fixed "now" so the window math is deterministic: 2026-06-10 18:00 UTC
// = 13:00 in Chicago (CDT).
const NOW = new Date('2026-06-10T18:00:00Z');
const H = 60 * 60 * 1000;

// Wall-clock (Chicago) date + end minute for an instant.
function chicagoDateAndEnd(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, endMin: hour * 60 + Number(parts.minute) };
}

async function run() {
  await ensureSchemaApplied();
  const owner = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${owner}, 'Active Studio', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${wid}, 'Active Studio', ${`rrt-${Date.now()}`}, ${TZ})`;
  const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes) VALUES (${wid}, 'Session', 60) RETURNING id`).rows[0].id;

  let n = 0;
  async function mkClient(workspaceId = wid, extra = {}) {
    const email = `${tag}-c${++n}@example.com`;
    const id = (await sql`INSERT INTO clients (workspace_id, name, email, stage, notification_prefs)
      VALUES (${workspaceId}, ${'Client ' + n}, ${email}, 'active', ${JSON.stringify(extra.prefs || {})}::jsonb) RETURNING id`).rows[0].id;
    return { id, email };
  }
  // endedAgoMs: how long before NOW the occurrence ended (negative = future).
  async function mkBooking({ client, endedAgoMs, completed = true, noShow = false, workspaceId = wid, collectInvoiceId = null, reviewRequestedAt = null }) {
    const { date, endMin } = chicagoDateAndEnd(NOW.getTime() - endedAgoMs);
    const startMin = Math.max(0, endMin - 60);
    const log = completed ? { [date]: { completedAt: new Date(NOW.getTime() - endedAgoMs).toISOString() } } : {};
    return (await sql.query(
      `INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min,
                             completion_log, no_show_at, collect_invoice_id, review_requested_at)
       VALUES ($1,$2,$3,'C',$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING id`,
      [workspaceId, svc, client.id, client.email, date, startMin, endMin, JSON.stringify(log),
       noShow ? NOW.toISOString() : null, collectInvoiceId, reviewRequestedAt],
    )).rows[0].id;
  }
  const due = async () => new Set((await dueReviewRequests({ now: NOW })).map((r) => r.id));

  console.log('\n[1] timing: 2 to 3 hours after the session ended, never before');
  const c1 = await mkClient();
  const justRight = await mkBooking({ client: c1, endedAgoMs: 2.5 * H });
  const c2 = await mkClient();
  const tooSoon = await mkBooking({ client: c2, endedAgoMs: 1 * H });
  const c3 = await mkClient();
  const notYet = await mkBooking({ client: c3, endedAgoMs: -2 * H });          // ends in 2 hours
  const c4 = await mkClient();
  const stillRunning = await mkBooking({ client: c4, endedAgoMs: -0.25 * H }); // ends in 15 min
  const c5 = await mkClient();
  const stale = await mkBooking({ client: c5, endedAgoMs: 9 * 24 * H });       // 9 days ago
  let ids = await due();
  assert(ids.has(justRight), 'session that ended 2.5h ago is due');
  assert(!ids.has(tooSoon), 'session that ended 1h ago is not yet due');
  assert(!ids.has(notYet), 'session that has not started is never due');
  assert(!ids.has(stillRunning), 'session still in progress is never due');
  assert(!ids.has(stale), 'session from 9 days ago dropped out of the window');

  console.log('\n[2] only completed / attended sessions');
  const c6 = await mkClient();
  const notMarked = await mkBooking({ client: c6, endedAgoMs: 2.5 * H, completed: false });
  const c7 = await mkClient();
  const noShow = await mkBooking({ client: c7, endedAgoMs: 2.5 * H, noShow: true });
  ids = await due();
  assert(!ids.has(notMarked), 'session the owner never marked complete is not due');
  assert(!ids.has(noShow), 'no-show is never asked');

  console.log('\n[3] an invoice for the session must be paid first');
  const c8 = await mkClient();
  const openInvoice = (await sql`INSERT INTO invoices (workspace_id, client_id, number, status, items)
    VALUES (${wid}, ${c8.id}, 'RRT-OPEN', 'sent', '[]'::jsonb) RETURNING id`).rows[0].id;
  const unpaidSession = await mkBooking({ client: c8, endedAgoMs: 2.5 * H, collectInvoiceId: openInvoice });
  ids = await due();
  assert(!ids.has(unpaidSession), 'session with an unpaid invoice waits');
  await sql`UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = ${openInvoice}`;
  ids = await due();
  assert(ids.has(unpaidSession), 'the same session is due once the invoice is paid');

  console.log('\n[4] once per client per business per 30 days');
  const c9 = await mkClient();
  await mkBooking({ client: c9, endedAgoMs: 20 * 24 * H, reviewRequestedAt: new Date(NOW.getTime() - 10 * 24 * H).toISOString() });
  const recentlyAsked = await mkBooking({ client: c9, endedAgoMs: 2.5 * H });
  const c10 = await mkClient();
  await mkBooking({ client: c10, endedAgoMs: 60 * 24 * H, reviewRequestedAt: new Date(NOW.getTime() - 40 * 24 * H).toISOString() });
  const askedLongAgo = await mkBooking({ client: c10, endedAgoMs: 2.5 * H });
  ids = await due();
  assert(!ids.has(recentlyAsked), 'client asked 10 days ago is not asked again');
  assert(ids.has(askedLongAgo), 'client asked 40 days ago can be asked again');

  console.log('\n[5] blocked or opted-out clients are never asked');
  const c11 = await mkClient();
  await sql`INSERT INTO contact_blocks (workspace_id, client_id, direction) VALUES (${wid}, ${c11.id}, 'client_blocks_business')`;
  const blockedByClient = await mkBooking({ client: c11, endedAgoMs: 2.5 * H });
  const c12 = await mkClient();
  await sql`INSERT INTO contact_blocks (workspace_id, client_id, direction) VALUES (${wid}, ${c12.id}, 'owner_blocks_client')`;
  const blockedByOwner = await mkBooking({ client: c12, endedAgoMs: 2.5 * H });
  const c13 = await mkClient(wid, { prefs: { marketing: false } });
  const optedOut = await mkBooking({ client: c13, endedAgoMs: 2.5 * H });
  const c14 = await mkClient(wid, { prefs: { marketing: true, bookings: false } });
  const optedIn = await mkBooking({ client: c14, endedAgoMs: 2.5 * H });
  ids = await due();
  assert(!ids.has(blockedByClient), 'client who blocked the business is not asked');
  assert(!ids.has(blockedByOwner), 'client the business blocked is not asked');
  assert(!ids.has(optedOut), "client with notification_prefs.marketing=false is not asked");
  assert(ids.has(optedIn), 'client who only muted other categories is still asked');

  console.log('\n[6] never from an archived (inactive) workspace');
  const owner2 = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}-lapsed@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const widLapsed = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${owner2}, 'Lapsed Studio', 'cancelled', NOW() - INTERVAL '10 days') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${widLapsed}, 'Lapsed Studio', ${`rrt-l-${Date.now()}`}, ${TZ})`;
  const cL = await mkClient(widLapsed);
  const lapsed = await mkBooking({ client: cL, endedAgoMs: 2.5 * H, workspaceId: widLapsed });
  const candidates = new Set((await selectDueReviewRequests({ now: NOW })).map((r) => r.id));
  ids = await due();
  assert(candidates.has(lapsed), 'the lapsed workspace booking otherwise qualifies');
  assert(!ids.has(lapsed), 'but an inactive workspace never sends review requests');
  assert(ids.has(justRight), 'active workspace bookings are unaffected');
  await sql`UPDATE workspaces SET comp_until = NOW() + INTERVAL '30 days' WHERE id = ${widLapsed}`;
  ids = await due();
  assert(ids.has(lapsed), 'a complimentary-access workspace counts as active again');

  await sql`DELETE FROM workspaces WHERE id IN (${wid}, ${widLapsed})`;
  await sql`DELETE FROM users WHERE id IN (${owner}, ${owner2})`;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

// Invoice reminder and review request crons send each email once, even when the same cron
// fires twice at the same moment (the scheduler can deliver one event more
// than once, and an operator can trigger a run by hand). Each run must
// claim the invoice before it emails, so the second run skips it.
// The same holds for the owner emails (subscription dunning, the weekly
// recap), the client group digest and the unsigned-document reminder; and
// when the email fails, the claim is handed back so a later run retries.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/cron-claim-once.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import overdueCron from '../api/cron/invoice-overdue.js';
import dueSoonCron from '../api/cron/invoice-due-soon.js';
import reviewCron from '../api/cron/review-requests.js';
import dunningCron from '../api/cron/subscription-dunning.js';
import digestCron from '../api/cron/group-digest.js';
import docCron from '../api/cron/doc-reminders.js';
import recapCron from '../api/cron/owner-weekly-recap.js';

process.env.ADMIN_SECRET ||= 'test-admin-secret';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}
const cronReq = (path) => ({ method: 'GET', url: path, query: {}, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });

const tag = `claim1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const overdueTo = `${tag}-overdue@example.com`;
const soonTo = `${tag}-soon@example.com`;
const reviewTo = `${tag}-review@example.com`;
const dunTo = `${tag}-dun@example.com`;
const dunFailTo = `${tag}-dun-fail@example.com`;
const digestTo = `${tag}-digest@example.com`;
const digestFailTo = `${tag}-digest-fail@example.com`;
const docTo = `${tag}-doc@example.com`;
const recapTo = `${tag}-recap@example.com`;

// Count the emails that actually reach the mail provider, per recipient.
const sentTo = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend')) {
    let to = [];
    try { to = [].concat(JSON.parse(init?.body || '{}').to || []); } catch { /* not JSON */ }
    for (const t of to) sentTo.set(t, (sentTo.get(t) || 0) + 1);
    // A little latency, like a real provider, so two runs interleave.
    await new Promise((r) => setTimeout(r, 30));
    // The provider refuses these addresses: the send fails.
    if (to.some((t) => /-fail@/.test(t))) {
      return new Response(JSON.stringify({ message: 'provider down' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: `stub-${Date.now()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

let ownerId, workspaceId;
const extraUsers = [];
const extraWorkspaces = [];
async function mkOwner(email, ws = {}) {
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Claim Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  extraUsers.push(uid);
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, subscription_past_due_since, onboarded_at)
    VALUES (${uid}, 'Claim Studio', ${ws.status || 'active'}, NOW() + INTERVAL '20 days', ${ws.pastDueSince || null}, NOW() - INTERVAL '30 days') RETURNING id`).rows[0].id;
  extraWorkspaces.push(wid);
  return { uid, wid };
}
const twice = async (handler, path) => {
  const [x, y] = [mockRes(), mockRes()];
  await Promise.all([handler(cronReq(path), x), handler(cronReq(path), y)]);
  return [x, y];
};

async function run() {
  try {
    await ensureSchemaApplied();
    ownerId = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${`${tag}@example.com`}, 'x', 'Claim', NOW()) RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at) VALUES (${ownerId}, 'trialing', NOW() + INTERVAL '10 days') RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${workspaceId}, 'USD')`.catch(() => {});
    await sql.query(
      `INSERT INTO invoices (workspace_id, number, client_name, client_email, status, items, tax_rate, discount, due_date)
       VALUES ($1, 'CL-OVERDUE', 'Pat', $2, 'sent', '[{"quantity":1,"rate":100}]'::jsonb, 0, 0, CURRENT_DATE - 3),
              ($1, 'CL-SOON',    'Sam', $3, 'sent', '[{"quantity":1,"rate":100}]'::jsonb, 0, 0, CURRENT_DATE + 2)`,
      [workspaceId, overdueTo, soonTo],
    );

    console.log('\n[1] overdue reminder: two runs at once send one email');
    const [a, b] = [mockRes(), mockRes()];
    await Promise.all([
      overdueCron(cronReq('/api/cron/invoice-overdue'), a),
      overdueCron(cronReq('/api/cron/invoice-overdue'), b),
    ]);
    assert(a.statusCode === 200 && b.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(overdueTo) === 1, `client got exactly one overdue email (got ${sentTo.get(overdueTo) || 0})`);
    const od = (await sql`SELECT last_overdue_reminder_at FROM invoices WHERE workspace_id = ${workspaceId} AND number = 'CL-OVERDUE'`).rows[0];
    assert(!!od?.last_overdue_reminder_at, 'overdue invoice stamped');

    console.log('\n[2] a later run inside the repeat window sends nothing more');
    await overdueCron(cronReq('/api/cron/invoice-overdue'), mockRes());
    assert(sentTo.get(overdueTo) === 1, `still one overdue email (got ${sentTo.get(overdueTo) || 0})`);

    console.log('\n[3] due-soon reminder: two runs at once send one email');
    const [c, d] = [mockRes(), mockRes()];
    await Promise.all([
      dueSoonCron(cronReq('/api/cron/invoice-due-soon'), c),
      dueSoonCron(cronReq('/api/cron/invoice-due-soon'), d),
    ]);
    assert(c.statusCode === 200 && d.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(soonTo) === 1, `client got exactly one due-soon email (got ${sentTo.get(soonTo) || 0})`);
    const ds = (await sql`SELECT due_soon_reminder_sent_at FROM invoices WHERE workspace_id = ${workspaceId} AND number = 'CL-SOON'`).rows[0];
    assert(!!ds?.due_soon_reminder_sent_at, 'due-soon invoice stamped');

    console.log('\n[4] review request: two runs at once ask once');
    // A session yesterday 10:00 to 11:00 UTC, marked complete: inside the
    // 2 hours to 7 days window whatever the time of day.
    const bookingId = (await sql.query(
      `INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min, completion_log)
       VALUES ($1, 'Rae', $2, (NOW() AT TIME ZONE 'UTC')::date - 1, 600, 660,
               jsonb_build_object(((NOW() AT TIME ZONE 'UTC')::date - 1)::text, jsonb_build_object('completedAt', NOW())))
       RETURNING id`,
      [workspaceId, reviewTo],
    )).rows[0].id;
    const [e, f] = [mockRes(), mockRes()];
    await Promise.all([
      reviewCron(cronReq('/api/cron/review-requests'), e),
      reviewCron(cronReq('/api/cron/review-requests'), f),
    ]);
    assert(e.statusCode === 200 && f.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(reviewTo) === 1, `client got exactly one review request (got ${sentTo.get(reviewTo) || 0})`);
    const bk = (await sql`SELECT review_requested_at, review_request_token_hash FROM bookings WHERE id = ${bookingId}`).rows[0];
    assert(!!bk?.review_requested_at && !!bk?.review_request_token_hash, 'booking stamped with a live review link');

    console.log('\n[5] subscription dunning: two runs at once email the owner once');
    const dun = await mkOwner(dunTo, { status: 'past_due', pastDueSince: new Date(Date.now() - 2 * 86400000) });
    let [g, h] = await twice(dunningCron, '/api/cron/subscription-dunning');
    assert(g.statusCode === 200 && h.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(dunTo) === 1, `owner got exactly one dunning email (got ${sentTo.get(dunTo) || 0})`);
    let w = (await sql`SELECT subscription_last_dunning_at FROM workspaces WHERE id = ${dun.wid}`).rows[0];
    assert(!!w?.subscription_last_dunning_at, 'workspace stamped');

    console.log('\n[6] subscription dunning: a failed email hands the claim back');
    const dunFail = await mkOwner(dunFailTo, { status: 'past_due', pastDueSince: new Date(Date.now() - 2 * 86400000) });
    await dunningCron(cronReq('/api/cron/subscription-dunning'), mockRes());
    w = (await sql`SELECT subscription_last_dunning_at FROM workspaces WHERE id = ${dunFail.wid}`).rows[0];
    assert(sentTo.get(dunFailTo) === 1 && w && w.subscription_last_dunning_at == null, 'send attempted, stamp released for the next run');

    console.log('\n[7] group digest: two runs at once send one digest; a failed send is retried later');
    const groupWs = (await mkOwner(`${tag}-groupowner@example.com`)).wid;
    const thread = (await sql`INSERT INTO group_threads (workspace_id, name, last_message_preview) VALUES (${groupWs}, 'Morning crew', 'See you at 7') RETURNING id`).rows[0].id;
    const digestUsers = {};
    for (const email of [digestTo, digestFailTo]) {
      const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, digest_groups_daily)
        VALUES (${email}, 'x', 'Group Member', NOW(), TRUE) RETURNING id`).rows[0].id;
      extraUsers.push(uid);
      digestUsers[email] = uid;
      const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id) VALUES (${groupWs}, 'Group Member', ${email}, 'active', ${uid}) RETURNING id`).rows[0].id;
      await sql`INSERT INTO group_thread_members (thread_id, client_id, workspace_id, unread_count) VALUES (${thread}, ${cid}, ${groupWs}, 3)`;
    }
    [g, h] = await twice(digestCron, '/api/cron/group-digest');
    assert(g.statusCode === 200 && h.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(digestTo) === 1, `member got exactly one digest (got ${sentTo.get(digestTo) || 0})`);
    const du = (await sql`SELECT id, digest_last_sent_at FROM users WHERE id IN (${digestUsers[digestTo]}, ${digestUsers[digestFailTo]})`).rows;
    assert(!!du.find((x) => x.id === digestUsers[digestTo])?.digest_last_sent_at, 'member stamped');
    assert(du.find((x) => x.id === digestUsers[digestFailTo])?.digest_last_sent_at == null, 'failed send: stamp released');

    console.log('\n[8] unsigned document reminder: two runs at once remind once');
    const docId = (await sql`INSERT INTO documents (workspace_id, name, recipient_name, recipient_email, status, sent_at)
      VALUES (${workspaceId}, 'Waiver', 'Dee', ${docTo}, 'sent', NOW() - INTERVAL '4 days') RETURNING id`).rows[0].id;
    [g, h] = await twice(docCron, '/api/cron/doc-reminders');
    assert(g.statusCode === 200 && h.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(docTo) === 1, `signer got exactly one reminder (got ${sentTo.get(docTo) || 0})`);
    const dr = (await sql`SELECT last_overdue_reminder_at FROM documents WHERE id = ${docId}`).rows[0];
    assert(!!dr?.last_overdue_reminder_at, 'document stamped');

    console.log('\n[9] weekly recap: two runs at once email the owner once');
    const rc = await mkOwner(recapTo);
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${rc.wid}, 'Recap Studio', ${`${tag}-recap`}) ON CONFLICT (workspace_id) DO NOTHING`;
    await sql`INSERT INTO invoices (workspace_id, number, client_name, items, status, paid_at, paid_amount)
      VALUES (${rc.wid}, 'CL-RECAP', 'Sam', '[{"quantity":1,"rate":80}]'::jsonb, 'paid', NOW() - INTERVAL '1 day', 80)`;
    [g, h] = await twice(recapCron, '/api/cron/owner-weekly-recap');
    assert(g.statusCode === 200 && h.statusCode === 200, 'both runs return 200');
    assert(sentTo.get(recapTo) === 1, `owner got exactly one weekly recap (got ${sentTo.get(recapTo) || 0})`);
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    for (const wid of extraWorkspaces) {
      await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${wid}`.catch(() => {});
    }
    for (const uid of extraUsers) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
    if (workspaceId) await sql`DELETE FROM documents WHERE workspace_id = ${workspaceId}`.catch(() => {});
    if (workspaceId) {
      await sql`DELETE FROM bookings WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM invoices WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
    }
    if (ownerId) await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

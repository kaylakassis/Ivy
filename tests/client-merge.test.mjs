// Possible duplicate clients and merging two records into one.
//
//   [1] Detection precision on a realistic fixture: same email in another
//       case, same phone in another format, "Jane D." / "Jane Doe" with the
//       same phone, Gmail dots and +tags (suggested only), nicknames and
//       accents; never a pair for two people who only share a first name,
//       a single-word name, or the same name with different emails AND
//       phones. Blocking keeps a 6,000 client book fast.
//   [2] /api/clients/duplicates: list with counts, ?count=1, "Not the same
//       person" persists, another business's ids are refused, helpers and
//       other owners see nothing of this business.
//   [3] Merge moves every reference. The list of (table, column) pairs that
//       point at a client is read from information_schema / pg_catalog, so a
//       future client_id table is checked too: after the merge, nothing
//       points at the removed id, and each table's count for the kept id is
//       its old count plus the removed one's (minus duplicate rows the kept
//       client already had, which are recorded in the merge record).
//   [4] Field choices, notes appended, tags union, more active stage,
//       custom fields, opt-outs (email and STOP) kept, card and active
//       autopay kept, packages kept, cancellation policy evidence untouched
//       but still listed under the kept client.
//   [5] Conflicts: two claimed portal accounts refused, autopay on two
//       different cards refused; nothing changes.
//   [6] Exactly once: a double tap (two merges at the same moment) runs
//       once; the second answers alreadyMerged.
//   [7] Workspace isolation: another owner cannot merge, preview or dismiss
//       this business's clients; the merge never touches their rows.
//   [8] Ivy: find_duplicate_clients reads; merge_clients and
//       dismiss_duplicate are held for approval with the exact card text,
//       refused before a card when impossible, and run once on Approve.
//   [9] Import: the count of new possible duplicates after an import.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-merge.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import dupHandler from '../api/clients/duplicates.js';
import mergeHandler from '../api/clients/merge.js';
import importHandler from '../api/clients/import.js';
import { findDuplicatePairs, nameRelation, canonicalEmail } from '../api/_lib/clientDuplicates.js';
import { mergeClients, mergeSentence } from '../api/_lib/clientMerge.js';
import { listAcceptances } from '../api/_lib/cancellationPolicy.js';
import { clientAllowsEmail } from '../api/_lib/notificationPrefs.js';
import { executeIvyTool, SENSITIVE_TOOLS, IVY_TOOLS } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
import pg from 'pg';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
let ipN = 1;
async function call(handler, { method = 'GET', body = {}, query = {}, userId }) {
  const res = mockRes();
  await handler({
    method, url: '/', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', host: 'localhost:3001',
      'x-forwarded-for': `203.0.113.${(ipN++ % 200) + 1}`, cookie: `ivy_session=${signSession(userId)}` },
  }, res);
  return res;
}

async function mkOwner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`merge-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { u: u.rows[0].id, w: w.rows[0].id };
}
async function mkClient(w, { name, email = null, phone = null, stage = 'lead', created = null, userId = null, notes = null, tags = null }) {
  const r = await sql`
    INSERT INTO clients (workspace_id, name, email, phone, stage, created_at, user_id, notes, tags)
    VALUES (${w}, ${name}, ${email}, ${phone}, ${stage}, COALESCE(${created}::timestamptz, NOW()), ${userId}, ${notes}, COALESCE(${tags}::text[], ARRAY[]::text[]))
    RETURNING id`;
  return r.rows[0].id;
}
const pairOf = (pairs, x, y) => pairs.find((p) => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x));

await ensureSchemaApplied();
const A = await mkOwner('a');
const B = await mkOwner('b');
const extraUsers = [];

try {
  // ── [1] detection ────────────────────────────────────────────────────
  console.log('[1] detection precision');
  assert(nameRelation('Jane D.', 'Jane Doe') === 'initial', '"Jane D." and "Jane Doe" relate by an initial');
  assert(nameRelation('José Álvarez', 'jose  alvarez') === 'exact', 'accents, case and spaces are ignored');
  assert(nameRelation('Kate Ruiz', 'Katherine Ruiz') === 'nickname', 'a nickname with the same last name is similar');
  assert(nameRelation('Jayne Doe', 'Jane Doe') === 'typo', 'a one letter typo in a longer name is similar');
  assert(nameRelation('Jane Doe', 'Jane Smith') === null, 'same first name only is not a match');
  assert(nameRelation('Jane', 'Jane Doe') === null, 'a single word name is never a name match');
  assert(canonicalEmail('Sam.Patel+book@GoogleMail.com') === 'sampatel@gmail.com', 'Gmail dots and +tags are folded for suggestions');

  const old = (d) => new Date(Date.now() - d * 86400e3).toISOString();
  const c = {};
  c.jane = await mkClient(A.w, { name: 'Jane Doe', email: 'jane.doe@example.com', phone: '+15552010101', created: old(400), stage: 'active' });
  c.janeD = await mkClient(A.w, { name: 'Jane D.', phone: '+15552010101', created: old(10) });
  c.janeS = await mkClient(A.w, { name: 'Jane Smith', email: 'jsmith@example.com', phone: '+15553000000' });
  c.janeOnly = await mkClient(A.w, { name: 'Jane', email: 'jane.other@example.com' });
  c.mark1 = await mkClient(A.w, { name: 'Mark Lee', email: 'MARK@Lee.com' });
  c.mark2 = await mkClient(A.w, { name: 'Mark Lee', email: ' mark@lee.com ' });
  c.ana1 = await mkClient(A.w, { name: 'Ana Garcia', phone: '(555) 444-1212' });
  c.ana2 = await mkClient(A.w, { name: 'Ana Garcia', email: 'ana@example.com', phone: '555.444.1212' });
  c.sam1 = await mkClient(A.w, { name: 'Sam Patel', email: 'sam.patel@gmail.com' });
  c.sam2 = await mkClient(A.w, { name: 'Sam Patel', email: 'sampatel+book@gmail.com' });
  c.chris1 = await mkClient(A.w, { name: 'Chris Wong', email: 'chris1@a.com', phone: '+15551110001' });
  c.chris2 = await mkClient(A.w, { name: 'Chris Wong', email: 'chris2@b.com', phone: '+15551110002' });
  c.kath = await mkClient(A.w, { name: 'Katherine Ruiz', email: 'kr@example.com' });
  c.kate = await mkClient(A.w, { name: 'Kate Ruiz' });
  c.jose1 = await mkClient(A.w, { name: 'José Álvarez' });
  c.jose2 = await mkClient(A.w, { name: 'jose alvarez' });
  const johns = [];
  const SURNAMES = ['Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Davies', 'Evans', 'Thomas', 'Roberts', 'Walker',
    'Wright', 'Robinson', 'Thompson', 'White', 'Hughes', 'Edwards', 'Green', 'Hall', 'Wood', 'Harris',
    'Lewis', 'Martin', 'Jackson', 'Clarke', 'Clark', 'Turner', 'Hill', 'Scott', 'Cooper', 'Morris'];
  for (let i = 0; i < 30; i++) johns.push(await mkClient(A.w, { name: `John ${SURNAMES[i]}`, email: `john${i}@example.com` }));
  // One letter apart but each with their own email: two families.
  johns.push(await mkClient(A.w, { name: 'Jane Johnson', email: 'jj1@example.com' }));
  johns.push(await mkClient(A.w, { name: 'Jane Johnston', email: 'jj2@example.com' }));
  // Another business holds the same Jane: never paired across businesses.
  const bJane = await mkClient(B.w, { name: 'Jane Doe', email: 'jane.doe@example.com', phone: '+15552010101' });

  let r = await call(dupHandler, { userId: A.u });
  assert(r.statusCode === 200, 'GET /api/clients/duplicates answers 200');
  const pairs = r.body.pairs;
  const expected = [
    ['jane', 'janeD', 'same_phone'], ['mark1', 'mark2', 'same_email'], ['ana1', 'ana2', 'same_phone'],
    ['sam1', 'sam2', 'similar_email'], ['kath', 'kate', 'similar_name'], ['jose1', 'jose2', 'similar_name'],
  ];
  for (const [x, y, conf] of expected) {
    const p = pairOf(pairs, c[x], c[y]);
    assert(p && p.confidence === conf, `${x} / ${y} found as ${conf}${p ? ` (${p.label}: ${p.reasons.join('; ')})` : ''}`);
  }
  assert(pairs.length === expected.length, `exactly ${expected.length} pairs, no false positives (got ${pairs.length})`);
  const jp = pairOf(pairs, c.jane, c.janeD);
  assert(jp?.reasons.some((x) => /initial/.test(x)), 'Jane D. / Jane Doe also lists the initial as a reason');
  assert(jp?.keepId === c.jane, 'the older record is suggested to keep');
  assert(!pairs.some((p) => [p.a.id, p.b.id].includes(bJane)), "another business's Jane is never listed");
  assert(!pairs.some((p) => [p.a.id, p.b.id].includes(c.janeS) || [p.a.id, p.b.id].includes(c.janeOnly)), 'same first name only: no pair');
  assert(!pairOf(pairs, c.chris1, c.chris2), 'same name but different emails and phones: two people');
  assert(!pairs.some((p) => johns.includes(p.a.id) || johns.includes(p.b.id)), '30 Johns with different surnames (Clark / Clarke each with an email), Johnson / Johnston: no pair');
  assert(jp && typeof jp.a.counts?.bookings === 'number' && 'lastBooking' in jp.a, 'each side carries record counts and last booking');

  // Blocking: a big book stays fast and finds the planted pair.
  const big = [];
  const firsts = ['Ann', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivan', 'Jo'];
  for (let i = 0; i < 6000; i++) {
    big.push({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `${firsts[i % 10]} Person${i}`, email: `p${i}@example.com`, phone: `+1555${String(1000000 + i)}`, created_at: '2025-01-01' });
  }
  big.push({ id: 'ffffffff-0000-4000-8000-000000000001', name: 'Ann Person0', email: 'P0@Example.com', created_at: '2025-01-02' });
  const t0 = Date.now();
  const bigOut = findDuplicatePairs(big);
  const ms = Date.now() - t0;
  assert(bigOut.total === 1 && ms < 3000, `6,001 clients scanned in ${ms} ms with exactly the planted pair (${bigOut.total})`);

  // ── [2] count, dismiss ───────────────────────────────────────────────
  console.log('[2] count and Not the same person');
  r = await call(dupHandler, { userId: A.u, query: { count: '1' } });
  assert(r.body.total === expected.length, '?count=1 gives the same total');
  r = await call(dupHandler, { userId: A.u, method: 'POST', body: { action: 'dismiss', clientIds: [c.kate, c.kath] } });
  assert(r.statusCode === 200 && r.body.ok, 'dismiss answers ok');
  r = await call(dupHandler, { userId: A.u, method: 'POST', body: { action: 'dismiss', clientIds: [c.kate, c.kath] } });
  assert(r.statusCode === 200, 'dismissing again is harmless');
  r = await call(dupHandler, { userId: A.u });
  assert(!pairOf(r.body.pairs, c.kath, c.kate) && r.body.total === expected.length - 1, 'the dismissed pair is gone and stays gone');
  const stored = await sql`SELECT COUNT(*)::int AS n FROM client_duplicate_dismissals WHERE workspace_id = ${A.w}`;
  assert(stored.rows[0].n === 1, 'the dismissal is stored once');
  r = await call(dupHandler, { userId: A.u, method: 'POST', body: { action: 'dismiss', clientIds: [c.jane, bJane] } });
  assert(r.statusCode === 404, "a pair with another business's client is refused");
  r = await call(dupHandler, { userId: B.u });
  assert(r.statusCode === 200 && r.body.pairs.every((p) => ![p.a.id, p.b.id].some((id) => Object.values(c).includes(id))), "another owner never sees this business's pairs");
  r = await call(dupHandler, { userId: B.u, method: 'POST', body: { action: 'dismiss', clientIds: [c.mark1, c.mark2] } });
  assert(r.statusCode === 404, "another owner cannot dismiss this business's pair");
  r = await call(dupHandler, { userId: A.u, method: 'POST', body: { action: 'dismiss', clientIds: ['nope', c.mark1] } });
  assert(r.statusCode === 400, 'malformed ids are refused');

  // ── [3] merge moves every reference ──────────────────────────────────
  console.log('[3] merge moves every reference');
  // Rich fixture: K (kept) and R (removed), plus a bystander X.
  const ownerUserR = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`merge-portal-r-${S}@example.com`}, 'x', 'Jane') RETURNING id`).rows[0].id;
  extraUsers.push(ownerUserR);
  const K = await mkClient(A.w, { name: 'Jane Doe', email: 'jane@studio-k.com', phone: '+15559990001', stage: 'lead', created: old(300), notes: 'Prefers mornings.', tags: ['vip', 'Yoga'] });
  const R = await mkClient(A.w, { name: 'Jane D.', email: 'jane.d@example.com', phone: '+15559990002', stage: 'active', created: old(20), userId: ownerUserR, notes: 'Allergic to lavender.', tags: ['yoga', 'new'] });
  const X = await mkClient(A.w, { name: 'Bystander Bo', email: 'bo@example.com' });
  const field = (await sql`INSERT INTO client_field_definitions (workspace_id, label, type) VALUES (${A.w}, ${`Shoe size ${S}`}, 'text') RETURNING id`).rows[0].id;
  const field2 = (await sql`INSERT INTO client_field_definitions (workspace_id, label, type) VALUES (${A.w}, ${`Goal ${S}`}, 'text') RETURNING id`).rows[0].id;
  await sql`UPDATE clients SET custom_fields = ${JSON.stringify({ [field]: '7', [field2]: 'Strength' })}::jsonb,
                               address_street = '1 Keep St', address_city = 'Austin', birth_month = 3, birth_day = 4,
                               notification_prefs = '{"marketing": true}'::jsonb
             WHERE id = ${K}`;
  await sql`UPDATE clients SET custom_fields = ${JSON.stringify({ [field]: '8' })}::jsonb,
                               address_street = '2 Remove Ave', address_city = 'Dallas',
                               stripe_customer_id = 'cus_R', payment_method_id = 'pm_R', payment_method_brand = 'visa', payment_method_last4 = '4242',
                               sms_stopped_at = NOW() - INTERVAL '2 days', sms_consent_at = NULL,
                               notification_prefs = '{"marketing": false}'::jsonb,
                               lifetime_value = 120
             WHERE id = ${R}`;
  await sql`UPDATE clients SET lifetime_value = 80 WHERE id = ${K}`;
  // Opt-out log for R's address (an unsubscribe link click).
  await sql`INSERT INTO client_email_optouts (workspace_id, client_id, email, type, source) VALUES (${A.w}, ${R}, 'jane.d@example.com', 'bookings', 'link')`;
  await sql`UPDATE clients SET referred_by_client_id = ${R} WHERE id = ${X}`;

  const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${A.w}, 'Class', 60, 20) RETURNING id`).rows[0].id;
  const book = (cid, nm, em, d) => sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${A.w}, ${svc}, ${cid}, ${nm}, ${em}, ${d}, 540, 600)`;
  await book(K, 'Jane Doe', 'jane@studio-k.com', '2026-12-01');
  for (const d of ['2026-12-02', '2026-12-03', '2026-12-04']) await book(R, 'Jane D.', 'jane.d@example.com', d);
  const inv = (cid, n, em) => sql`INSERT INTO invoices (workspace_id, client_id, number, client_email, client_name) VALUES (${A.w}, ${cid}, ${n}, ${em}, 'x')`;
  await inv(R, `M-${S}-1`, 'jane.d@example.com'); await inv(R, `M-${S}-2`, 'jane.d@example.com'); await inv(K, `M-${S}-3`, 'jane@studio-k.com');
  await sql`INSERT INTO quotes (workspace_id, client_id, number) VALUES (${A.w}, ${R}, ${`Q-${S}`})`;
  const thK = (await sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at, last_message_preview) VALUES (${A.w}, ${K}, 1, NOW() - INTERVAL '3 days', 'old') RETURNING id`).rows[0].id;
  const thR = (await sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at, last_message_preview) VALUES (${A.w}, ${R}, 2, NOW() - INTERVAL '1 hour', 'newest') RETURNING id`).rows[0].id;
  await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${thK}, 'client', 'k1')`;
  for (let i = 0; i < 14; i++) await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${thR}, 'client', ${`r${i}`})`;
  const doc = (await sql`INSERT INTO documents (workspace_id, name, recipient_client_id) VALUES (${A.w}, 'Waiver', ${R}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO document_signers (document_id, name, email, client_id) VALUES (${doc}, 'Jane D.', 'jane.d@example.com', ${R})`;
  await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status) VALUES (${A.w}, ${R}, '10 classes', 10, 6, 'active')`;
  await sql`INSERT INTO tasks (workspace_id, title, client_id) VALUES (${A.w}, 'Call Jane', ${R})`;
  await sql`INSERT INTO projects (workspace_id, name, client_id) VALUES (${A.w}, 'Jane folder', ${R})`;
  await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, client_id) VALUES (${A.w}, 'Jane', 5, ${R})`;
  await sql`INSERT INTO waitlist_entries (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
            VALUES (${A.w}, ${svc}, ${R}, 'Jane D.', 'jane.d@example.com', '2026-12-10', 540, 600)`;
  await sql`INSERT INTO time_entries (workspace_id, client_id) VALUES (${A.w}, ${R})`;
  const wf = (await sql`INSERT INTO workflows (workspace_id, name, trigger_type) VALUES (${A.w}, 'Welcome', 'client_created') RETURNING id`).rows[0].id;
  await sql`INSERT INTO workflow_runs (workflow_id, workspace_id, client_id, status) VALUES (${wf}, ${A.w}, ${R}, 'succeeded')`;
  // Programs: both enrolled; the same badge and the same lesson done on both.
  const prog = (await sql`INSERT INTO programs (workspace_id, title) VALUES (${A.w}, 'Strong') RETURNING id`).rows[0].id;
  const item = (await sql`INSERT INTO program_items (program_id, workspace_id, type, title) VALUES (${prog}, ${A.w}, 'post', 'Day 1') RETURNING id`).rows[0].id;
  const item2 = (await sql`INSERT INTO program_items (program_id, workspace_id, type, title) VALUES (${prog}, ${A.w}, 'post', 'Day 2') RETURNING id`).rows[0].id;
  await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id) VALUES (${prog}, ${A.w}, ${R})`;
  await sql`INSERT INTO program_progress (workspace_id, program_id, client_id, item_id) VALUES (${A.w}, ${prog}, ${K}, ${item})`;
  await sql`INSERT INTO program_progress (workspace_id, program_id, client_id, item_id) VALUES (${A.w}, ${prog}, ${R}, ${item})`;
  await sql`INSERT INTO program_progress (workspace_id, program_id, client_id, item_id) VALUES (${A.w}, ${prog}, ${R}, ${item2})`;
  await sql`INSERT INTO program_badges (workspace_id, program_id, client_id, badge) VALUES (${A.w}, ${prog}, ${K}, 'first_step')`;
  await sql`INSERT INTO program_badges (workspace_id, program_id, client_id, badge) VALUES (${A.w}, ${prog}, ${R}, 'first_step')`;
  await sql`INSERT INTO program_badges (workspace_id, program_id, client_id, badge) VALUES (${A.w}, ${prog}, ${R}, 'streak_7')`;
  // Group chat membership on both.
  const gt = (await sql`INSERT INTO group_threads (workspace_id, name) VALUES (${A.w}, 'Morning crew') RETURNING id`).rows[0].id;
  await sql`INSERT INTO group_thread_members (thread_id, client_id, workspace_id) VALUES (${gt}, ${K}, ${A.w}), (${gt}, ${R}, ${A.w})`;
  // A recurring series with R's ACTIVE autopay on card pm_R.
  const series = (await sql`INSERT INTO recurring_invoices (workspace_id, client_id, name, cadence, next_run_at, client_email)
    VALUES (${A.w}, ${R}, 'Monthly', 'monthly', '2026-12-01', 'jane.d@example.com') RETURNING id`).rows[0].id;
  const ag = (await sql`INSERT INTO autopay_agreements (workspace_id, recurring_invoice_id, client_id, status, authorized_at, consent_text,
      payment_method_id, stripe_customer_id, card_brand, card_last4, max_amount_cents, currency, cadence)
    VALUES (${A.w}, ${series}, ${R}, 'active', NOW(), 'I agree', 'pm_R', 'cus_R', 'visa', '4242', 5000, 'USD', 'monthly') RETURNING id`).rows[0].id;
  // Cancellation policy: an acceptance (permanent) and a request link.
  const acc = (await sql`INSERT INTO cancellation_policy_acceptances (workspace_id, client_id, policy_text, status)
    VALUES (${A.w}, ${R}, 'Cancel 24h ahead', 'accepted') RETURNING id`).rows[0].id;
  await sql`INSERT INTO cancellation_policy_requests (workspace_id, client_id, token_hash, expires_at) VALUES (${A.w}, ${R}, ${`th-${S}`}, NOW() + INTERVAL '1 day')`;
  await sql`INSERT INTO client_duplicate_dismissals (workspace_id, client_a_id, client_b_id) VALUES (${A.w}, ${R < X ? R : X}, ${R < X ? X : R})`;
  // Business B: its own rows that must never move.
  const bClient = await mkClient(B.w, { name: 'B person', email: 'jane.d@example.com' });
  await sql`INSERT INTO tasks (workspace_id, title, client_id) VALUES (${B.w}, 'B task', ${bClient})`;

  // The dynamic list of client references, read from the catalog.
  const refs = (await sql`
    SELECT cl.relname AS tbl, a.attname AS col
      FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid
     WHERE cl.relnamespace = current_schema()::regnamespace AND cl.relkind IN ('r', 'p')
       AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
       AND (a.attname ~ 'client_id$' OR a.attname IN ('client_a_id', 'client_b_id')
            OR EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = cl.oid AND con.contype = 'f'
                         AND con.confrelid = 'clients'::regclass AND a.attnum = ANY (con.conkey)))
     ORDER BY 1, 2`).rows;
  const infoRefs = (await sql`
    SELECT c.table_name AS tbl, c.column_name AS col FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema() AND c.data_type = 'uuid' AND c.column_name LIKE '%client_id'`).rows;
  const refKeys = new Set(refs.map((x) => `${x.tbl}.${x.col}`));
  assert(infoRefs.every((x) => refKeys.has(`${x.tbl}.${x.col}`)), `every *client_id column in information_schema is in the merge's list (${refs.length} columns)`);
  // Kept on purpose: the merge records and dismissals are bookkeeping about
  // both ids; policy acceptances are permanent evidence (mapped, not edited).
  const NOT_MOVED = new Set(['client_merges.kept_client_id', 'client_merges.removed_client_id', 'client_merges.current_client_id',
    'cancellation_policy_acceptances.client_id']);
  const countFor = async (tbl, col, id) => (await sql.query(`SELECT COUNT(*)::int AS n FROM "${tbl}" WHERE "${col}" = $1`, [id])).rows[0].n;
  const before = {};
  for (const x of refs) before[`${x.tbl}.${x.col}`] = { k: await countFor(x.tbl, x.col, K), r: await countFor(x.tbl, x.col, R) };
  const populated = Object.entries(before).filter(([, v]) => v.r > 0).map(([key]) => key);
  assert(populated.length >= 20, `the fixture has rows for the removed client in ${populated.length} tables`);

  // Preview (the merge sheet).
  r = await call(mergeHandler, { userId: A.u, query: { keepId: K, removeId: R } });
  assert(r.statusCode === 200 && r.body.remove.counts.bookings === 3 && r.body.remove.counts.invoices === 2 && r.body.remove.counts.messages === 14,
    'preview counts 3 bookings, 2 invoices, 14 messages on the removed record');
  assert(r.body.sentence === 'Merge Jane D. into Jane Doe: 3 bookings, 2 invoices, 14 messages, 1 document and 1 package move to Jane Doe. Jane D. is removed.',
    `preview sentence: ${r.body.sentence}`);
  assert(r.body.suggestedKeepId === R, 'the record with a claimed portal account is suggested to keep');
  assert(r.body.refusal === null, 'no refusal for this pair');
  assert(mergeSentence({ keep: { name: 'Mark Lee', email: 'mark@lee.com', counts: {} }, remove: { name: 'mark lee', email: 'MARK@Lee.com', counts: {} } })
    === 'Merge mark lee (MARK@Lee.com) into Mark Lee (mark@lee.com). mark lee (MARK@Lee.com) has no bookings, invoices or messages yet and is removed.',
  'two records with the same name are told apart, and an empty record says so');

  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: K, removeId: R, fieldChoices: { email: 'remove', [field]: 'x', customFields: { [field]: 'remove' } } } });
  assert(r.statusCode === 200 && r.body.merged && !r.body.alreadyMerged, 'merge answers 200');
  const after = {};
  for (const x of refs) after[`${x.tbl}.${x.col}`] = { k: await countFor(x.tbl, x.col, K), r: await countFor(x.tbl, x.col, R) };
  const merge = (await sql`SELECT * FROM client_merges WHERE workspace_id = ${A.w} AND removed_client_id = ${R}`).rows[0];
  const droppedBy = {};
  for (const d of merge.dropped) droppedBy[`${d.table}.${d.column}`] = (droppedBy[`${d.table}.${d.column}`] || 0) + 1;
  const bad = [];
  for (const [key, b] of Object.entries(before)) {
    if (NOT_MOVED.has(key)) continue;
    const a = after[key];
    if (key === 'client_duplicate_dismissals.client_a_id' || key === 'client_duplicate_dismissals.client_b_id') {
      if (a.r !== 0) bad.push(`${key}: removed id still there`);
      continue;
    }
    if (key === 'clients.referred_by_client_id') {
      if (a.r !== 0 || a.k !== b.k + b.r) bad.push(`${key}: ${JSON.stringify({ b, a })}`);
      continue;
    }
    const expectK = key === 'message_threads.client_id' ? 1 : b.k + b.r - (droppedBy[key] || 0);
    if (a.r !== 0 || a.k !== expectK) bad.push(`${key}: before ${JSON.stringify(b)} after ${JSON.stringify(a)} dropped ${droppedBy[key] || 0}`);
  }
  assert(bad.length === 0, `every reference moved to the kept client${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  assert(after['cancellation_policy_acceptances.client_id'].r === 1, 'the policy acceptance keeps its original client id (permanent evidence)');
  assert((await sql`SELECT 1 FROM clients WHERE id = ${R}`).rows.length === 0, 'the removed client is gone');
  assert((await sql`SELECT COUNT(*)::int AS n FROM messages WHERE thread_id = ${thK}`).rows[0].n === 15, 'all 15 messages are in the kept thread');
  const th = (await sql`SELECT unread_biz, last_message_preview FROM message_threads WHERE id = ${thK}`).rows[0];
  assert(th.unread_biz === 3 && th.last_message_preview === 'newest', 'unread counts add up and the newest preview shows');
  assert(droppedBy['program_progress.client_id'] === 1 && droppedBy['program_badges.client_id'] === 1 && droppedBy['group_thread_members.client_id'] === 1,
    'rows the kept client already had (same lesson, same badge, same group) are dropped once and recorded');
  assert(merge.removed_snapshot?.name === 'Jane D.' && merge.kept_before?.name === 'Jane Doe' && merge.merged_by === A.u && merge.via === 'app',
    'the merge record has who, both records and the snapshot');
  const audit = await sql`SELECT meta FROM audit_events WHERE workspace_id = ${A.w} AND action = 'client.merge' AND target_id = ${K}`;
  assert(audit.rows.length === 1 && audit.rows[0].meta.removed_client_id === R, 'an audit row is written');

  // ── [4] the merged record ────────────────────────────────────────────
  console.log('[4] the merged record');
  const m = (await sql`SELECT * FROM clients WHERE id = ${K}`).rows[0];
  assert(m.name === 'Jane Doe' && m.email === 'jane.d@example.com' && m.phone === '+15559990001', 'name kept, chosen email from the removed record, kept phone');
  assert(m.stage === 'active', 'the more active stage wins');
  assert(m.notes.startsWith('Prefers mornings.') && m.notes.includes('Allergic to lavender.') && /Merged with Jane D\. on .*Other email: jane@studio-k\.com\..*Other phone: \+15559990002\./.test(m.notes),
    'notes are appended, with the other contact details');
  assert(JSON.stringify(m.tags) === JSON.stringify(['vip', 'Yoga', 'new']), `tags are a union without case duplicates (${JSON.stringify(m.tags)})`);
  assert(m.custom_fields[field] === '8' && m.custom_fields[field2] === 'Strength', 'custom field choice applied, other fields kept');
  assert(m.address_street === '1 Keep St' && m.birth_month === 3, 'address and birthday from the kept record');
  assert(m.user_id === ownerUserR, "the removed record's portal account now belongs to the kept client");
  assert(m.payment_method_id === 'pm_R' && m.stripe_customer_id === 'cus_R', 'the card on the active autopay agreement is kept');
  const agAfter = (await sql`SELECT client_id, status, consent_text FROM autopay_agreements WHERE id = ${ag}`).rows[0];
  assert(agAfter.client_id === K && agAfter.status === 'active' && agAfter.consent_text === 'I agree', 'the active autopay agreement moved, still active, consent unchanged');
  assert((await sql`SELECT client_id FROM recurring_invoices WHERE id = ${series}`).rows[0].client_id === K, 'its series moved too');
  assert((await sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE client_id = ${K} AND status = 'active' AND credits_remaining = 6`).rows[0].n === 1, 'the package and its sessions are kept');
  assert(m.sms_stopped_at && !m.sms_consent_at, 'STOP on either record is kept');
  assert(m.notification_prefs.marketing === false && m.notification_prefs.bookings === false, 'email opt-outs from either record are kept');
  assert(!(await clientAllowsEmail(K, 'marketing')) && !(await clientAllowsEmail(K, 'bookings')), 'sending checks honour the kept opt-outs');
  assert(Number(m.lifetime_value) === 200, 'lifetime value adds up');
  assert((await sql`SELECT referred_by_client_id FROM clients WHERE id = ${X}`).rows[0].referred_by_client_id === K, 'a client referred by the removed record now points at the kept one');
  const bk = await sql`SELECT DISTINCT client_name, client_email FROM bookings WHERE client_id = ${K}`;
  assert(bk.rows.length === 1 && bk.rows[0].client_email === 'jane.d@example.com' && bk.rows[0].client_name === 'Jane Doe', 'moved bookings show the merged name and email');
  const accs = await listAcceptances({ workspaceId: A.w, clientId: K });
  assert(accs.length === 1 && accs[0].id === acc, 'the policy acceptance is still listed under the kept client');
  assert((await sql`SELECT client_id FROM cancellation_policy_acceptances WHERE id = ${acc}`).rows[0].client_id === R, '...and the record itself was not edited');
  const dis = await sql`SELECT * FROM client_duplicate_dismissals WHERE workspace_id = ${A.w} AND (client_a_id = ${X} OR client_b_id = ${X})`;
  assert(dis.rows.length === 1 && [dis.rows[0].client_a_id, dis.rows[0].client_b_id].includes(K), '"Not the same person" with the removed record carries over to the kept one');
  assert((await sql`SELECT client_id FROM tasks WHERE workspace_id = ${B.w}`).rows[0].client_id === bClient, "the other business's rows are untouched");

  // Double tap after the fact.
  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: K, removeId: R } });
  assert(r.statusCode === 200 && r.body.alreadyMerged === true && r.body.keptClientId === K, 'merging again answers alreadyMerged and changes nothing');
  assert((await sql`SELECT COUNT(*)::int AS n FROM client_merges WHERE workspace_id = ${A.w} AND removed_client_id = ${R}`).rows[0].n === 1, 'one merge record');

  // ── [5] conflicts ────────────────────────────────────────────────────
  console.log('[5] conflicts');
  const u1 = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`merge-p1-${S}@example.com`}, 'x', 'P1') RETURNING id`).rows[0].id;
  const u2 = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`merge-p2-${S}@example.com`}, 'x', 'P2') RETURNING id`).rows[0].id;
  extraUsers.push(u1, u2);
  const P1 = await mkClient(A.w, { name: 'Pat One', email: 'pat@example.com', userId: u1 });
  const P2 = await mkClient(A.w, { name: 'Pat One', email: 'pat@example.org', userId: u2 });
  await sql`INSERT INTO tasks (workspace_id, title, client_id) VALUES (${A.w}, 'Pat task', ${P2})`;
  r = await call(mergeHandler, { userId: A.u, query: { keepId: P1, removeId: P2 } });
  assert(r.statusCode === 200 && r.body.refusalCode === 'both_claimed', 'the preview explains why two claimed accounts cannot merge');
  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: P1, removeId: P2 } });
  assert(r.statusCode === 409 && r.body.code === 'both_claimed' && /two different people/.test(r.body.error), 'merging two claimed portal accounts is refused with a clear message');
  assert((await sql`SELECT COUNT(*)::int AS n FROM tasks WHERE client_id = ${P2}`).rows[0].n === 1 && (await sql`SELECT 1 FROM clients WHERE id = ${P2}`).rows.length === 1, 'nothing changed');
  // Same portal user on both is fine (one person, two rows).
  const S1 = await mkClient(A.w, { name: 'Sol Same', userId: u1 });
  const S2 = await mkClient(A.w, { name: 'Sol Same', userId: u1 });
  const okSame = await mergeClients({ workspaceId: A.w, keepId: S1, removeId: S2, actor: { id: A.u } });
  assert(okSame.merged && !okSame.alreadyMerged, 'two rows of the same portal account merge');

  const C1 = await mkClient(A.w, { name: 'Card One', email: 'c1@example.com' });
  const C2 = await mkClient(A.w, { name: 'Card One', email: 'c1@example.com' });
  await sql`UPDATE clients SET payment_method_id = 'pm_1', stripe_customer_id = 'cus_1' WHERE id = ${C1}`;
  await sql`UPDATE clients SET payment_method_id = 'pm_2', stripe_customer_id = 'cus_2' WHERE id = ${C2}`;
  for (const [cid, pm, cus] of [[C1, 'pm_1', 'cus_1'], [C2, 'pm_2', 'cus_2']]) {
    const sr = (await sql`INSERT INTO recurring_invoices (workspace_id, client_id, name, cadence, next_run_at) VALUES (${A.w}, ${cid}, 'S', 'monthly', '2026-12-01') RETURNING id`).rows[0].id;
    await sql`INSERT INTO autopay_agreements (workspace_id, recurring_invoice_id, client_id, status, authorized_at, consent_text, payment_method_id, stripe_customer_id, max_amount_cents, currency, cadence)
      VALUES (${A.w}, ${sr}, ${cid}, 'active', NOW(), 'ok', ${pm}, ${cus}, 1000, 'USD', 'monthly')`;
  }
  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: C1, removeId: C2 } });
  assert(r.statusCode === 409 && r.body.code === 'autopay_cards', 'autopay on two different cards is refused');
  assert((await sql`SELECT COUNT(*)::int AS n FROM autopay_agreements WHERE client_id = ${C2} AND status = 'active'`).rows[0].n === 1, 'both agreements stay active');
  // Kept client has a card but no autopay; the removed one's autopay card wins.
  const D1 = await mkClient(A.w, { name: 'Dee Card', email: 'dee@example.com' });
  const D2 = await mkClient(A.w, { name: 'Dee Card', email: 'dee@example.com' });
  await sql`UPDATE clients SET payment_method_id = 'pm_keep', stripe_customer_id = 'cus_keep' WHERE id = ${D1}`;
  await sql`UPDATE clients SET payment_method_id = 'pm_auto', stripe_customer_id = 'cus_auto' WHERE id = ${D2}`;
  const dsr = (await sql`INSERT INTO recurring_invoices (workspace_id, client_id, name, cadence, next_run_at) VALUES (${A.w}, ${D2}, 'S', 'monthly', '2026-12-01') RETURNING id`).rows[0].id;
  await sql`INSERT INTO autopay_agreements (workspace_id, recurring_invoice_id, client_id, status, authorized_at, consent_text, payment_method_id, stripe_customer_id, max_amount_cents, currency, cadence)
    VALUES (${A.w}, ${dsr}, ${D2}, 'active', NOW(), 'ok', 'pm_auto', 'cus_auto', 1000, 'USD', 'monthly')`;
  await mergeClients({ workspaceId: A.w, keepId: D1, removeId: D2, actor: { id: A.u } });
  const d1 = (await sql`SELECT payment_method_id, stripe_customer_id FROM clients WHERE id = ${D1}`).rows[0];
  assert(d1.payment_method_id === 'pm_auto' && d1.stripe_customer_id === 'cus_auto', "the card on the merged autopay agreement is kept, so autopay keeps working");
  // Neither has autopay: the kept client's card stays.
  const E1 = await mkClient(A.w, { name: 'Eve Card' });
  const E2 = await mkClient(A.w, { name: 'Eve Card' });
  await sql`UPDATE clients SET payment_method_id = 'pm_e1', stripe_customer_id = 'cus_e1' WHERE id = ${E1}`;
  await sql`UPDATE clients SET payment_method_id = 'pm_e2', stripe_customer_id = 'cus_e2' WHERE id = ${E2}`;
  await mergeClients({ workspaceId: A.w, keepId: E1, removeId: E2, actor: { id: A.u } });
  assert((await sql`SELECT payment_method_id FROM clients WHERE id = ${E1}`).rows[0].payment_method_id === 'pm_e1', "without autopay the kept client's card stays");
  // The immutable consent still refuses an edit outside a merge.
  let immutable = false;
  try { await sql`UPDATE autopay_agreements SET client_id = ${E1} WHERE id = ${ag}`; } catch { immutable = true; }
  assert(immutable, 'outside a merge an authorized autopay agreement still cannot change client');

  // ── [6] exactly once under a double tap ─────────────────────────────
  console.log('[6] exactly once');
  const T1 = await mkClient(A.w, { name: 'Tap Twice', email: 'tap@example.com' });
  const T2 = await mkClient(A.w, { name: 'Tap Twice', email: 'tap@example.com' });
  for (let i = 0; i < 3; i++) await sql`INSERT INTO tasks (workspace_id, title, client_id) VALUES (${A.w}, 'tap', ${T2})`;
  const [x1, x2] = await Promise.all([
    call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: T1, removeId: T2 } }),
    call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: T1, removeId: T2 } }),
  ]);
  assert(x1.statusCode === 200 && x2.statusCode === 200, 'both taps answer 200');
  assert([x1.body.alreadyMerged, x2.body.alreadyMerged].filter(Boolean).length === 1, 'exactly one of them did the merge');
  assert((await sql`SELECT COUNT(*)::int AS n FROM tasks WHERE client_id = ${T1}`).rows[0].n === 3, 'tasks moved once');
  // Reverse direction afterwards is refused clearly.
  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: T2, removeId: T1 } });
  assert(r.statusCode === 409 && r.body.code === 'keep_merged', 'merging into a record that was merged away is refused');
  // Truly at the same moment: two database connections run the merge
  // together (the test rig otherwise shares one connection).
  const T3 = await mkClient(A.w, { name: 'Race Twice', email: 'race@example.com' });
  const T4 = await mkClient(A.w, { name: 'Race Twice', email: 'race@example.com' });
  for (let i = 0; i < 5; i++) await sql`INSERT INTO tasks (workspace_id, title, client_id) VALUES (${A.w}, 'race', ${T4})`;
  const conns = [new pg.Client({ connectionString: process.env.DATABASE_URL }), new pg.Client({ connectionString: process.env.DATABASE_URL })];
  await Promise.all(conns.map((cn) => cn.connect()));
  try {
    const q = 'SELECT ivy_merge_clients($1, $2, $3, NULL, $4, $5::jsonb, $6::text[]) AS r';
    const args = [A.w, T3, T4, 'app', '{}', ['marketing']];
    const outs = await Promise.all(conns.map((cn) => cn.query(q, args)));
    const statuses = outs.map((o) => o.rows[0].r.status).sort();
    assert(JSON.stringify(statuses) === JSON.stringify(['already_merged', 'merged']), `two connections at once: one merged, one already merged (${statuses.join(', ')})`);
  } finally {
    await Promise.all(conns.map((cn) => cn.end()));
  }
  assert((await sql`SELECT COUNT(*)::int AS n FROM tasks WHERE client_id = ${T3}`).rows[0].n === 5
    && (await sql`SELECT COUNT(*)::int AS n FROM client_merges WHERE removed_client_id = ${T4}`).rows[0].n === 1, 'moved once, one merge record');

  // ── [7] workspace isolation ──────────────────────────────────────────
  console.log('[7] workspace isolation');
  const W1 = await mkClient(A.w, { name: 'Wes Iso', email: 'wes@example.com' });
  const W2 = await mkClient(A.w, { name: 'Wes Iso', email: 'wes2@example.com' });
  r = await call(mergeHandler, { userId: B.u, method: 'POST', body: { keepId: W1, removeId: W2 } });
  assert(r.statusCode === 404, "another owner cannot merge this business's clients");
  r = await call(mergeHandler, { userId: B.u, query: { keepId: W1, removeId: W2 } });
  assert(r.statusCode === 404, '...or preview them');
  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: W1, removeId: bClient } });
  assert(r.statusCode === 404, "a client of another business cannot be merged in");
  let crossErr = null;
  try { await mergeClients({ workspaceId: B.w, keepId: bClient, removeId: W2 }); } catch (e) { crossErr = e; }
  assert(crossErr && crossErr.code === 'not_found' && (await sql`SELECT 1 FROM clients WHERE id = ${W2}`).rows.length === 1, 'the library refuses a cross-business merge too');
  r = await call(mergeHandler, { userId: A.u, method: 'POST', body: { keepId: 'x', removeId: W2 } });
  assert(r.statusCode === 400, 'malformed ids are refused');

  // ── [8] Ivy ──────────────────────────────────────────────────────────
  console.log('[8] Ivy');
  assert(SENSITIVE_TOOLS.has('merge_clients') && SENSITIVE_TOOLS.has('dismiss_duplicate') && !SENSITIVE_TOOLS.has('find_duplicate_clients'),
    'merge_clients and dismiss_duplicate are approval-gated; find_duplicate_clients reads');
  assert(['find_duplicate_clients', 'merge_clients', 'dismiss_duplicate'].every((n) => IVY_TOOLS.some((t) => t.name === n)), 'the three tools are offered to Ivy');
  const ctx = { workspaceId: A.w, userId: A.u, sessionId: null };
  const found = await executeIvyTool('find_duplicate_clients', {}, ctx);
  assert(!found.error && found.total >= 1 && found.pairs.some((p) => [p.a.id, p.b.id].includes(W1)), 'find_duplicate_clients lists the open pairs');
  const IK = await mkClient(A.w, { name: 'Jane Doe', email: `ivy-jane-${S}@example.com`, phone: '+15557770001', created: old(50) });
  const IR = await mkClient(A.w, { name: 'Jane D.', phone: '+15557770001' });
  for (const d of ['2026-12-05', '2026-12-06', '2026-12-07']) await book(IR, 'Jane D.', 'x@example.com', d);
  await inv(IR, `IV-${S}-1`, null); await inv(IR, `IV-${S}-2`, null);
  const ith = (await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${A.w}, ${IR}) RETURNING id`).rows[0].id;
  for (let i = 0; i < 14; i++) await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${ith}, 'biz', 'hi')`;
  const held = await executeIvyTool('merge_clients', { keep_client_id: IK, remove_client_id: IR, confirm: true }, ctx);
  assert(held.needs_confirmation && held.pending_id, 'merge_clients is held for approval (confirm in the arguments is ignored)');
  assert(held.summary === 'Merge Jane D. into Jane Doe: 3 bookings, 2 invoices and 14 messages move to Jane Doe. Jane D. is removed.', `card text: ${held.summary}`);
  assert((await sql`SELECT 1 FROM clients WHERE id = ${IR}`).rows.length === 1, 'nothing merged before Approve');
  const refused = await executeIvyTool('merge_clients', { keep_client_id: P1, remove_client_id: P2 }, ctx);
  assert(refused.error && /two different people/.test(refused.error) && /Nothing was changed/.test(refused.error), 'an impossible merge is refused before any card');
  const otherBiz = await executeIvyTool('merge_clients', { keep_client_id: IK, remove_client_id: bClient }, ctx);
  assert(otherBiz.error && /not found/i.test(otherBiz.error), "a client of another business reads as not found");
  const pend = (await sql`SELECT * FROM ivy_pending_actions WHERE id = ${held.pending_id}`).rows[0];
  const ranB = await executePendingAction({ row: pend, workspaceId: B.w, userId: B.u });
  assert(!ranB.claimed, 'another business cannot approve it');
  const ran = await executePendingAction({ row: pend, workspaceId: A.w, userId: A.u });
  assert(ran.claimed && !ran.result.error && /^Done\. Merged Jane D\. into Jane Doe: 3 bookings, 2 invoices and 14 messages moved to Jane Doe\. Jane D\. was removed/.test(ran.text), `Done text: ${ran.text}`);
  assert((await sql`SELECT 1 FROM clients WHERE id = ${IR}`).rows.length === 0 && (await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE client_id = ${IK}`).rows[0].n === 3, 'Approve merged them');
  assert((await sql`SELECT via FROM client_merges WHERE removed_client_id = ${IR}`).rows[0].via === 'ivy', 'the merge record says Ivy did it');
  const again = await executePendingAction({ row: pend, workspaceId: A.w, userId: A.u });
  assert(!again.claimed, 'the approval runs once');
  const dHeld = await executeIvyTool('dismiss_duplicate', { client_id_a: W1, client_id_b: W2 }, ctx);
  assert(dHeld.needs_confirmation && dHeld.summary === 'Mark Wes Iso (wes@example.com) and Wes Iso (wes2@example.com) as different people, so they are not suggested as duplicates again.', `dismiss card: ${dHeld.summary}`);
  const dRow = (await sql`SELECT * FROM ivy_pending_actions WHERE id = ${dHeld.pending_id}`).rows[0];
  const dRan = await executePendingAction({ row: dRow, workspaceId: A.w, userId: A.u });
  assert(dRan.claimed && !dRan.result.error, 'dismiss runs on Approve');
  const found2 = await executeIvyTool('find_duplicate_clients', {}, ctx);
  assert(!found2.pairs.some((p) => [p.a.id, p.b.id].includes(W1)), 'the dismissed pair is not suggested again');
  const dupAdd = await executeIvyTool('add_client', { name: 'Jane Again', email: `ivy-jane-${S}@example.com` }, ctx);
  assert(dupAdd.error && /merge_clients/.test(dupAdd.error) && /update_client/.test(dupAdd.error), 'add_client refusal points Ivy to update or merge');

  // ── [9] import ───────────────────────────────────────────────────────
  console.log('[9] import');
  const IM = await mkClient(A.w, { name: 'Imo Brown', email: `imo-${S}@example.com`, phone: '+15556660001' });
  r = await call(importHandler, { userId: A.u, method: 'POST', body: { quiet: true, rows: [
    { name: 'Imo Brown', email: `imo.brown-${S}@example.com` }, { name: `Unique Person${S}`, email: `u-${S}@example.com` },
  ] } });
  assert(r.statusCode === 200 && r.body.importedIds.length === 2, 'import adds both rows (different email, phone-only row is new)');
  const cnt = await call(dupHandler, { userId: A.u, method: 'POST', body: { action: 'count', clientIds: r.body.importedIds } });
  assert(cnt.statusCode === 200 && cnt.body.total === 1, 'one new possible duplicate is counted after the import');
  assert(IM, 'fixture client exists');
  const tooMany = await call(dupHandler, { userId: A.u, method: 'POST', body: { action: 'count', clientIds: Array(5001).fill(IM) } });
  assert(tooMany.statusCode === 400, 'the count is capped');
} catch (e) {
  fail++;
  console.log('  ✗ threw:', e.stack || e.message);
} finally {
  await sql`DELETE FROM users WHERE id = ANY(${[A.u, B.u, ...extraUsers]}::uuid[])`;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

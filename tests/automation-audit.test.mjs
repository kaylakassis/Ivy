// Automation audit: features the UI promises that didn't work end-to-end.
//   1. client_created / lead_created workflows fire from EVERY path that
//      creates a client row - public booking, booking-page contact form,
//      website form, CSV import, Ivy's add_client, owner-side booking -
//      and never twice for the same person.
//   2. "Instant reply to new leads" also fires from the booking-page /
//      embed contact form (prospects only).
//   3. Workflow runtime: a run resuming after `wait` sees the LIVE client
//      (tags added during the wait, deletion); booking_completed passes
//      tags to conditions and catches up missed days / late completions
//      exactly once.
//   4. "Send a document for signing" really sends (signer + token + email),
//      and leaves a draft with a logged reason when the client has no email.
//   5. Service prep_instructions ride along in the confirmation + reminder.
//   6. A virtual service's own meeting link wins over a minted Jitsi room
//      everywhere; owner-created virtual bookings get a link at all.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/automation-audit.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  triggerWorkflow, resumeWaitingWorkflows, evaluateScheduledWorkflows,
} from '../api/_lib/workflows.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import slugHandler from '../api/calendar/public/[slug].js';
import contactHandler from '../api/calendar/public/contact.js';
import formHandler from '../api/website/form-submission.js';
import importHandler from '../api/clients/import.js';
import ownerBookingsHandler from '../api/calendar/bookings.js';
import remindersCron from '../api/cron/booking-reminders.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture every email the handlers try to send.
const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('api.resend.com')) {
    const body = JSON.parse(init.body || '{}');
    outbox.push({ to: [].concat(body.to).join(','), subject: body.subject || '', html: body.html || '' });
    return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};
const mailsFor = (email, re) => outbox.filter((m) => m.to.includes(email) && re.test(m.subject));

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'POST', body = {}, query = {}, cookie, headers = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.18.2.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}), ...headers } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fire-and-forget side effects (public booking workflows, confirmation
// email) land a beat after the response - poll briefly.
async function waitFor(fn, { tries = 40, every = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v) return v;
    // eslint-disable-next-line no-await-in-loop
    await sleep(every);
  }
  return fn();
}
const fullWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]]));
const iso = (d) => d.toISOString().slice(0, 10);
async function dbDate(offsetDays) {
  return (await sql.query(`SELECT (CURRENT_DATE - ($1 || ' days')::interval)::date::text AS d`, [String(offsetDays)])).rows[0].d;
}

const STAMP = Date.now();
const SLUG = `aa-${STAMP}`;
const HANDLE = `aa-site-${STAMP}`;
let userId, wsId, cookie, svcPrep, svcVirtOwn, svcVirtAuto, wfClient, wfLead;
const OWN_LINK = 'https://zoom.us/j/5551234567';

async function runsFor(wfId, clientId) {
  const r = await sql`SELECT id, status, action_results FROM workflow_runs WHERE workflow_id = ${wfId} AND client_id = ${clientId}`;
  return r.rows;
}
async function clientByEmail(email) {
  return (await sql`SELECT * FROM clients WHERE workspace_id = ${wsId} AND lower(email) = ${email.toLowerCase()}`).rows;
}

async function setup() {
  await ensureSchemaApplied();
  process.env.CRON_SECRET = 'aa-test-cron';
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`aa-owner-${STAMP}@example.com`}, 'x', 'Avery Owner', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  cookie = `ivy_session=${signSession(userId)}`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${userId}, 'Audit WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  wsId = w.rows[0].id;
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, availability, lead_instant_reply_enabled)
     VALUES ($1, 'Audit Studio', $2, 'UTC', 30, 0, $3::jsonb, TRUE)
     ON CONFLICT (workspace_id) DO UPDATE SET slug = $2, timezone = 'UTC', slot_minutes = 30, min_notice_hours = 0,
       availability = $3::jsonb, lead_instant_reply_enabled = TRUE`,
    [wsId, SLUG, JSON.stringify(fullWeek)],
  );
  svcPrep = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price, location_type, prep_instructions, reminder_minutes)
    VALUES (${wsId}, 'Mobility Session', 60, 1, 0, 'in_person', ${'Wear comfortable clothes\nBring water'}, ${[120]}::int[]) RETURNING id`).rows[0].id;
  svcVirtOwn = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price, location_type, location_label)
    VALUES (${wsId}, 'Zoom Consult', 60, 1, 0, 'virtual', ${OWN_LINK}) RETURNING id`).rows[0].id;
  svcVirtAuto = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price, location_type)
    VALUES (${wsId}, 'Video Check-in', 60, 1, 0, 'virtual') RETURNING id`).rows[0].id;
  await sql`INSERT INTO websites (workspace_id, handle, business_name, published_at)
    VALUES (${wsId}, ${HANDLE}, 'Audit Studio', NOW())`;

  wfClient = (await sql.query(
    `INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
     VALUES ($1, 'Welcome', 'client_created', $2::jsonb, TRUE) RETURNING id`,
    [wsId, JSON.stringify([{ type: 'create_task', config: { title: 'Welcome {{firstName}}' } }])],
  )).rows[0].id;
  wfLead = (await sql.query(
    `INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
     VALUES ($1, 'Lead follow-up', 'lead_created', $2::jsonb, TRUE) RETURNING id`,
    [wsId, JSON.stringify([{ type: 'create_task', config: { title: 'Follow up {{firstName}}' } }])],
  )).rows[0].id;
}

async function publicBook(body) {
  const r = mockRes();
  await slugHandler(req({ query: { slug: SLUG }, body }), r);
  return r;
}
async function contact(body) {
  const r = mockRes();
  await contactHandler(req({ query: { slug: SLUG }, body }), r);
  return r;
}

async function run() {
  await setup();
  await sql`TRUNCATE rate_limits`;
  const future = iso(new Date(Date.now() + 5 * 24 * 3600 * 1000));

  // ── 1a. Public booking creates a lead → workflows + prep + own link ──
  console.log('\n[1] public booking: new lead fires client_created + lead_created, once');
  const BOOKER = `aa-booker-${STAMP}@example.com`;
  let r = await publicBook({ serviceId: svcPrep, date: future, startMin: 600, endMin: 660, clientName: 'Blake Booker', clientEmail: BOOKER });
  assert(r.statusCode === 201, `booking created (got ${r.statusCode}: ${r.body?.error || 'ok'})`);
  let booker = (await clientByEmail(BOOKER))[0];
  assert(booker?.stage === 'lead' && booker.source === 'Booking', 'booking created a lead client row');
  // Both triggers fire sequentially after the response - wait for both.
  await waitFor(async () => (await runsFor(wfClient, booker.id)).length && (await runsFor(wfLead, booker.id)).length);
  let cRuns = await runsFor(wfClient, booker.id);
  let lRuns = await runsFor(wfLead, booker.id);
  assert(cRuns?.length === 1 && cRuns[0].status === 'succeeded', `client_created fired once from the public booking (${cRuns?.length} run(s))`);
  assert(lRuns.length === 1, `lead_created fired once from the public booking (${lRuns.length} run(s))`);
  const tasks = (await sql`SELECT title FROM tasks WHERE workspace_id = ${wsId} AND client_id = ${booker.id} ORDER BY title`).rows.map((t) => t.title);
  assert(tasks.includes('Welcome Blake') && tasks.includes('Follow up Blake'), `workflow tasks created for the booker (${tasks.join(' | ')})`);

  // Second booking by the same person → matched, not re-created, no re-fire.
  r = await publicBook({ serviceId: svcPrep, date: future, startMin: 720, endMin: 780, clientName: 'Blake Booker', clientEmail: BOOKER });
  assert(r.statusCode === 201, 'second booking by the same email ok');
  await sleep(400);
  assert((await clientByEmail(BOOKER)).length === 1, 'still one client row');
  assert((await runsFor(wfClient, booker.id)).length === 1, 'returning booker does NOT re-fire client_created');

  console.log('\n[5] prep instructions ride along in the confirmation email');
  const confirm = await waitFor(async () => mailsFor(BOOKER, /Booking confirmed/)[0] || null);
  assert(!!confirm, 'booker got the confirmation email');
  assert(/Before your appointment/.test(confirm?.html || '') && /Bring water/.test(confirm?.html || ''), 'confirmation carries the service prep instructions');
  assert(/Wear comfortable clothes/.test(confirm?.html || ''), 'multi-line prep text is all there');

  console.log('\n[6] virtual meeting link: owner link wins, auto Jitsi otherwise');
  const VBOOKER = `aa-vbooker-${STAMP}@example.com`;
  r = await publicBook({ serviceId: svcVirtOwn, date: future, startMin: 840, endMin: 900, clientName: 'Val Virtual', clientEmail: VBOOKER });
  assert(r.statusCode === 201, `virtual (own link) booking created (got ${r.statusCode}: ${r.body?.error || 'ok'})`);
  assert(r.body?.booking?.videoRoomUrl === OWN_LINK, `success screen gets the owner's own link (got ${r.body?.booking?.videoRoomUrl})`);
  let vrow = (await sql`SELECT video_room_url FROM bookings WHERE id = ${r.body?.booking?.id}`).rows[0];
  assert(vrow?.video_room_url === OWN_LINK, 'bookings.video_room_url (portal + event drawer) is the owner link - no Jitsi room minted');
  const vmail = await waitFor(async () => mailsFor(VBOOKER, /Booking confirmed/)[0] || null);
  assert(vmail && vmail.html.includes(OWN_LINK) && !/meet\.jit\.si/.test(vmail.html), 'confirmation email shows the same owner link');

  r = await publicBook({ serviceId: svcVirtAuto, date: future, startMin: 960, endMin: 1020, clientName: 'Val Virtual', clientEmail: VBOOKER });
  assert(r.statusCode === 201, 'virtual (no own link) booking created');
  assert(/^https:\/\/meet\.jit\.si\/ivy-/.test(r.body?.booking?.videoRoomUrl || ''), `no owner link → Jitsi room minted (${r.body?.booking?.videoRoomUrl})`);

  r = await publicBook({ serviceId: svcPrep, date: future, startMin: 1080, endMin: 1140, clientName: 'Val Virtual', clientEmail: VBOOKER });
  assert(r.statusCode === 201 && r.body?.booking?.videoRoomUrl === null, 'in-person service → no meeting link');

  // Owner-side booking for a virtual service.
  const OWNBK = `aa-ownbk-${STAMP}@example.com`;
  r = mockRes();
  await ownerBookingsHandler(req({ cookie, body: { serviceId: svcVirtOwn, date: future, startMin: 1200, endMin: 1260, clientName: 'Olive Owned', clientEmail: OWNBK, skipConflictCheck: true } }), r);
  assert(r.statusCode === 201, `owner-created virtual booking ok (got ${r.statusCode}: ${r.body?.error || 'ok'})`);
  assert(r.body?.booking?.videoRoomUrl === OWN_LINK, `owner-created booking carries the owner link (got ${r.body?.booking?.videoRoomUrl})`);
  r = mockRes();
  await ownerBookingsHandler(req({ cookie, body: { serviceId: svcVirtAuto, date: future, startMin: 1260, endMin: 1320, clientName: 'Olive Owned', clientEmail: OWNBK, skipConflictCheck: true } }), r);
  assert(r.statusCode === 201 && /^https:\/\/meet\.jit\.si\/ivy-/.test(r.body?.booking?.videoRoomUrl || ''), 'owner-created booking on a no-link virtual service mints a Jitsi room (used to get nothing)');
  const owned = (await clientByEmail(OWNBK))[0];
  const ownedRuns = await waitFor(async () => (await runsFor(wfClient, owned.id)).length ? runsFor(wfClient, owned.id) : null);
  await sleep(300); // give a (wrong) lead_created fire time to land before asserting it didn't
  assert(ownedRuns?.length === 1, 'owner-side booking that creates a client fires client_created');
  assert((await runsFor(wfLead, owned.id)).length === 0, "owner-side booking creates an 'active' client → no lead_created");

  // ── 2. Contact form ─────────────────────────────────────────────────
  console.log('\n[2] booking-page contact form: new prospect → workflows + instant reply');
  const PROSPECT = `aa-prospect-${STAMP}@example.com`;
  r = await contact({ name: 'Pat Prospect', email: PROSPECT, message: 'Do you take beginners?' });
  assert(r.statusCode === 200, `contact ok (got ${r.statusCode}: ${r.body?.error || 'ok'})`);
  const prospect = (await clientByEmail(PROSPECT))[0];
  assert(prospect?.stage === 'lead' && prospect.source === 'public-contact', 'contact created a lead row');
  assert((await runsFor(wfClient, prospect.id)).length === 1, 'client_created fired from the contact form');
  assert((await runsFor(wfLead, prospect.id)).length === 1, 'lead_created fired from the contact form');
  assert(mailsFor(PROSPECT, /Thanks for reaching out/).length === 1, 'prospect got the instant reply');

  // The booker (created by the booking above) messages via the form → no second fire.
  r = await contact({ name: 'Blake Booker', email: BOOKER, message: 'Where do I park?' });
  assert(r.statusCode === 200, 'existing lead can message');
  assert((await clientByEmail(BOOKER)).length === 1, 'contact form matched the booking-created client (no duplicate row)');
  assert((await runsFor(wfClient, booker.id)).length === 1 && (await runsFor(wfLead, booker.id)).length === 1, 'booking + later contact form = workflows fired exactly once');
  assert(mailsFor(BOOKER, /Thanks for reaching out/).length === 1, 'a messaging lead still gets the instant reply');

  // An active client messaging gets a human, not the auto-reply.
  const ACTIVE = `aa-active-${STAMP}@example.com`;
  await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wsId}, 'Ava Active', ${ACTIVE}, 'active')`;
  r = await contact({ name: 'Ava Active', email: ACTIVE, message: 'See you Tuesday' });
  assert(r.statusCode === 200 && mailsFor(ACTIVE, /Thanks for reaching out/).length === 0, 'active client messaging gets NO instant reply');

  // Toggle off → no reply for a brand-new prospect.
  await sql`UPDATE calendar_settings SET lead_instant_reply_enabled = FALSE WHERE workspace_id = ${wsId}`;
  const QUIET = `aa-quiet-${STAMP}@example.com`;
  r = await contact({ name: 'Quinn Quiet', email: QUIET, message: 'Hi' });
  assert(r.statusCode === 200 && mailsFor(QUIET, /Thanks for reaching out/).length === 0, 'toggle off → no instant reply');
  assert((await runsFor(wfLead, (await clientByEmail(QUIET))[0].id)).length === 1, '...but lead_created still fires');
  await sql`UPDATE calendar_settings SET lead_instant_reply_enabled = TRUE WHERE workspace_id = ${wsId}`;

  // ── 3. Website form ────────────────────────────────────────────────
  console.log('\n[3] website form submission: lead recorded + workflows (once)');
  const WEB = `aa-web-${STAMP}@example.com`;
  r = mockRes();
  await formHandler(req({ body: { handle: HANDLE, formId: 'contact', payload: { Name: 'Wren Web', Email: WEB, message: 'Pricing?' } } }), r);
  assert(r.statusCode === 200 && r.body?.received === true, `form accepted (got ${r.statusCode})`);
  const web = (await clientByEmail(WEB))[0];
  assert(web?.stage === 'lead' && web.source === 'Website form' && web.name === 'Wren Web', 'website form created a lead row');
  assert((await runsFor(wfClient, web.id)).length === 1 && (await runsFor(wfLead, web.id)).length === 1, 'client_created + lead_created fired from the website form');
  assert(mailsFor(WEB, /Thanks for reaching out/).length === 1, 'website lead still gets the instant reply');
  r = mockRes();
  await formHandler(req({ body: { handle: HANDLE, formId: 'contact', payload: { Name: 'Wren Web', Email: WEB, message: 'Again' } } }), r);
  assert((await clientByEmail(WEB)).length === 1 && (await runsFor(wfClient, web.id)).length === 1, 'repeat submission: one row, no re-fire');
  r = mockRes();
  await formHandler(req({ body: { handle: HANDLE, formId: 'newsletter', payload: { email: `aa-news-${STAMP}@example.com` } } }), r);
  assert((await clientByEmail(`aa-news-${STAMP}@example.com`)).length === 0, 'newsletter signups are not turned into leads');

  // ── 4. CSV import ──────────────────────────────────────────────────
  console.log('\n[4] CSV import fires per imported client, skips huge imports');
  r = mockRes();
  await importHandler(req({ cookie, body: { rows: [
    { name: 'Imp One', email: `aa-imp1-${STAMP}@example.com` },
    { name: 'Imp Two', email: `aa-imp2-${STAMP}@example.com`, stage: 'active' },
    { name: 'Imp Dup', email: WEB }, // already exists → skipped, no fire
  ] } }), r);
  assert(r.statusCode === 200 && r.body?.summary?.created === 2 && r.body.summary.skipped === 1, `import created 2 / skipped 1 (got ${JSON.stringify(r.body?.summary)})`);
  assert(r.body?.summary?.workflowsFired === 3, `client_created x2 + lead_created x1 = 3 fires (got ${r.body?.summary?.workflowsFired})`);
  const imp1 = (await clientByEmail(`aa-imp1-${STAMP}@example.com`))[0];
  const imp2 = (await clientByEmail(`aa-imp2-${STAMP}@example.com`))[0];
  assert((await runsFor(wfClient, imp1.id)).length === 1 && (await runsFor(wfLead, imp1.id)).length === 1, 'imported lead: both triggers');
  assert((await runsFor(wfClient, imp2.id)).length === 1 && (await runsFor(wfLead, imp2.id)).length === 0, 'imported active client: client_created only');
  assert((await runsFor(wfClient, web.id)).length === 1, 'skipped duplicate row did not re-fire');

  const bigRows = Array.from({ length: 201 }, (_, i) => ({ name: `Bulk ${i}`, email: `aa-bulk${i}-${STAMP}@example.com` }));
  r = mockRes();
  await importHandler(req({ cookie, body: { rows: bigRows } }), r);
  assert(r.statusCode === 200 && r.body?.summary?.created === 201, `big import created 201 (got ${r.body?.summary?.created})`);
  assert(r.body?.summary?.workflowsSkipped === true && r.body.summary.workflowsFired === 0, 'over 200 new clients → workflows skipped and the response says so');
  const bulkRuns = (await sql`SELECT COUNT(*)::int AS n FROM workflow_runs wr JOIN clients c ON c.id = wr.client_id
    WHERE wr.workspace_id = ${wsId} AND c.email LIKE ${`aa-bulk%-${STAMP}@example.com`}`).rows[0].n;
  assert(bulkRuns === 0, 'no runs for the bulk rows');

  // ── 5. Ivy add_client ──────────────────────────────────────────────
  console.log('\n[5] Ivy add_client fires workflows');
  const IVY = `aa-ivy-${STAMP}@example.com`;
  const out = await executeIvyTool('add_client', { name: 'Ivy Lead', email: IVY, stage: 'lead' }, { workspaceId: wsId, userId });
  assert(out?.ok === true && out.client?.id, `add_client ok (${JSON.stringify(out).slice(0, 120)})`);
  assert(out?.workflows_fired === 2, `Ivy reports 2 fires (got ${out?.workflows_fired})`);
  assert((await runsFor(wfClient, out.client.id)).length === 1 && (await runsFor(wfLead, out.client.id)).length === 1, 'client_created + lead_created fired from Ivy');

  // ── 6. Wait → resume sees the live client ─────────────────────────
  console.log('\n[6] a run resuming after `wait` re-reads the live client');
  await sql`UPDATE workflows SET enabled = FALSE WHERE id IN (${wfClient}, ${wfLead})`;
  const wfWait = (await sql.query(
    `INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
     VALUES ($1, 'VIP after wait', 'client_created', $2::jsonb, TRUE) RETURNING id`,
    [wsId, JSON.stringify([
      { type: 'wait', config: { hours: 1 } },
      { type: 'if_has_tag', config: { tag: 'vip' } },
      { type: 'create_task', config: { title: 'VIP {{firstName}}' } },
    ])],
  )).rows[0].id;
  const tagLater = (await sql`INSERT INTO clients (workspace_id, name, email, stage, tags)
    VALUES (${wsId}, 'Tess Tagged', ${`aa-tess-${STAMP}@example.com`}, 'active', '{}') RETURNING *`).rows[0];
  const gone = (await sql`INSERT INTO clients (workspace_id, name, email, stage, tags)
    VALUES (${wsId}, 'Gus Gone', ${`aa-gus-${STAMP}@example.com`}, 'active', '{vip}') RETURNING *`).rows[0];
  await triggerWorkflow({ workspaceId: wsId, triggerType: 'client_created', client: tagLater });
  await triggerWorkflow({ workspaceId: wsId, triggerType: 'client_created', client: gone });
  let pending = (await sql`SELECT * FROM workflow_pending_runs WHERE workflow_id = ${wfWait}`).rows;
  assert(pending.length === 2 && pending.every((p) => (p.client_snapshot?.tags || []).length === (p.client_id === gone.id ? 1 : 0)), 'two runs parked at the wait with their snapshots');
  // During the wait: the owner tags Tess VIP, and deletes Gus.
  await sql`UPDATE clients SET tags = '{VIP}' WHERE id = ${tagLater.id}`;
  await sql`DELETE FROM clients WHERE id = ${gone.id}`;
  await sql`UPDATE workflow_pending_runs SET resume_at = NOW() - INTERVAL '1 minute' WHERE workflow_id = ${wfWait}`;
  const resumed = await resumeWaitingWorkflows({ prune: false });
  assert(resumed.resumed >= 1, `resume pass ran (${resumed.resumed})`);
  const tessRuns = await runsFor(wfWait, tagLater.id);
  const tessTasks = (await sql`SELECT title FROM tasks WHERE client_id = ${tagLater.id}`).rows.map((t) => t.title);
  assert(tessRuns.some((x) => x.status === 'succeeded'), `resumed run passed if_has_tag on the tag added DURING the wait (${tessRuns.map((x) => x.status).join(',')})`);
  assert(tessTasks.includes('VIP Tess'), 'the post-wait action ran for the newly-tagged client');
  pending = (await sql`SELECT * FROM workflow_pending_runs WHERE workflow_id = ${wfWait}`).rows;
  assert(pending.length === 0, 'both pending rows cleared (deleted client dropped, not retried forever)');
  const gusRuns = (await sql`SELECT status FROM workflow_runs WHERE workflow_id = ${wfWait} AND (client_id = ${gone.id} OR client_id IS NULL) AND status <> 'waiting'`).rows;
  assert(gusRuns.length === 0, 'deleted client: nothing ran after the wait');
  assert((await sql`SELECT 1 FROM tasks WHERE title = 'VIP Gus'`).rows.length === 0, 'no task for the deleted client');

  // ── 7. booking_completed: tags + catch-up ─────────────────────────
  console.log('\n[7] booking_completed sees tags and catches up missed days / late completions, once');
  const wfDone = (await sql.query(
    `INSERT INTO workflows (workspace_id, name, trigger_type, trigger_config, actions, enabled, created_at)
     VALUES ($1, 'Thanks 2d after', 'booking_completed', $2::jsonb, $3::jsonb, TRUE, NOW() - INTERVAL '60 days') RETURNING id`,
    [wsId, JSON.stringify({ daysAfter: 2 }), JSON.stringify([
      { type: 'if_has_tag', config: { tag: 'member' } },
      { type: 'create_task', config: { title: 'Thanks {{firstName}}' } },
    ])],
  )).rows[0].id;
  const member = (await sql`INSERT INTO clients (workspace_id, name, email, stage, tags)
    VALUES (${wsId}, 'Max Member', ${`aa-max-${STAMP}@example.com`}, 'active', '{member}') RETURNING *`).rows[0];
  const nonMember = (await sql`INSERT INTO clients (workspace_id, name, email, stage, tags)
    VALUES (${wsId}, 'Nina New', ${`aa-nina-${STAMP}@example.com`}, 'active', '{}') RETURNING *`).rows[0];
  const fiveAgo = await dbDate(5), thirtyAgo = await dbDate(30), twoAgo = await dbDate(2);
  const mkBooking = async (client, log) => (await sql.query(
    `INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, completion_log)
     VALUES ($1,$2,$3,$4,$5,600,660,$6::jsonb) RETURNING id`,
    [wsId, client.id, client.name, client.email, thirtyAgo, JSON.stringify(log)],
  )).rows[0].id;
  const ago = (d) => new Date(Date.now() - d * 86400e3).toISOString();
  // Missed by the exact-day cron: completed 5 days ago (target was 3 days ago).
  const bMissed = await mkBooking(member, { [fiveAgo]: { completedAt: ago(5) } });
  // Late "mark complete": the session was 30 days ago but logged just now.
  const bLate = await mkBooking(member, { [thirtyAgo]: { completedAt: new Date().toISOString() } });
  // Genuinely old: 30 days ago, logged 30 days ago → outside catch-up.
  const bOld = await mkBooking(member, { [thirtyAgo]: { completedAt: ago(30) } });
  // On time, but the client lacks the tag → condition stops it.
  const bNoTag = await mkBooking(nonMember, { [twoAgo]: { completedAt: ago(2) } });
  // Not yet due (completed yesterday).
  const bSoon = await mkBooking(member, { [await dbDate(1)]: { completedAt: ago(1) } });

  await evaluateScheduledWorkflows({});
  const runFor = async (bid) => (await sql`SELECT status, context->>'occurrenceDate' AS occ FROM workflow_runs WHERE workflow_id = ${wfDone} AND context->>'bookingId' = ${bid}`).rows;
  let x = await runFor(bMissed);
  assert(x.length === 1 && x[0].status === 'succeeded' && x[0].occ === fiveAgo, `missed day (completed 5d ago, N=2) fired on catch-up (${JSON.stringify(x)})`);
  x = await runFor(bLate);
  assert(x.length === 1 && x[0].status === 'succeeded', `late mark-complete of a 30d-old session fired (${JSON.stringify(x)})`);
  assert((await runFor(bOld)).length === 0, 'a 30d-old completion logged 30d ago does NOT fire (outside catch-up)');
  x = await runFor(bNoTag);
  assert(x.length === 1 && x[0].status === 'stopped', `client without the tag → run stopped at if_has_tag (tags reached the condition) (${JSON.stringify(x)})`);
  assert((await runFor(bSoon)).length === 0, 'completed yesterday → not yet due');
  const thanks = (await sql`SELECT COUNT(*)::int AS n FROM tasks WHERE client_id = ${member.id} AND title = 'Thanks Max'`).rows[0].n;
  assert(thanks === 2, `two thank-you tasks for the member (got ${thanks})`);

  await evaluateScheduledWorkflows({});
  assert((await runFor(bMissed)).length === 1 && (await runFor(bLate)).length === 1, 'second cron pass: no double-fire');
  assert((await sql`SELECT COUNT(*)::int AS n FROM tasks WHERE client_id = ${member.id} AND title = 'Thanks Max'`).rows[0].n === 2, 'still two tasks');

  // ── 8. send_document really sends ─────────────────────────────────
  console.log('\n[8] "Send a document for signing" sends (signer + token + email); no email → draft + reason');
  const tmpl = (await sql.query(
    `INSERT INTO documents (workspace_id, name, kind, content_html, fields, status, is_template)
     VALUES ($1, 'Client Agreement', 'written', '<p>Terms for {{clientName}}</p>', $2::jsonb, 'draft', TRUE) RETURNING id`,
    [wsId, JSON.stringify([{ id: 'sig1', type: 'signature', label: 'Sign', required: true, page: 0, signerIndex: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.05 }])],
  )).rows[0].id;
  const wfDoc = (await sql.query(
    `INSERT INTO workflows (workspace_id, name, trigger_type, actions, enabled)
     VALUES ($1, 'Agreement on signup', 'client_created', $2::jsonb, TRUE) RETURNING id`,
    [wsId, JSON.stringify([{ type: 'send_document', config: { templateId: tmpl } }])],
  )).rows[0].id;
  await sql`UPDATE workflows SET enabled = FALSE WHERE id = ${wfWait}`;
  const SIGNER = `aa-signer-${STAMP}@example.com`;
  const signer = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wsId}, 'Sam Signer', ${SIGNER}, 'active') RETURNING *`).rows[0];
  await triggerWorkflow({ workspaceId: wsId, triggerType: 'client_created', client: signer });
  let docRun = (await runsFor(wfDoc, signer.id))[0];
  assert(docRun?.status === 'succeeded' && docRun.action_results?.[0]?.status === 'ok' && docRun.action_results[0].documentStatus === 'sent',
    `send_document action ok + documentStatus:'sent' (${JSON.stringify(docRun?.action_results)})`);
  const docId = docRun?.action_results?.[0]?.documentId;
  const doc = (await sql`SELECT * FROM documents WHERE id = ${docId} AND workspace_id = ${wsId}`).rows[0];
  assert(doc?.status === 'sent' && doc.sent_at && doc.sign_token_hash && doc.recipient_email === SIGNER, `document is SENT to the client (status=${doc?.status})`);
  assert(doc?.is_template === false && doc.name === 'Client Agreement - Sam Signer', 'a per-client copy, not the template');
  const signers = (await sql`SELECT * FROM document_signers WHERE document_id = ${docId}`).rows;
  assert(signers.length === 1 && signers[0].status === 'awaiting' && signers[0].client_id === signer.id && signers[0].sign_token_hash, 'one awaiting signer row with a token');
  const signMail = mailsFor(SIGNER, /Action needed: sign/)[0];
  assert(!!signMail && /\/sign\//.test(signMail.html), 'signer got the "Action needed" email with a /sign/ link');
  assert((await sql`SELECT 1 FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE t.client_id = ${signer.id} AND m.kind = 'doc-sent'`).rows.length === 1, 'thread system message dropped, like the Documents UI');
  const tmplRow = (await sql`SELECT status, is_template FROM documents WHERE id = ${tmpl}`).rows[0];
  assert(tmplRow.status === 'draft' && tmplRow.is_template === true, 'template itself untouched');

  const noEmail = (await sql`INSERT INTO clients (workspace_id, name, phone, stage)
    VALUES (${wsId}, 'Phil Phone', '+15555550123', 'active') RETURNING *`).rows[0];
  await triggerWorkflow({ workspaceId: wsId, triggerType: 'client_created', client: noEmail });
  docRun = (await runsFor(wfDoc, noEmail.id))[0];
  const res0 = docRun?.action_results?.[0];
  assert(res0?.status === 'ok' && res0.skipped === 'no-email' && res0.documentStatus === 'draft' && res0.documentId,
    `no email → action records skipped:'no-email' (${JSON.stringify(res0)})`);
  const draft = (await sql`SELECT status FROM documents WHERE id = ${res0?.documentId}`).rows[0];
  assert(draft?.status === 'draft', 'the document is left as a draft for the owner to send');
  assert((await sql`SELECT 1 FROM document_signers WHERE document_id = ${res0?.documentId}`).rows.length === 0, 'no signer row, nothing emailed');

  // ── 9. Reminder email carries prep instructions ───────────────────
  console.log('\n[9] reminder email carries prep instructions');
  const REM = `aa-rem-${STAMP}@example.com`;
  const startMs = Date.now() + 120 * 60 * 1000;
  const startD = new Date(startMs);
  const remDate = iso(startD);
  const remStart = startD.getUTCHours() * 60 + startD.getUTCMinutes();
  await sql.query(
    `INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min)
     VALUES ($1,$2,'Remy Reminded',$3,$4,$5,$6)`,
    [wsId, svcPrep, REM, remDate, remStart, Math.min(1440, remStart + 60)],
  );
  r = mockRes();
  await remindersCron(req({ method: 'GET', query: {}, headers: { authorization: 'Bearer aa-test-cron' } }), r);
  assert(r.statusCode === 200, `reminders cron ran (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 120)})`);
  const remMail = mailsFor(REM, /^Reminder:/)[0];
  assert(!!remMail, 'client got the 2-hour reminder');
  assert(/Before your appointment/.test(remMail?.html || '') && /Bring water/.test(remMail?.html || ''), 'reminder carries the prep instructions');

  // ── cleanup ───────────────────────────────────────────────────────
  await sql`DELETE FROM users WHERE id = ${userId}`; // cascades the workspace
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.error('Fatal:', e.message, e.stack);
  if (userId) await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  process.exit(1);
});

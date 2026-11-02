// Ivy can see photos: several shrunk photo pieces in one message, a camera
// button in the app, and add_bookings_from_list to turn a schedule photo
// into calendar appointments after the owner approves.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/ivy-photos.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { parsePhotoPieces, beginTurn, MAX_PHOTO_PIECES } from '../api/_lib/ivyTurn.js';
import { buildMessages, workspaceContext } from '../api/_lib/ivy.js';
import { executeIvyTool, runApprovedTool, IVY_TOOLS } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const owners = [];
const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

async function mkOwner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ivy-photo-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${w.rows[0].id}, 'Photo Biz', ${`photo-${tag}-${S}`}, 'America/Los_Angeles')`;
  const o = { userId: u.rows[0].id, workspaceId: w.rows[0].id };
  owners.push(o);
  return o;
}

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] photo pieces are validated');
    assert(parsePhotoPieces(undefined) === null && parsePhotoPieces([]) === null, 'none → null');
    assert(parsePhotoPieces('x') instanceof Error, 'not a list → error');
    assert(parsePhotoPieces(Array.from({ length: MAX_PHOTO_PIECES + 1 }, () => ({ mediaType: 'image/jpeg', base64: tinyJpeg }))) instanceof Error, 'too many pieces → error');
    assert(parsePhotoPieces([{ mediaType: 'application/pdf', base64: tinyJpeg }]) instanceof Error, 'non-image → error');
    assert(parsePhotoPieces([{ mediaType: 'image/jpeg', base64: 'not base64!!' }]) instanceof Error, 'malformed data → error');
    const big = 'A'.repeat(Math.ceil((3.3 * 1024 * 1024) / 0.75));
    assert(parsePhotoPieces([{ mediaType: 'image/jpeg', base64: big }]) instanceof Error, 'over the combined size → error');
    const ok = parsePhotoPieces([{ filename: 'a.jpg', mediaType: 'image/jpeg', base64: tinyJpeg }, { mediaType: 'image/png', base64: tinyJpeg }]);
    assert(Array.isArray(ok) && ok.length === 2 && ok[1].filename === 'photo.jpg', 'valid pieces pass through');

    console.log('\n[2] a photo message reaches Ivy as image blocks and is saved without the bytes');
    const A = await mkOwner('a');
    const turn = await beginTurn({ text: '', attachments: [{ mediaType: 'image/jpeg', base64: tinyJpeg }, { mediaType: 'image/jpeg', base64: tinyJpeg }], photoCount: 1 }, A.workspaceId);
    assert(!turn.error && Array.isArray(turn.attachment) && turn.attachment.length === 2, 'turn carries both pieces');
    const saved = (await sql`SELECT text FROM ivy_messages WHERE id = ${turn.userMsg.id}`).rows[0].text;
    assert(saved === '📷 1 photo' && !saved.includes(tinyJpeg), `saved message is a note, not the image (${saved})`);
    const msgs = buildMessages('', { todayLabel: 'Monday, November 2, 2026', timeZone: 'America/Los_Angeles' }, [], turn.attachment);
    const last = msgs[msgs.length - 1];
    assert(Array.isArray(last.content) && last.content.filter((b) => b.type === 'image').length === 2, 'two image blocks');
    const txt = last.content.find((b) => b.type === 'text').text;
    assert(/Today is Monday, November 2, 2026 \(business time zone: America\/Los_Angeles\)/.test(txt), "Ivy is told today's date and time zone");
    assert(/offer to add them to my calendar/.test(txt), 'photo-only message gets the schedule-aware default prompt');
    const one = buildMessages('hi', {}, [], { filename: 'x.png', mediaType: 'image/png', base64: tinyJpeg });
    assert(one[one.length - 1].content.filter((b) => b.type === 'image').length === 1, 'single attachment (older app) still works');
    const ctx = await workspaceContext(A.workspaceId);
    assert(ctx.timeZone === 'America/Los_Angeles' && /2\d{3}/.test(ctx.todayLabel || ''), 'workspace context includes today and the time zone');

    console.log('\n[3] add_bookings_from_list needs approval, then adds appointments');
    assert(IVY_TOOLS.some((t) => t.name === 'add_bookings_from_list'), 'tool is offered to Ivy');
    const existing = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.workspaceId}, 'Jane Doe', ${`jane-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
    const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${A.workspaceId}, 'Color', 90, 120) RETURNING id`).rows[0].id;
    const B = await mkOwner('b');
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${B.workspaceId}, 'Sam Lee', ${`sam-b-${S}@example.com`}, 'active')`;
    const args = { bookings: [
      { client_name: 'Jane Doe', date: '2030-03-05', start_time: '09:00', service_name: 'Color' },
      { client_name: 'Sam Lee', date: '2030-03-05', start_time: '1:30 PM' },
      { client_name: 'No Time', date: '2030-03-05', start_time: 'lunchish' },
      { client_name: '', date: '2030-03-05', start_time: '10:00' },
    ] };
    const gate = await executeIvyTool('add_bookings_from_list', { ...args, confirm: true }, { workspaceId: A.workspaceId, userId: A.userId });
    assert(gate.needs_confirmation === true && typeof gate.pending_id === 'string', 'model call only creates a pending approval');
    assert(/Add 2 appointments/.test(gate.summary) && /Jane Doe \(Color\)/.test(gate.summary) && /Adds 1 new client/.test(gate.summary) && /No emails go to clients/.test(gate.summary), `summary names the appointments (${gate.summary})`);
    const before = (await sql`SELECT COUNT(*)::int n FROM bookings WHERE workspace_id = ${A.workspaceId}`).rows[0].n;
    assert(before === 0, 'nothing added before approval');
    const r = await runApprovedTool('add_bookings_from_list', args, { workspaceId: A.workspaceId, userId: A.userId });
    assert(r.added === 2 && r.problems.length === 2, `adds the readable ones, reports the rest (${r.added}, ${r.problems.length})`);
    const rows = (await sql`SELECT client_id, client_name, client_email, start_min, end_min, service_id, source FROM bookings WHERE workspace_id = ${A.workspaceId} ORDER BY start_min`).rows;
    assert(rows[0].client_id === existing && rows[0].service_id === svc && rows[0].end_min - rows[0].start_min === 90, 'existing client and service matched; service length used');
    const sam = (await sql`SELECT id, email, source FROM clients WHERE workspace_id = ${A.workspaceId} AND name = 'Sam Lee'`).rows;
    assert(sam.length === 1 && sam[0].email === null && sam[0].source === 'import', 'new client created in THIS workspace only, no invented email');
    assert(rows[1].client_id === sam[0].id && rows[1].client_email === '' && rows[1].start_min === 13 * 60 + 30 && rows[1].end_min === rows[1].start_min + 60, '1:30 PM parsed; 60 minutes by default; empty email');
    assert(rows.every((x) => x.source === 'import'), 'bookings marked as imported');
    const again = await runApprovedTool('add_bookings_from_list', args, { workspaceId: A.workspaceId, userId: A.userId });
    assert(again.added === 0 && again.skipped.length === 2, 'running it again adds nothing (duplicates skipped)');
    const bCount = (await sql`SELECT COUNT(*)::int n FROM bookings WHERE workspace_id = ${B.workspaceId}`).rows[0].n;
    assert(bCount === 0, "another workspace's same-named client is untouched");
    assert(Array.isArray(r.missing_email) && r.missing_email.length === 1 && r.missing_email[0].name === 'Sam Lee', 'result lists clients with no email');

    console.log('\n[4] owners are told who needs an email, and adding one reaches upcoming appointments');
    const { executePendingAction } = await import('../api/_lib/ivyApproval.js');
    const args2 = { bookings: [{ client_name: 'Nia Park', date: '2030-03-06', start_time: '11:00' }, { client_name: 'Jane Doe', date: '2030-03-06', start_time: '12:00' }] };
    const gate2 = await executeIvyTool('add_bookings_from_list', args2, { workspaceId: A.workspaceId, userId: A.userId });
    const row2 = (await sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${gate2.pending_id}`).rows[0];
    const done = await executePendingAction({ row: row2, workspaceId: A.workspaceId, userId: A.userId });
    assert(done.claimed && /1 client has no email yet/.test(done.text) && /Nia Park/.test(done.text) && !/Jane Doe\./.test(done.text.split('no email yet')[1] || ''), `Done message names only the client without an email (${done.text.split('\n\n')[1]})`);
    assert(/\[Add their email\]\(\/clients\?filter=missing-email\)/.test(done.text), 'Done message links to the Missing email list');

    const { default: clientById } = await import('../api/clients/[id].js');
    const { signSession } = await import('../api/_lib/auth.js');
    const { default: dashboard } = await import('../api/dashboard.js');
    const cookie = `ivy_session=${signSession(A.userId)}`;
    const mkRes = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader(k, v) { this.headers[k] = v; }, getHeader() {}, end() { return this; } });
    const callH = async (h, { method = 'GET', query = {}, body = {} } = {}) => { const res = mkRes(); await h({ method, url: '/t', query, body, headers: { cookie, origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' } }, res); return res; };
    // A near-term appointment for Sam (no email) so the dashboard counts it.
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${A.workspaceId}, ${sam[0].id}, 'Sam Lee', '', (NOW() AT TIME ZONE 'America/Los_Angeles')::date + 2, 600, 660)`;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${A.workspaceId}, ${sam[0].id}, 'Sam Lee', '', CURRENT_DATE - 30, 600, 660)`;
    let dres = await callH(dashboard);
    assert(dres.statusCode === 200 && dres.body?.missingEmail?.clients >= 1, `dashboard counts this week's clients with no email (${JSON.stringify(dres.body?.missingEmail)})`);
    const pres = await callH(clientById, { method: 'PATCH', query: { id: sam[0].id }, body: { email: `sam-${S}@example.com` } });
    assert(pres.statusCode === 200, `client email saved (${pres.statusCode})`);
    const samBookings = (await sql`SELECT date, client_email FROM bookings WHERE client_id = ${sam[0].id} ORDER BY date`).rows;
    const past = samBookings.filter((x) => new Date(x.date) < new Date(Date.now() - 3 * 86400000));
    const future = samBookings.filter((x) => new Date(x.date) >= new Date(Date.now() - 86400000));
    assert(future.length >= 2 && future.every((x) => x.client_email === `sam-${S}@example.com`), 'upcoming appointments got the new email (reminders will reach them)');
    assert(past.length === 1 && past[0].client_email === '', 'old appointments are left as they were');
    dres = await callH(dashboard);
    assert((dres.body?.missingEmail?.clients || 0) === 0, 'dashboard reminder clears once the email is added');

    let res3; let threw = false;
    try { res3 = await runApprovedTool('add_bookings_from_list', { bookings: [{ client_name: 'X', date: 'tomorrow', start_time: '9' }] }, { workspaceId: A.workspaceId }); } catch { threw = true; }
    assert(threw || /Nothing to add/.test(res3?.error || ''), 'nothing readable → clear error');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    try {
      for (const o of owners) {
        await sql`DELETE FROM workspaces WHERE id = ${o.workspaceId}`;
        await sql`DELETE FROM users WHERE id = ${o.userId}`;
      }
    } catch (e) { console.error('cleanup:', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

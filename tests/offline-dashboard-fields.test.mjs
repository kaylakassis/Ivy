// 1.0.6 "works without signal": the dashboard payload carries what the
// iPhone app saves on the phone - today's rows with address, phone and the
// owner's notes, plus a `tomorrow` list in the same shape - and a booking's
// private note can be set with PATCH (owner only). All additive: the fields
// iPhone 1.0.5 reads are unchanged.
// Run: node --import ./tests/bootstrap.mjs ./tests/offline-dashboard-fields.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
const { default: dashboard } = await import('../api/dashboard.js');
const { default: bookingById } = await import('../api/calendar/bookings/[id].js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const reqFor = (uid, extra = {}) => ({
  method: 'GET', url: '/dashboard',
  headers: { host: 'localhost:3001', origin: 'http://localhost:3001', 'user-agent': 'test/1.0', cookie: `ivy_session=${signSession(uid)}` },
  query: {}, on() {}, ...extra,
});

async function mkWorkspace(tag) {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, onboarded_at) VALUES (${uid}, NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${ws}, 'Biz', ${`off-${tag}`}, 'UTC')`;
  return { uid, ws };
}

const created = [];
try {
  await ensureSchemaApplied();
  const tag = `offline-${Date.now()}`;
  const a = await mkWorkspace(`${tag}-a`); created.push(a);
  const b = await mkWorkspace(`${tag}-b`); created.push(b);
  const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${a.ws}, 'House call', 60, 80) RETURNING id`).rows[0].id;
  const client = (await sql`INSERT INTO clients (workspace_id, name, email, phone, stage) VALUES (${a.ws}, 'Jane Cooper', ${`jane-${tag}@example.com`}, '(555) 010-2000', 'active') RETURNING id`).rows[0].id;
  const todayRow = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, date, start_min, end_min, location_address, notes, private_notes)
    VALUES (${a.ws}, ${svc}, ${client}, 'Jane Cooper', (NOW() AT TIME ZONE 'UTC')::date, 600, 660, '12 Main St', 'Gate code 4411', 'Allergic to latex') RETURNING id`).rows[0].id;
  const tomorrowRow = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, date, start_min, end_min, location_address)
    VALUES (${a.ws}, ${svc}, ${client}, 'Jane Cooper', (NOW() AT TIME ZONE 'UTC')::date + 1, 540, 600, '9 Oak Ave') RETURNING id`).rows[0].id;
  await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, date, start_min, end_min)
    VALUES (${a.ws}, ${svc}, ${client}, 'Jane Cooper', (NOW() AT TIME ZONE 'UTC')::date + 2, 540, 600)`;
  // Another workspace's booking today: never in a's payload.
  await sql`INSERT INTO bookings (workspace_id, client_name, date, start_min, end_min, location_address)
    VALUES (${b.ws}, 'Other Owner Client', (NOW() AT TIME ZONE 'UTC')::date, 600, 660, 'Secret St')`;

  console.log('\n[1] dashboard today/tomorrow carry the offline fields');
  const res = mkRes();
  await dashboard(reqFor(a.uid), res);
  assert(res.statusCode === 200, `dashboard 200 (got ${res.statusCode})`);
  const t = res.body.today;
  assert(Array.isArray(t) && t.length === 1 && t[0].id === todayRow, 'today has exactly today\'s booking');
  assert(t[0].clientName === 'Jane Cooper' && t[0].serviceName === 'House call' && t[0].startMin === 600 && t[0].endMin === 660 && t[0].completed === false && t[0].noShow === false, 'the 1.0.5 fields are unchanged');
  assert(t[0].locationAddress === '12 Main St' && t[0].clientPhone === '(555) 010-2000' && t[0].notes === 'Gate code 4411' && t[0].privateNotes === 'Allergic to latex', 'address, phone, notes and private note are added');
  const tm = res.body.tomorrow;
  assert(Array.isArray(tm) && tm.length === 1 && tm[0].id === tomorrowRow && tm[0].locationAddress === '9 Oak Ave' && tm[0].privateNotes === null, 'tomorrow is the same shape, the day after is not included');
  assert(!JSON.stringify(res.body).includes('Secret St') && !JSON.stringify(res.body).includes('Other Owner Client'), 'another workspace\'s booking never appears');

  console.log('\n[2] private note PATCH (owner only, capped)');
  const patch = async (uid, id, body, helper) => {
    const r = mkRes();
    const req = reqFor(uid, { method: 'PATCH', query: { id }, body });
    if (helper) req.helper = helper;
    await bookingById(req, r);
    return r;
  };
  let r = await patch(a.uid, todayRow, { privateNotes: 'Allergic to latex\nBring the blue cape' });
  assert(r.statusCode === 200 && r.body?.booking?.privateNotes === 'Allergic to latex\nBring the blue cape', `owner can set the private note (got ${r.statusCode})`);
  const row = (await sql`SELECT private_notes, notes FROM bookings WHERE id = ${todayRow}`).rows[0];
  assert(row.private_notes === 'Allergic to latex\nBring the blue cape' && row.notes === 'Gate code 4411', 'stored in private_notes; the client-facing notes are untouched');
  r = await patch(a.uid, todayRow, { privateNotes: 'x'.repeat(5000) });
  assert(r.statusCode === 200 && r.body.booking.privateNotes.length === 4000, 'private note capped at 4000 characters');
  r = await patch(b.uid, todayRow, { privateNotes: 'hijack' });
  assert(r.statusCode === 404, `another owner cannot touch it (got ${r.statusCode})`);
  const after = (await sql`SELECT private_notes FROM bookings WHERE id = ${todayRow}`).rows[0].private_notes;
  assert(after !== 'hijack', 'and nothing changed');
  r = await patch(a.uid, todayRow, { privateNotes: null });
  assert(r.statusCode === 200 && r.body.booking.privateNotes === null, 'null clears it');
} catch (e) {
  fail++; console.log('  ✗ threw', e);
} finally {
  for (const c of created) {
    await sql`DELETE FROM bookings WHERE workspace_id = ${c.ws}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${c.ws}`;
    await sql`DELETE FROM services WHERE workspace_id = ${c.ws}`;
    await sql`DELETE FROM calendar_settings WHERE workspace_id = ${c.ws}`;
    await sql`DELETE FROM workspaces WHERE id = ${c.ws}`;
    await sql`DELETE FROM users WHERE id = ${c.uid}`;
  }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

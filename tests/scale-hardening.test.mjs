// Tests the launch-readiness hardening fixes:
//   [1] the rate limiter never fails open — DB-backed path works, and the
//       in-memory fallback throttles per-instance.
//   [2] bulk client import inserts in batches (not one round trip per row),
//       while still validating, de-duping, and storing text[] tags.
//   [3] the calendar GET bounds its default window instead of returning a
//       tenant's entire booking history.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/scale-hardening.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { memRateLimit, rateLimit } from '../api/_lib/rate-limit.js';
import importHandler from '../api/clients/import.js';
import calendarHandler from '../api/calendar/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    end(s) { this.body = s; return this; },
  };
}
const sameOrigin = { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' };

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] rate limiter never fails open');
  // In-memory fallback (used when the DB is unavailable): allows up to max,
  // then blocks within the window.
  const k = `mem-${Date.now()}`;
  const a = memRateLimit({ key: k, max: 2, windowSeconds: 60 });
  const b = memRateLimit({ key: k, max: 2, windowSeconds: 60 });
  const c = memRateLimit({ key: k, max: 2, windowSeconds: 60 });
  assert(a.allowed && b.allowed && !c.allowed, 'in-memory fallback allows up to max (2), blocks the 3rd');
  // DB-backed path still enforces limits (unique key → count starts at 0).
  const dbk = `db-${Date.now()}`;
  const d1 = await rateLimit({ key: dbk, max: 1, windowSeconds: 3600 });
  const d2 = await rateLimit({ key: dbk, max: 1, windowSeconds: 3600 });
  assert(d1.allowed && !d2.allowed, 'DB-backed limiter allows 1, blocks the 2nd');

  // Shared owner/workspace for [2] and [3].
  const email = `sh-${Date.now()}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const cookie = `thryve_session=${signSession(uid)}`;
  const headers = { ...sameOrigin, cookie };

  console.log('\n[2] bulk client import — batched, validated, de-duped');
  const dup = `dup-${Date.now()}@example.com`;
  await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Existing', ${dup}, 'lead')`;
  const rows = [
    { name: 'Alice', email: `a-${Date.now()}@ex.com`, tags: ['vip', 'new'] },
    { name: 'Bob',   email: `b-${Date.now()}@ex.com` },
    { name: 'Carol' },                          // no email → allowed
    { name: 'DupeAgain', email: dup },          // skipped (already exists)
    { name: '', email: `c-${Date.now()}@ex.com` }, // invalid (no name)
    { name: 'BadEmail', email: 'not-an-email' },    // invalid email
  ];
  const ires = mockRes();
  await importHandler({ method: 'POST', query: {}, body: { rows }, headers }, ires);
  assert(ires.statusCode === 200, `import returns 200 (got ${ires.statusCode}: ${ires.body?.error || ''})`);
  const sum = ires.body?.summary;
  assert(sum?.created === 3, `created 3 (Alice/Bob/Carol) — got ${sum?.created}`);
  assert(sum?.skipped === 1, `skipped 1 duplicate — got ${sum?.skipped}`);
  assert(sum?.invalid === 2, `invalid 2 (no-name + bad-email) — got ${sum?.invalid}`);
  const aliceTags = (await sql`SELECT tags FROM clients WHERE workspace_id = ${wid} AND name = 'Alice'`).rows[0]?.tags;
  assert(Array.isArray(aliceTags) && aliceTags.includes('vip') && aliceTags.includes('new'),
    'Alice tags stored as text[] via the batched insert');
  const total = (await sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${wid}`).rows[0].n;
  assert(total === 4, `workspace has 4 clients (1 existing + 3 created) — got ${total}`);

  console.log('\n[3] calendar GET bounds its default window');
  const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, capacity, price)
    VALUES (${wid}, 'S', 60, 1, 0) RETURNING id`).rows[0].id;
  const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const nearDay = isoIn(10);
  const farDay = isoIn(600); // beyond the 540-day default horizon
  await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min)
            VALUES (${wid}, ${svc}, 'Near', 'n@ex.com', ${nearDay}, 600, 660)`;
  await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min)
            VALUES (${wid}, ${svc}, 'Far', 'f@ex.com', ${farDay}, 600, 660)`;
  const cres = mockRes();
  await calendarHandler({ method: 'GET', query: {}, headers }, cres);
  assert(cres.statusCode === 200, `calendar GET 200 (got ${cres.statusCode})`);
  const days = (cres.body?.calendar?.bookings || []).map((bk) => String(bk.date).slice(0, 10));
  assert(days.includes(nearDay), 'near booking (10 days out) is inside the default window');
  assert(!days.includes(farDay), 'far booking (600 days out) is excluded by the 540-day default window');
  // Explicit range still reaches the far booking (no behavior loss).
  const cres2 = mockRes();
  await calendarHandler({ method: 'GET', query: { from: isoIn(595), to: isoIn(605) }, headers }, cres2);
  const days2 = (cres2.body?.calendar?.bookings || []).map((bk) => String(bk.date).slice(0, 10));
  assert(days2.includes(farDay), 'an explicit date range still returns the far booking');

  // Cleanup.
  await sql`DELETE FROM bookings WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM services WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });

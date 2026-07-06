// The dashboard payload now carries a "Today with Ivy" briefing: the same
// deterministic tap-to-act items (today's sessions / unpaid invoices / quiet
// clients) the Ivy dock shows, so the highest-traffic screen becomes actionable.
// Asserts the items are present + ID-free + carry an Ivy prompt when there's
// signal, and that the field is null (card hidden) when there isn't.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/dashboard-today.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
const { default: dashboard } = await import('../api/dashboard.js');

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
const reqFor = (uid) => ({
  method: 'GET', url: '/dashboard',
  headers: { host: 'localhost:3001', 'user-agent': 'test/1.0', cookie: `ivy_session=${signSession(uid)}` },
  query: {}, on() {},
});

async function mkWorkspace(tag) {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, onboarded_at) VALUES (${uid}, NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${ws}, 'Biz', ${`dt-${tag}`})`;
  return { uid, ws };
}

async function run() {
  const created = [];
  try {
    await ensureSchemaApplied();
    const tag = `dtoday-${Date.now()}`;

    console.log('\n[1] with signal → briefing items are surfaced, tap-to-act, ID-free');
    const a = await mkWorkspace(`${tag}-a`); created.push(a);
    // An unpaid invoice → the "unpaid invoices" briefing item (date-independent).
    await sql`INSERT INTO invoices (workspace_id, number, client_name, items, status)
      VALUES (${a.ws}, 'INV-1', 'C', '[]'::jsonb, 'sent')`;
    const res = mkRes();
    await dashboard(reqFor(a.uid), res);
    assert(res.statusCode === 200, `dashboard 200 (got ${res.statusCode})`);
    const items = res.body?.briefing?.items;
    assert(Array.isArray(items) && items.length >= 1, 'briefing.items present when there is signal');
    const inv = items.find((x) => /invoice/i.test(x.text));
    assert(!!inv, 'includes the unpaid-invoice item');
    assert(typeof inv.prompt === 'string' && inv.prompt.length > 0, 'each item carries an Ivy prompt (tap-to-act)');
    assert(items.every((x) => !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JSON.stringify(x))), 'items leak no raw UUIDs');

    console.log('\n[2] no signal → briefing is null (card hidden)');
    const b = await mkWorkspace(`${tag}-b`); created.push(b); // no invoices/bookings/clients
    const res2 = mkRes();
    await dashboard(reqFor(b.uid), res2);
    assert(res2.statusCode === 200, 'dashboard 200 for a quiet workspace');
    assert(res2.body?.briefing === null, 'briefing is null when there is nothing to surface');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const o of created) {
      await sql`DELETE FROM invoices WHERE workspace_id = ${o.ws}`;
      await sql`DELETE FROM calendar_settings WHERE workspace_id = ${o.ws}`;
      await sql`DELETE FROM workspaces WHERE id = ${o.ws}`;
      await sql`DELETE FROM users WHERE id = ${o.uid}`;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

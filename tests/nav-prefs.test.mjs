// /api/me/nav-prefs (customizable navigation): GET defaults, PATCH stores only
// valid hideable ids (drops always-visible/admin/unknown), replaces on re-PATCH,
// merges into ui_prefs without clobbering other keys, and busts the user cache.
// Plus a pure unit test of visibleNavFor from src/lib/nav.js.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/nav-prefs.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { visibleNavFor, hideableNav, ALWAYS_VISIBLE_NAV } from '../src/lib/nav.js';

const { default: navPrefs } = await import('../api/me/nav-prefs.js');

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
const req = (uid, method, body) => ({
  method, url: '/api/me/nav-prefs',
  headers: { cookie: `ivy_session=${signSession(uid)}` },
  body, // readBody reads req.body when present
});

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[0] unit: visibleNavFor');
    const base = visibleNavFor({ isSuperAdmin: false });
    assert(!base.some((n) => n.id === 'admin'), 'admin hidden for non-super-admin');
    const withHidden = visibleNavFor({ isSuperAdmin: false, hiddenNav: ['workflows', 'reviews'] });
    assert(!withHidden.some((n) => n.id === 'workflows' || n.id === 'reviews'), 'listed ids are hidden');
    assert(base.length - withHidden.length === 2, 'exactly the 2 hidden ids removed');
    const tryHideCore = visibleNavFor({ isSuperAdmin: false, hiddenNav: ['dashboard', 'ivy'] });
    assert(tryHideCore.some((n) => n.id === 'dashboard') && tryHideCore.some((n) => n.id === 'ivy'),
      'dashboard + ivy can never be hidden');
    assert(!hideableNav().some((n) => ALWAYS_VISIBLE_NAV.has(n.id) || n.superAdminOnly),
      'hideableNav excludes always-visible + admin');

    const tag = `nav-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;

    console.log('\n[1] GET defaults to empty');
    let res = mkRes();
    await navPrefs(req(uid, 'GET'), res);
    assert(res.statusCode === 200 && Array.isArray(res.body.hiddenNav) && res.body.hiddenNav.length === 0, 'GET → hiddenNav []');

    console.log('\n[2] PATCH stores only valid hideable ids');
    res = mkRes();
    await navPrefs(req(uid, 'PATCH', { hiddenNav: ['workflows', 'reviews', 'dashboard', 'admin', 'bogus'] }), res);
    assert(res.statusCode === 200, 'PATCH ok');
    assert(JSON.stringify([...res.body.hiddenNav].sort()) === JSON.stringify(['reviews', 'workflows']),
      'dashboard/admin/bogus dropped; workflows+reviews kept');

    console.log('\n[3] GET reflects the write (cache busted)');
    res = mkRes();
    await navPrefs(req(uid, 'GET'), res);
    assert(JSON.stringify([...res.body.hiddenNav].sort()) === JSON.stringify(['reviews', 'workflows']), 'persisted');

    console.log('\n[4] second PATCH replaces');
    res = mkRes();
    await navPrefs(req(uid, 'PATCH', { hiddenNav: ['finance'] }), res);
    assert(JSON.stringify(res.body.hiddenNav) === JSON.stringify(['finance']), 'replaced with [finance]');

    console.log('\n[5] merges into ui_prefs without clobbering other keys');
    await sql`UPDATE users SET ui_prefs = jsonb_set(ui_prefs, '{foo}', '"bar"') WHERE id = ${uid}`;
    res = mkRes();
    await navPrefs(req(uid, 'PATCH', { hiddenNav: ['goals'] }), res);
    const prefs = (await sql`SELECT ui_prefs FROM users WHERE id = ${uid}`).rows[0].ui_prefs;
    assert(prefs.foo === 'bar', 'unrelated ui_prefs key preserved');
    assert(JSON.stringify(prefs.hiddenNav) === JSON.stringify(['goals']), 'hiddenNav updated');

    console.log('\n[6] non-array hiddenNav → 400');
    res = mkRes();
    await navPrefs(req(uid, 'PATCH', { hiddenNav: 'workflows' }), res);
    assert(res.statusCode === 400, 'rejects a non-array');

    await sql`DELETE FROM users WHERE id = ${uid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

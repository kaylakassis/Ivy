// Behavior tests for the email-preferences layer.
//
// Run with:
//   node --import ./.test-bootstrap.mjs ./.test-email-prefs.mjs
//
// Assumes:
//   • Local Postgres is up at $DATABASE_URL (see .test-bootstrap.mjs)
//   • Schema has been applied (the suite re-applies via ensureSchemaApplied()
//     so it's safe to run on a fresh DB)
//
// Each test prints its own ✓ / ✗ line. Final exit code is non-zero if any
// assertion fails.

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import {
  userAllowsEmail, clientAllowsEmail, clientAllowsEmailByAddress,
  EMAIL_NOTIFY_TYPES, CRITICAL_EMAIL_TYPES,
} from '../api/_lib/notificationPrefs.js';
import {
  sendEmailToClient, sendEmailToUser, sendEmailToClientByAddress,
} from '../api/_lib/email.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}
async function expectThrow(fn, label) {
  try { await fn(); fail++; console.log('  ✗', label, '(expected throw)'); }
  catch { pass++; console.log('  ✓', label); }
}

// Test fixtures - created once at the top, torn down at the bottom.
let ownerId, workspaceId, clientId;

async function setup() {
  await ensureSchemaApplied();
  // Fresh data per run - easier than tracking IDs.
  await sql.query(
    "DELETE FROM users WHERE email LIKE 'pref-test-%@example.com'",
  );
  const u = await sql`
    INSERT INTO users (email, password_hash, name)
    VALUES (${'pref-test-owner-' + Date.now() + '@example.com'},
            'fake-hash-only-for-tests', 'Pref Test Owner')
    RETURNING id
  `;
  ownerId = u.rows[0].id;

  const w = await sql`
    INSERT INTO workspaces (owner_id, name)
    VALUES (${ownerId}, 'Pref Test Workspace')
    RETURNING id
  `;
  workspaceId = w.rows[0].id;

  const c = await sql`
    INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${workspaceId}, 'Pref Test Client',
            ${'pref-test-client-' + Date.now() + '@example.com'}, 'active')
    RETURNING id, email
  `;
  clientId = c.rows[0].id;
  return c.rows[0].email;
}

async function teardown() {
  // Cascading delete via workspace → all workspace-scoped rows.
  if (ownerId) await sql`DELETE FROM users WHERE id = ${ownerId}`;
}

// ─── Section 1: pure helpers ───────────────────────────────────────
async function testHelpers(clientEmail) {
  console.log('\n[1] userAllowsEmail / clientAllowsEmail defaults');
  assert(await userAllowsEmail(ownerId, 'bookings'), 'user defaults to true for bookings');
  assert(await userAllowsEmail(ownerId, 'billing'), 'user defaults to true for billing');
  assert(await clientAllowsEmail(clientId, 'bookings'), 'client defaults to true for bookings');

  console.log('\n[2] Critical types always allowed');
  for (const t of CRITICAL_EMAIL_TYPES) {
    // Explicitly mute the user/client - critical should still pass.
    await sql`UPDATE users SET notification_prefs = '{"email_bookings": false}'::jsonb WHERE id = ${ownerId}`;
    await sql`UPDATE clients SET notification_prefs = '{"bookings": false}'::jsonb WHERE id = ${clientId}`;
    assert(await userAllowsEmail(ownerId, t),   `user "${t}" bypasses mute`);
    assert(await clientAllowsEmail(clientId, t), `client "${t}" bypasses mute`);
  }

  console.log('\n[3] Explicit opt-out is honored per type');
  await sql`UPDATE users SET notification_prefs = '{"email_bookings": false, "email_invoices": true}'::jsonb WHERE id = ${ownerId}`;
  await sql`UPDATE clients SET notification_prefs = '{"bookings": false, "marketing": true}'::jsonb WHERE id = ${clientId}`;
  assert(!(await userAllowsEmail(ownerId, 'bookings')),   'user opted out of bookings → false');
  assert(  await userAllowsEmail(ownerId, 'invoices'),    'user explicitly opted in to invoices → true');
  assert(  await userAllowsEmail(ownerId, 'documents'),   'user with no key for documents → default true');
  assert(!(await clientAllowsEmail(clientId, 'bookings')), 'client opted out of bookings → false');
  assert(  await clientAllowsEmail(clientId, 'marketing'), 'client explicitly opted in to marketing → true');
  assert(  await clientAllowsEmail(clientId, 'documents'), 'client with no key for documents → default true');

  console.log('\n[4] clientAllowsEmailByAddress workspace-scoped lookup');
  // Resetting prefs first so the lookup-by-email path is the only filter.
  await sql`UPDATE clients SET notification_prefs = '{"bookings": false}'::jsonb WHERE id = ${clientId}`;
  assert(
    !(await clientAllowsEmailByAddress({ email: clientEmail, workspaceId, type: 'bookings' })),
    'by-address lookup honors opt-out for same workspace',
  );
  // Wrong workspace → no record → default allow.
  assert(
    await clientAllowsEmailByAddress({ email: clientEmail, workspaceId: '00000000-0000-0000-0000-000000000000', type: 'bookings' }),
    'by-address lookup against wrong workspace → default allow',
  );
  // Missing email is treated as allow (no record).
  assert(
    await clientAllowsEmailByAddress({ email: 'nobody@nowhere.local', workspaceId, type: 'bookings' }),
    'by-address lookup with unknown email → default allow',
  );

  console.log('\n[5] EMAIL_NOTIFY_TYPES is non-empty + matches expected');
  // 'reports' was added for the weekly business-owner recap. Keep this
  // list in lockstep with EMAIL_NOTIFY_TYPES in api/_lib/notificationPrefs.js.
  const expected = ['bookings', 'invoices', 'documents', 'messages', 'marketing', 'billing', 'reports'];
  assert(EMAIL_NOTIFY_TYPES.length === expected.length, 'EMAIL_NOTIFY_TYPES length matches');
  for (const t of expected) {
    assert(EMAIL_NOTIFY_TYPES.includes(t), `EMAIL_NOTIFY_TYPES includes "${t}"`);
  }
}

// ─── Section 6: sendEmailTo* return values ─────────────────────────
async function testSendWrappers(clientEmail) {
  console.log('\n[6] sendEmailToClient honors prefs (mute returns { sent: false, reason: muted })');
  await sql`UPDATE clients SET notification_prefs = '{"bookings": false}'::jsonb WHERE id = ${clientId}`;
  const muted = await sendEmailToClient({
    clientId, type: 'bookings',
    to: clientEmail, subject: 'should-be-muted', html: '<p>x</p>',
  });
  assert(muted.ok === true && muted.sent === false && muted.reason === 'muted',
    'opted-out client → { ok:true, sent:false, reason:muted }');

  console.log('\n[7] sendEmailToUser honors prefs');
  await sql`UPDATE users SET notification_prefs = '{"email_billing": false}'::jsonb WHERE id = ${ownerId}`;
  const mutedOwner = await sendEmailToUser({
    userId: ownerId, type: 'billing',
    to: 'noop@example.com', subject: 'should-be-muted', html: '<p>x</p>',
  });
  assert(mutedOwner.ok === true && mutedOwner.sent === false && mutedOwner.reason === 'muted',
    'opted-out owner billing → { ok:true, sent:false, reason:muted }');

  console.log('\n[8] sendEmailToClientByAddress honors prefs');
  await sql`UPDATE clients SET notification_prefs = '{"marketing": false}'::jsonb WHERE id = ${clientId}`;
  const mutedByAddr = await sendEmailToClientByAddress({
    workspaceId, email: clientEmail, type: 'marketing',
    subject: 'should-be-muted', html: '<p>x</p>',
  });
  assert(mutedByAddr.ok === true && mutedByAddr.sent === false,
    'opted-out client (by email) marketing → muted');

  console.log('\n[9] Critical bypass: empty type sends regardless');
  // Reset prefs so 'bookings' is allowed, then send with no type - should
  // attempt Resend (and fail because we have a fake key, but the path
  // gets through the prefs gate).
  await sql`UPDATE users SET notification_prefs = '{}'::jsonb WHERE id = ${ownerId}`;
  const result = await sendEmailToUser({
    userId: ownerId, type: undefined,
    to: 'noop@example.com', subject: 'critical-no-type', html: '<p>x</p>',
  });
  // RESEND_API_KEY is '__test__' so Resend will reject; sent=false but
  // reason should NOT be 'muted' - it should be a Resend-shaped error.
  assert(result.sent === false && result.reason !== 'muted',
    'no-type send hits transport (reason ≠ muted)');
}

// ─── Section 10: serialization + visibility-on-portal ──────────────
async function testRedaction(clientEmail) {
  console.log('\n[10] /me/bookings server-side redaction when visibleToClient=false');
  // Insert a service + a past booking with a completion entry marked hidden.
  const svc = await sql`
    INSERT INTO services (workspace_id, name, duration_minutes, price)
    VALUES (${workspaceId}, '60-min', 60, 100)
    RETURNING id
  `;
  const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const completionLog = {
    [yesterday]: {
      completedAt: new Date().toISOString(),
      notes: 'SECRET-PHI-DATA',
      attachments: [],
      visibleToClient: false,
    },
  };
  const bk = await sql`
    INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email,
                          date, start_min, end_min, completion_log)
    VALUES (${workspaceId}, ${svc.rows[0].id}, ${clientId},
            'Pref Test Client', ${clientEmail},
            ${yesterday}::date, 600, 660, ${JSON.stringify(completionLog)}::jsonb)
    RETURNING id
  `;

  // Link client to a user so the /me/bookings query finds them.
  const clientUser = await sql`
    INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${clientEmail}, 'fake', 'Client User', NOW())
    RETURNING id
  `;
  await sql`UPDATE clients SET user_id = ${clientUser.rows[0].id} WHERE id = ${clientId}`;

  // Invoke /api/me/bookings with a synthetic req object.
  const { default: handler } = await import('../api/me/bookings.js');
  // Forge a session cookie so requireUser accepts. signSession is
  // the JWT-minting helper used by the real auth flow.
  const { signSession } = await import('../api/_lib/auth.js');
  const sessionToken = signSession(clientUser.rows[0].id);
  const cookieHeader = `ivy_session=${sessionToken}`;

  const req = {
    method: 'GET', url: '/me/bookings',
    headers: {
      origin: 'http://localhost:3001', host: 'localhost:3001',
      'user-agent': 'test/1.0', cookie: cookieHeader,
    },
    query: {}, on() {},
  };
  const res = makeRes();
  await handler(req, res);
  assert(res.statusCode === 200, '/me/bookings returns 200');
  const past = res.body?.past || [];
  assert(past.length >= 1, '/me/bookings returns at least one past booking');
  const item = past[0];
  assert(item.completionNotes === null, 'hidden completion → completionNotes is null (not the PHI text)');
  assert(Array.isArray(item.completionAttachments) && item.completionAttachments.length === 0,
    'hidden completion → attachments is []');

  // Now flip to visible and re-fetch.
  const visibleLog = { ...completionLog, [yesterday]: { ...completionLog[yesterday], visibleToClient: true } };
  await sql`UPDATE bookings SET completion_log = ${JSON.stringify(visibleLog)}::jsonb WHERE id = ${bk.rows[0].id}`;
  const res2 = makeRes();
  await handler({ ...req, headers: { ...req.headers } }, res2);
  const item2 = (res2.body?.past || [])[0];
  assert(item2?.completionNotes === 'SECRET-PHI-DATA', 'visible completion → notes are surfaced');
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(code, hdrs) {
      this.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
    },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}

async function main() {
  console.log('=== Email-preferences behavior tests ===');
  try {
    const clientEmail = await setup();
    await testHelpers(clientEmail);
    await testSendWrappers(clientEmail);
    await testRedaction(clientEmail);
  } finally {
    await teardown();
  }
  console.log('\n────────────────────────────');
  console.log(`Pass: ${pass}  Fail: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });

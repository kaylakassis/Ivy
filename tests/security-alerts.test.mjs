// Security alerts: the new-device sign-in tracker + the password/2FA
// notifiers. The email send itself is best-effort (and blocked by the
// Resend sandbox in tests), so we assert the observable LOGIC: the
// per-user device-fingerprint set, which decides when an alert fires.
//
//   • First tracked sign-in seeds a baseline (1 fp, no storm).
//   • Same device again is a no-op.
//   • A new device is recorded (this is the path that emails an alert).
//   • The fingerprint list is capped.
//   • password/2FA notifiers run without throwing.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/security-alerts.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { CRITICAL_EMAIL_TYPES } from '../api/_lib/notificationPrefs.js';
import {
  maybeNotifyNewSignIn, notifyPasswordChanged, notifyTwoFactorChanged,
} from '../api/_lib/securityNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL = `sec-${Date.now()}@example.com`;
let userId;
const fps = async () => {
  const r = await sql`SELECT known_login_fingerprints AS f FROM users WHERE id = ${userId}`;
  const v = r.rows[0]?.f;
  return Array.isArray(v) ? v : [];
};

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    userId = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${EMAIL}, 'x', 'Sec Tester', NOW()) RETURNING id`).rows[0].id;

    console.log('\n[0] security_alert is a critical (non-opt-out) email type');
    assert(CRITICAL_EMAIL_TYPES.has('security_alert'), 'security_alert bypasses opt-out');

    console.log('\n[1] first sign-in seeds a silent baseline (no alert storm)');
    await maybeNotifyNewSignIn({ userId, ip: '203.0.113.1', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120' });
    let list = await fps();
    assert(list.length === 1, 'one fingerprint recorded on the first sign-in');
    const baseline = list[0];

    console.log('\n[2] same device again is a no-op');
    await maybeNotifyNewSignIn({ userId, ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120' });
    list = await fps();
    assert(list.length === 1, 'still one fingerprint (recognized device)');
    assert(list[0] === baseline, 'same fingerprint value');

    console.log('\n[3] a new device is recorded (the path that emails an alert)');
    await maybeNotifyNewSignIn({ userId, ip: '198.51.100.7', userAgent: 'Mozilla/5.0 (iPhone) Safari/17' });
    list = await fps();
    assert(list.length === 2, 'new device appended');
    assert(list.includes(baseline), 'original device still tracked');

    console.log('\n[4] the fingerprint list is capped at 20');
    for (let i = 0; i < 25; i++) {
      // eslint-disable-next-line no-await-in-loop
      await maybeNotifyNewSignIn({ userId, ip: '10.0.0.1', userAgent: `UA-variant-${i}` });
    }
    list = await fps();
    assert(list.length <= 20, `capped (got ${list.length})`);

    console.log('\n[5] password / 2FA notifiers run without throwing');
    let threw = false;
    try {
      await notifyPasswordChanged({ userId, ip: '203.0.113.1', userAgent: 'Chrome' });
      await notifyTwoFactorChanged({ userId, enabled: true, ip: '203.0.113.1', userAgent: 'Chrome' });
      await notifyTwoFactorChanged({ userId, enabled: false, ip: '203.0.113.1', userAgent: 'Chrome' });
    } catch { threw = true; }
    assert(!threw, 'notifiers are best-effort (never throw)');

    console.log('\n[6] a null userId is handled gracefully');
    threw = false;
    try { await maybeNotifyNewSignIn({ userId: null, userAgent: 'x' }); } catch { threw = true; }
    assert(!threw, 'no-op on missing userId');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await sql`DELETE FROM users WHERE email = ${EMAIL}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();

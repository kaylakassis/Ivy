// Tests the daily-return cron: two timezone-aware beats (morning briefing +
// evening streak-at-risk) fire only at the owner's local target hour, only when
// there's signal, dedupe once per beat per day, and honor the new opt-out-able
// `engagement` push type.
//
// Deterministic local-hour control: we pick a DST-free Etc/GMT±N zone computed
// so the CURRENT utc hour maps to the beat's target local hour. Push is exercised
// with generated VAPID keys but the subscriptions carry dummy keys, so the send
// fails fast at encryption (no network) while the bell-feed `notifications` row
// — written before the push fanout — is what we assert on.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/daily-return.test.mjs

import webpush from 'web-push';
// Configure VAPID BEFORE importing push.js (configure() memoizes on first use).
const _keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = _keys.publicKey;
process.env.VAPID_PRIVATE_KEY = _keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { sendPushToUser } from '../api/_lib/push.js';
const { default: dailyReturn } = await import('../api/cron/daily-return.js');

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
const cronReq = () => ({ method: 'POST', url: '/api/cron/daily-return', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

// A DST-free zone whose local hour == targetHour right now.
function zoneForLocalHour(targetHour) {
  const utcH = new Date().getUTCHours();
  let o = ((targetHour - utcH) % 24 + 24) % 24; // UTC+o gives the target hour
  if (o > 14) o -= 24;                            // keep within Etc/GMT range
  if (o === 0) return 'UTC';
  return o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`;
}

// Eligible, push-subscribed owner in a given timezone.
async function mkOwner(tag, { tz, prefs = null } = {}) {
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at, notification_prefs)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW(), ${prefs ? JSON.stringify(prefs) : '{}'}::jsonb)
    RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, onboarded_at)
    VALUES (${uid}, 'active', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${ws}, 'Biz', ${`dr-${tag}`}, ${tz})`;
  // Dummy-key subscription so the cron selects the workspace but the actual
  // send fails fast at encryption (no network) — the bell row is what matters.
  await sql`INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
    VALUES (${uid}, ${`https://example.com/${tag}`}, 'ZHVtbXk', 'ZHVtbXk')`;
  return { uid, ws };
}
const feedRow = async (uid, tag) =>
  (await sql`SELECT type, url, body FROM notifications WHERE user_id = ${uid} AND tag = ${tag} ORDER BY created_at DESC LIMIT 1`).rows[0] || null;
const briefingStamp = async (ws) =>
  (await sql`SELECT briefing_push_last_sent_at FROM workspaces WHERE id = ${ws}`).rows[0].briefing_push_last_sent_at;
const streakStamp = async (ws) =>
  (await sql`SELECT streak_push_last_sent_at FROM workspaces WHERE id = ${ws}`).rows[0].streak_push_last_sent_at;

async function run() {
  const created = [];
  try {
    await ensureSchemaApplied();
    const tag = `dr-${Date.now()}`;
    const track = (o) => { created.push(o); return o; };

    console.log('\n[1] auth gate');
    const noAuth = mkRes();
    await dailyReturn({ method: 'POST', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no cron secret → 401 (got ${noAuth.statusCode})`);

    console.log('\n[2] morning fires at local 8am with a non-empty briefing');
    const m = track(await mkOwner(`${tag}-m`, { tz: zoneForLocalHour(8) }));
    // Non-empty briefing: one unpaid invoice → the "unpaid invoices" item.
    await sql`INSERT INTO invoices (workspace_id, number, client_name, items, status)
      VALUES (${m.ws}, 'INV-1', 'C', '[]'::jsonb, 'sent')`;
    await dailyReturn(cronReq(), mkRes());
    assert(await briefingStamp(m.ws) !== null, 'morning stamp set');
    const mr = await feedRow(m.uid, 'daily-briefing');
    assert(mr && mr.type === 'engagement', 'a briefing bell row with type=engagement');
    assert(mr && /^\/ivy\?prompt=/.test(mr.url), `briefing deep-links into Ivy (got ${mr?.url})`);

    console.log('\n[3] wrong local hour → skipped');
    const w = track(await mkOwner(`${tag}-w`, { tz: zoneForLocalHour(9) })); // 9am, not 8
    await sql`INSERT INTO invoices (workspace_id, number, client_name, items, status)
      VALUES (${w.ws}, 'INV-1', 'C', '[]'::jsonb, 'sent')`;
    await dailyReturn(cronReq(), mkRes());
    assert(await briefingStamp(w.ws) === null, 'no morning stamp at the wrong hour');
    assert(await feedRow(w.uid, 'daily-briefing') === null, 'no briefing notification at the wrong hour');

    console.log('\n[4] morning skipped when the briefing is empty');
    const e = track(await mkOwner(`${tag}-e`, { tz: zoneForLocalHour(8) })); // 8am but no invoices/bookings/clients
    await dailyReturn(cronReq(), mkRes());
    assert(await briefingStamp(e.ws) === null, 'empty briefing → not stamped');
    assert(await feedRow(e.uid, 'daily-briefing') === null, 'empty briefing → no notification');

    console.log('\n[5] evening streak-at-risk fires for a savable streak');
    const s = track(await mkOwner(`${tag}-s`, { tz: zoneForLocalHour(19) }));
    // streak of 3, last active YESTERDAY in their tz → savable.
    await sql`UPDATE workspaces
                SET streak_days = 3,
                    streak_last_day = ((NOW() AT TIME ZONE ${zoneForLocalHour(19)})::date - 1)
              WHERE id = ${s.ws}`;
    await dailyReturn(cronReq(), mkRes());
    assert(await streakStamp(s.ws) !== null, 'evening stamp set');
    const sr = await feedRow(s.uid, 'streak-risk');
    assert(sr && sr.type === 'engagement' && sr.url === '/dashboard', 'streak bell row → /dashboard');
    assert(sr && /3-day streak/.test(sr.body), `body names the streak length (got ${sr?.body})`);

    console.log('\n[6] evening skipped when already advanced today');
    const t = track(await mkOwner(`${tag}-t`, { tz: zoneForLocalHour(19) }));
    await sql`UPDATE workspaces SET streak_days = 5,
                streak_last_day = ((NOW() AT TIME ZONE ${zoneForLocalHour(19)})::date)
              WHERE id = ${t.ws}`;
    await dailyReturn(cronReq(), mkRes());
    assert(await streakStamp(t.ws) === null, 'already-advanced streak is not nudged');

    console.log('\n[7] evening skipped when streak too small');
    const u = track(await mkOwner(`${tag}-u`, { tz: zoneForLocalHour(19) }));
    await sql`UPDATE workspaces SET streak_days = 1,
                streak_last_day = ((NOW() AT TIME ZONE ${zoneForLocalHour(19)})::date - 1)
              WHERE id = ${u.ws}`;
    await dailyReturn(cronReq(), mkRes());
    assert(await streakStamp(u.ws) === null, 'a 1-day streak is below the >=2 threshold');

    console.log('\n[8] dedupe: a second run the same hour does not re-fire');
    const before = await briefingStamp(m.ws);
    await dailyReturn(cronReq(), mkRes());
    assert(String(await briefingStamp(m.ws)) === String(before), 'morning stamp unchanged on a second run');

    console.log('\n[9] opt-out of engagement suppresses the push (muted)');
    const o = track(await mkOwner(`${tag}-o`, { tz: 'UTC', prefs: { engagement: false } }));
    const r = await sendPushToUser({ userId: o.uid, type: 'engagement', payload: { title: 'x', body: 'y' } });
    assert(r && r.sent === 0 && r.reason === 'muted', `engagement opt-out returns muted (got ${JSON.stringify(r)})`);

    console.log('\n[10] cron returns a structured summary');
    const res = mkRes();
    await dailyReturn(cronReq(), res);
    assert(res.statusCode === 200 && res.body && typeof res.body.morningSent === 'number', 'ok with counts');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const o of created) {
      await sql`DELETE FROM notifications WHERE user_id = ${o.uid}`;
      await sql`DELETE FROM push_subscriptions WHERE user_id = ${o.uid}`;
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

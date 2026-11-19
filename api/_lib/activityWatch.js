// Unusual-activity watch: notices an account (or a visitor) pulling far more
// out of Ivy than normal use explains, tells the operator, and slows it down.
//
// WHAT IS COUNTED
//   Signed-in accounts: "different pages of data read". Every GET that
//   passes requireUser counts once, unless the same account asked for the
//   same address in the last minute. That one rule removes the app's own
//   background refreshes (the bell, the inbox, an open conversation) with
//   no list of endpoints to keep up to date, while a script walking through
//   pages or records is counted in full, because every address is new.
//   Visitors with no account: "different businesses' public pages opened",
//   by network address. A real visitor opens one or two; something building
//   a list of Ivy's customers opens hundreds.
//
// WHAT HAPPENS
//   Past the first line: a flag in Admin > Risk and one email to the
//   operator. Nothing changes for the account.
//   Past the second line: the same, and the account is slowed for an hour:
//   NEW reads are held to a human pace (SLOW_PER_MINUTE). Saving, booking,
//   charging and messaging are never touched (only GET is counted or
//   slowed), and screens it already has open keep refreshing. A visitor is
//   held to a few NEW businesses a minute; pages already opened keep working.
//
// SAFETY
//   - The lines are several times what the busiest real use can produce (see
//     LIMITS), so an honest owner never meets this.
//   - It fails open: any error here lets the request through.
//   - Operators (super admins) and "view as" sessions are never counted.
//   - The operator can lift a slow-down and mark an account trusted.
//
// COST
//   Counts are kept in memory and written in batches: at most one small
//   write per account every FLUSH_MS (or every FLUSH_AFTER new reads), and
//   that same statement brings back the totals. No extra read per request.
import { createHmac } from 'node:crypto';
import { sql } from './db.js';
import { rateLimit, getClientIp } from './rate-limit.js';
import { keepAlive } from './keepAlive.js';

// A busy owner with two devices open reads a few hundred different pages
// in an hour. The app's own refreshes are not counted at all, and even if
// they were (every refresh landing on a different server), an open
// conversation plus the inbox, Home and the bell come to about 1,200 an
// hour per screen.
export const LIMITS = {
  readsFlagHour: 2500,
  readsFlagDay: 10000,
  readsSlowHour: 5000,
  readsSlowDay: 20000,
  readsSlowPerMinute: 30,
  // Different businesses' public pages from one network address. Shared
  // addresses (an office, a phone network) are why these are high.
  visitsFlagHour: 80,
  visitsSlowHour: 250,
  visitsSlowPerMinute: 5,
};
const active = { ...LIMITS };
export const SLOW_MINUTES = 60;
export const TRUST_DAYS = 30;
const REPEAT_MS = 60 * 1000;
const FLUSH_MS = 15 * 1000;
const FLUSH_AFTER = 40;
const MAX_SUBJECTS = 5000;
const MAX_SEEN = 400;

export const SLOW_CODE = 'activity-slowdown';
export const SLOW_MESSAGE = 'This account is loading far more than usual, so Ivy has slowed it down for a little while. It lifts on its own within the hour. If this is a mistake, email hello@joinivy.ai and we will sort it out.';
export const SLOW_VISITOR_MESSAGE = 'Too many pages opened from this network in a short time. Please try again in a few minutes.';

// Search engines read many businesses' pages on purpose (that is how the
// owners get found), so they are neither flagged nor slowed. This goes by
// what the visitor says it is; something pretending to be one is not
// caught by this watch.
const SEARCH_ENGINE = /googlebot|bingbot|applebot|duckduckbot|yandexbot|slurp|baiduspider|google-inspectiontool|adsbot-google|facebookexternalhit|twitterbot|linkedinbot|slackbot|pinterest|whatsapp|telegrambot|discordbot|gptbot|oai-searchbot|chatgpt-user|perplexitybot|ccbot/i;

const state = new Map();   // subject -> entry
const settling = new Set();

function entryFor(subject) {
  let e = state.get(subject);
  if (e) { state.delete(subject); state.set(subject, e); return e; }   // keep recently used last
  e = { seen: new Map(), pending: 0, lastFlush: Date.now(), flushing: false, hour: 0, day: 0, slowUntil: 0, trustedUntil: 0, level: null, meta: null };
  state.set(subject, e);
  if (state.size > MAX_SUBJECTS) state.delete(state.keys().next().value);
  return e;
}

// True the first time this subject asks for `key` in REPEAT_MS.
function isNew(e, key, now) {
  const last = e.seen.get(key);
  e.seen.delete(key);
  e.seen.set(key, now);
  if (e.seen.size > MAX_SEEN) e.seen.delete(e.seen.keys().next().value);
  return !(last && now - last < REPEAT_MS);
}

export function ipSubject(ip) {
  const secret = process.env.JWT_SECRET || 'ivy-activity-watch';
  return `ip:${createHmac('sha256', secret).update(String(ip || 'unknown')).digest('hex').slice(0, 24)}`;
}

// The operator, by account type or by the allow-listed sign-in email (the
// same two ways api/_lib/admin.js recognises one).
function isOperator(user) {
  if (user?.user_type === 'super_admin') return true;
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return false;
  return String(process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().split(/[,;\s]+/).filter(Boolean).includes(email);
}
const viewingAs = (req) => /(?:^|;\s*)ivy_admin_session=/.test(String(req?.headers?.cookie || ''));

// ── Signed-in accounts ───────────────────────────────────────────────
// Called by requireUser for every signed-in request. Returns
// { limited: true, retryAfterSeconds } when this read should be refused.
export async function watchRead(req, user) {
  try {
    if (!user?.id || String(req?.method || 'GET').toUpperCase() !== 'GET') return { limited: false };
    if (isOperator(user) || viewingAs(req)) return { limited: false };
    const subject = `u:${user.id}`;
    const e = entryFor(subject);
    const now = Date.now();
    if (!isNew(e, String(req.url || ''), now)) return { limited: false };
    e.meta = { userId: user.id, kind: 'reads' };
    return await count(subject, e, now, { perMinute: active.readsSlowPerMinute });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[activity] watch skipped:', err.message);
    return { limited: false };
  }
}

// ── Visitors with no account ─────────────────────────────────────────
// Called by the public page endpoints with the business being opened.
export async function watchVisit(req, business) {
  try {
    const biz = String(business || '').trim().toLowerCase();
    if (!biz) return { limited: false };
    if (SEARCH_ENGINE.test(String(req?.headers?.['user-agent'] || ''))) return { limited: false };
    const ip = getClientIp(req);
    if (!ip || ip === 'unknown') return { limited: false };
    const subject = ipSubject(ip);
    const e = entryFor(subject);
    const now = Date.now();
    // A business this address already opened this hour is never new.
    const last = e.seen.get(biz);
    if (last && now - last < 3600e3) return { limited: false };
    e.seen.delete(biz); e.seen.set(biz, now);
    if (e.seen.size > MAX_SEEN) e.seen.delete(e.seen.keys().next().value);
    e.meta = { userId: null, kind: 'visits', ip };
    return await count(subject, e, now, { perMinute: active.visitsSlowPerMinute });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[activity] visit watch skipped:', err.message);
    return { limited: false };
  }
}

// Answer a slowed request. Returns true when it sent the response.
export function refuseIfSlowed(res, verdict, { visitor = false } = {}) {
  if (!verdict?.limited) return false;
  const wait = Math.max(5, Number(verdict.retryAfterSeconds) || 60);
  res.setHeader?.('Retry-After', String(wait));
  res.status(429).json({ error: visitor ? SLOW_VISITOR_MESSAGE : SLOW_MESSAGE, code: SLOW_CODE, retryAfterSeconds: wait });
  return true;
}

// One call for a public page endpoint: count the visit and, if this network
// is being slowed, answer for the caller. `business` is the workspace id
// when the page exists, or the name that was asked for when it does not
// (walking through made-up names is exactly what this should notice).
// Returns true when it sent the response.
export async function guardVisit(req, res, business, { html = false } = {}) {
  const verdict = await watchVisit(req, business);
  if (!verdict.limited) return false;
  if (!html) return refuseIfSlowed(res, verdict, { visitor: true });
  res.statusCode = 429;
  res.setHeader('Retry-After', '60');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(SLOW_VISITOR_MESSAGE);
  return true;
}
export const missKey = (name) => `?${String(name || '').toLowerCase().slice(0, 80)}`;

async function count(subject, e, now, { perMinute }) {
  // Already slowed: hold NEW reads to a human pace. Not added to the count,
  // so being slowed cannot itself keep an account over the line.
  if (e.slowUntil > now && !(e.trustedUntil > now)) {
    const r = await rateLimit({ key: `slow:${subject}`, max: perMinute, windowSeconds: 60 });
    if (!r.allowed) return { limited: true, retryAfterSeconds: 60 };
  }
  e.pending += 1;
  if (!e.flushing && (e.pending >= FLUSH_AFTER || now - e.lastFlush >= FLUSH_MS)) {
    const p = flush(subject, e).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[activity] count not saved:', err.message);
    }).finally(() => { settling.delete(p); });
    settling.add(p);
    keepAlive(p);
  }
  return { limited: false };
}

async function flush(subject, e) {
  const n = e.pending;
  if (n <= 0) return;
  e.flushing = true;
  e.pending = 0;
  e.lastFlush = Date.now();
  try {
    const { rows } = await sql`
      WITH up AS (
        INSERT INTO activity_reads (subject, bucket, n)
        VALUES (${subject}, date_trunc('hour', NOW()), ${n}::int)
        ON CONFLICT (subject, bucket) DO UPDATE SET n = activity_reads.n + EXCLUDED.n
        RETURNING n
      )
      SELECT (SELECT n FROM up)::int AS hour_n,
             ((SELECT COALESCE(SUM(n), 0) FROM activity_reads
                WHERE subject = ${subject} AND bucket > NOW() - INTERVAL '24 hours'
                  AND bucket < date_trunc('hour', NOW())) + (SELECT n FROM up))::int AS day_n,
             (SELECT MAX(slow_until) FROM activity_flags WHERE subject = ${subject} AND slow_until > NOW()) AS slow_until,
             (SELECT until FROM activity_trust WHERE subject = ${subject} AND until > NOW()) AS trusted_until`;
    const r = rows[0] || {};
    e.hour = Number(r.hour_n) || 0;
    e.day = Number(r.day_n) || 0;
    e.slowUntil = r.slow_until ? new Date(r.slow_until).getTime() : 0;
    e.trustedUntil = r.trusted_until ? new Date(r.trusted_until).getTime() : 0;
    await judge(subject, e);
  } catch (err) {
    e.pending += n;   // keep the count for the next try
    throw err;
  } finally {
    e.flushing = false;
  }
}

function levelOf(e) {
  const visits = e.meta?.kind === 'visits';
  if (visits) {
    if (e.hour >= active.visitsSlowHour) return 'slow';
    if (e.hour >= active.visitsFlagHour) return 'flag';
    return null;
  }
  if (e.hour >= active.readsSlowHour || e.day >= active.readsSlowDay) return 'slow';
  if (e.hour >= active.readsFlagHour || e.day >= active.readsFlagDay) return 'flag';
  return null;
}

// Raise or update today's flag. Runs only when a count was just saved and
// the subject is over a line, so almost never.
async function judge(subject, e) {
  const level = levelOf(e);
  if (!level) return;
  if (e.trustedUntil > Date.now()) return;
  const kind = e.meta?.kind || 'reads';
  const wantSlow = level === 'slow';
  const existing = (await sql`
    SELECT id, slow_until, slowed_at FROM activity_flags
     WHERE subject = ${subject} AND kind = ${kind} AND flag_day = (NOW() AT TIME ZONE 'UTC')::date`).rows[0];
  const slowedNow = wantSlow && !(existing?.slow_until && new Date(existing.slow_until).getTime() > Date.now());
  const detail = kind === 'visits' ? { ip: e.meta?.ip || null } : {};
  if (!existing) {
    const ins = await sql`
      INSERT INTO activity_flags (subject, user_id, kind, flag_day, peak_hour, day_total, detail, slow_until, slowed_at)
      VALUES (${subject}, ${e.meta?.userId || null}, ${kind}, (NOW() AT TIME ZONE 'UTC')::date, ${e.hour}, ${e.day},
              ${JSON.stringify(detail)}::jsonb,
              ${wantSlow ? new Date(Date.now() + SLOW_MINUTES * 60e3).toISOString() : null},
              ${wantSlow ? new Date().toISOString() : null})
      ON CONFLICT (subject, kind, flag_day) DO NOTHING
      RETURNING id`;
    if (ins.rows[0]) keepAlive(notifyOperator({ subject, kind, e, slowed: wantSlow }).catch(() => {}));
  } else {
    await sql`
      UPDATE activity_flags
         SET peak_hour = GREATEST(peak_hour, ${e.hour}), day_total = GREATEST(day_total, ${e.day}), last_at = NOW(),
             slow_until = CASE WHEN ${slowedNow} THEN NOW() + (${SLOW_MINUTES}::int * INTERVAL '1 minute') ELSE slow_until END,
             slowed_at = CASE WHEN ${slowedNow} THEN NOW() ELSE slowed_at END,
             reviewed_at = CASE WHEN ${slowedNow} AND slowed_at IS NULL THEN NULL ELSE reviewed_at END
       WHERE id = ${existing.id}`;
    // Going from "flagged" to "slowed" is worth a second email.
    if (slowedNow && !existing.slowed_at) keepAlive(notifyOperator({ subject, kind, e, slowed: true }).catch(() => {}));
  }
  if (slowedNow) e.slowUntil = Date.now() + SLOW_MINUTES * 60e3;
}

// What a flag means, in plain words (Admin and the email use the same).
export function describeFlag({ kind, peakHour, dayTotal }) {
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  if (kind === 'visits') {
    return `Opened the public pages of about ${n(peakHour)} different businesses in one hour. A real visitor opens one or two.`;
  }
  const overHour = Number(peakHour) >= LIMITS.readsFlagHour;
  return overHour
    ? `Read about ${n(peakHour)} different pages of data in one hour (${n(dayTotal)} in the last day). A busy account reads a few hundred.`
    : `Read about ${n(dayTotal)} different pages of data in a day. A busy account reads a few hundred an hour at most.`;
}

async function notifyOperator({ subject, kind, e, slowed }) {
  const [{ opsAlertRecipient }, { sendEmail, emailShell }, { appUrl }] = await Promise.all([
    import('./opsAlerts.js'), import('./email.js'), import('./tokens.js'),
  ]);
  const to = opsAlertRecipient();
  if (!to) return;
  let who = 'A visitor with no account';
  if (e.meta?.userId) {
    const u = (await sql`SELECT email, name FROM users WHERE id = ${e.meta.userId}`).rows[0];
    who = u ? `${u.name || 'An account'} (${u.email})` : 'An account';
  } else if (e.meta?.ip) {
    who = `A visitor with no account (network address ${e.meta.ip})`;
  }
  const what = describeFlag({ kind, peakHour: e.hour, dayTotal: e.day });
  const action = slowed
    ? `Ivy has slowed ${e.meta?.userId ? 'this account' : 'this visitor'} down for ${SLOW_MINUTES} minutes. Saving, booking and payments are not affected.`
    : 'Nothing has been changed for them. This is a heads-up.';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = emailShell({
    title: slowed ? 'Unusual activity: slowed down' : 'Unusual activity',
    body: `<p><strong>${esc(who)}</strong></p><p>${esc(what)}</p><p>${esc(action)}</p>
           <p><a href="${appUrl('/admin')}">Open Admin, then Risk</a> to look at it, lift the slow-down, or mark the account as trusted.</p>`,
  });
  await sendEmail({ to, subject: slowed ? 'Ivy: unusual activity, account slowed down' : 'Ivy: unusual activity noticed', html });
  void subject;
}

// ── Admin ────────────────────────────────────────────────────────────
export async function listActivityFlags({ days = 14, limit = 100 } = {}) {
  const { rows } = await sql`
    SELECT f.id, f.subject, f.user_id, f.kind, f.flag_day, f.peak_hour, f.day_total, f.detail,
           f.slow_until, f.slowed_at, f.first_at, f.last_at, f.reviewed_at, f.reviewed_by,
           u.email, u.name, u.signup_role, u.created_at AS user_created_at,
           w.id AS workspace_id, COALESCE(cs.biz_name, w.name) AS business_name,
           t.until AS trusted_until
      FROM activity_flags f
      LEFT JOIN users u ON u.id = f.user_id
      LEFT JOIN LATERAL (SELECT id, name FROM workspaces WHERE owner_id = f.user_id ORDER BY created_at ASC LIMIT 1) w ON TRUE
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN activity_trust t ON t.subject = f.subject AND t.until > NOW()
     WHERE f.first_at > NOW() - (${Math.max(1, Math.min(60, Number(days) || 14))}::int * INTERVAL '1 day')
       AND (f.reviewed_at IS NULL OR f.slow_until > NOW())
     ORDER BY (f.slow_until > NOW()) DESC NULLS LAST, f.last_at DESC
     LIMIT ${Math.max(1, Math.min(300, Number(limit) || 100))}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    userId: r.user_id || null,
    who: r.user_id ? (r.name || r.email || 'An account') : 'A visitor with no account',
    email: r.email || null,
    accountKind: r.user_id ? (r.workspace_id ? 'Business' : r.signup_role === 'client' ? 'Client' : 'Account') : 'Visitor',
    businessName: r.business_name || null,
    workspaceId: r.workspace_id || null,
    networkAddress: r.kind === 'visits' ? (r.detail?.ip || null) : null,
    accountCreatedAt: r.user_created_at || null,
    what: describeFlag({ kind: r.kind, peakHour: r.peak_hour, dayTotal: r.day_total }),
    peakHour: r.peak_hour,
    dayTotal: r.day_total,
    firstAt: r.first_at,
    lastAt: r.last_at,
    slowed: !!(r.slow_until && new Date(r.slow_until).getTime() > Date.now()),
    slowUntil: r.slow_until || null,
    everSlowed: !!r.slowed_at,
    trustedUntil: r.trusted_until || null,
    reviewedAt: r.reviewed_at || null,
  }));
}

// "Looks fine": hide the flag. With trust, also lift any slow-down and
// stop watching this account for TRUST_DAYS.
export async function reviewActivityFlag({ id, by, trust = false, lift = false }) {
  const f = (await sql`SELECT id, subject FROM activity_flags WHERE id = ${id}`).rows[0];
  if (!f) return { ok: false };
  if (trust) {
    await sql`
      INSERT INTO activity_trust (subject, until, by_email)
      VALUES (${f.subject}, NOW() + (${TRUST_DAYS}::int * INTERVAL '1 day'), ${by || null})
      ON CONFLICT (subject) DO UPDATE SET until = EXCLUDED.until, by_email = EXCLUDED.by_email, created_at = NOW()`;
  }
  if (trust || lift) {
    await sql`UPDATE activity_flags SET slow_until = NULL WHERE subject = ${f.subject} AND slow_until > NOW()`;
    await sql`DELETE FROM rate_limits WHERE key = ${`slow:${f.subject}`}`.catch(() => {});
    const e = state.get(f.subject);
    if (e) { e.slowUntil = 0; if (trust) e.trustedUntil = Date.now() + TRUST_DAYS * 86400e3; }
  }
  await sql`UPDATE activity_flags SET reviewed_at = NOW(), reviewed_by = ${by || null} WHERE subject = ${f.subject} AND reviewed_at IS NULL`;
  return { ok: true, subject: f.subject };
}

export async function untrust({ subject }) {
  await sql`DELETE FROM activity_trust WHERE subject = ${subject}`;
  const e = state.get(subject);
  if (e) e.trustedUntil = 0;
}

// ── Tests ────────────────────────────────────────────────────────────
export function _setLimitsForTests(overrides) { Object.assign(active, LIMITS, overrides || {}); }
export function _resetForTests() { state.clear(); Object.assign(active, LIMITS); }
// Save every pending count now and wait for it (tests; also safe in jobs).
export async function _settleForTests() {
  for (const [subject, e] of state) {
    if (e.pending > 0 && !e.flushing) await flush(subject, e).catch(() => {});
  }
  await Promise.all([...settling]);
}

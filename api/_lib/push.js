// Web Push wrapper. Sits on top of the `web-push` library to hide:
//   • VAPID configuration (single global key pair from env)
//   • Per-user subscription lookup
//   • Stale-subscription cleanup (404 / 410 → delete the row)
//
// Required env (otherwise sends silently no-op):
//   VAPID_PUBLIC_KEY    base64url-encoded P-256 public key
//   VAPID_PRIVATE_KEY   base64url-encoded P-256 private key
//   VAPID_SUBJECT       mailto: or https: contact URL — used by push
//                       providers to reach a human on issues
//
// Generate a key pair with:
//   node -e "console.log(require('web-push').generateVAPIDKeys())"
import webpush from 'web-push';
import { sql } from './db.js';

let _configured = null;

function configure() {
  if (_configured !== null) return _configured;
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT;
  if (!pub || !priv) {
    _configured = false;
    return false;
  }
  webpush.setVapidDetails(subj || 'mailto:support@getthryve.ai', pub, priv);
  _configured = true;
  return true;
}

export function isPushConfigured() {
  return configure();
}

export function publicVapidKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Notification types — keep in sync with the toggle list in the
// /account → Notifications card and /api/me/notifications. Each
// sendPushToUser call passes one of these so the user's per-type
// opt-out is honored.
export const NOTIFY_TYPES = ['messages', 'bookings', 'documents', 'payments', 'support'];

// Returns true if the user hasn't opted out of `type`. Missing key →
// enabled by default. Failure to look up → enabled (don't drop a
// notification because of a transient DB blip).
async function userAllowsType(userId, type) {
  if (!type) return true;
  if (!NOTIFY_TYPES.includes(type)) return true;
  try {
    const { rows } = await sql`SELECT notification_prefs FROM users WHERE id = ${userId}`;
    const prefs = rows[0]?.notification_prefs || {};
    return prefs[type] !== false;
  } catch {
    return true;
  }
}

// Send a notification to every subscription for `userId`. Each
// notification is best-effort; a 404 / 410 from the push provider
// means the subscription is dead and we delete it. Other errors log
// but don't fail the caller.
//
// `type` (optional but strongly recommended) gates the send on the
// user's notification_prefs. Pass one of NOTIFY_TYPES — calls that
// don't pass a type send unconditionally (admin-side, system-critical).
//
// `payload`:
//   { title, body, url?, tag?, icon?, data? }
//   url   → where the user lands when they click
//   tag   → coalesces multiple notifications into one
//   data  → arbitrary JSON the SW can read
// Resolve the workspace owner's user id (the only push target on the
// owner side — staff/team isn't a thing yet).
export async function ownerUserIdForWorkspace(workspaceId) {
  if (!workspaceId) return null;
  const { rows } = await sql`SELECT owner_id FROM workspaces WHERE id = ${workspaceId}`;
  return rows[0]?.owner_id || null;
}

// Resolve the user id sitting behind a clients row, if the client has
// claimed their portal account. Returns null when the client never
// signed up — push isn't possible without a registered user.
export async function clientUserId(clientId) {
  if (!clientId) return null;
  const { rows } = await sql`SELECT user_id FROM clients WHERE id = ${clientId}`;
  return rows[0]?.user_id || null;
}

// Convenience: notify a workspace owner. Resolves owner → user → push.
export async function notifyOwner({ workspaceId, payload, type }) {
  const userId = await ownerUserIdForWorkspace(workspaceId);
  if (!userId) return { ok: false, reason: 'no owner', sent: 0 };
  return sendPushToUser({ userId, payload, type });
}

// Convenience: notify the user behind a clients row (if claimed).
export async function notifyClient({ clientId, payload, type }) {
  const userId = await clientUserId(clientId);
  if (!userId) return { ok: false, reason: 'unclaimed', sent: 0 };
  return sendPushToUser({ userId, payload, type });
}

// Fire-and-forget wrapper. Swallows everything so callers never have to
// guard with try/catch — push failures must never break the primary
// action (sending a message, marking an invoice paid, etc.).
export function notifyOwnerSafe(args)  { return notifyOwner(args).catch((e) => console.warn('[push] notifyOwner', e.message)); }
export function notifyClientSafe(args) { return notifyClient(args).catch((e) => console.warn('[push] notifyClient', e.message)); }

export async function sendPushToUser({ userId, payload, type }) {
  if (!configure()) return { ok: false, reason: 'not configured', sent: 0 };
  if (!userId || !payload?.title) return { ok: false, reason: 'bad args', sent: 0 };

  // Honor the user's per-type opt-out before any DB / network work.
  if (type && !(await userAllowsType(userId, type))) {
    return { ok: true, sent: 0, reason: 'muted' };
  }

  const { rows } = await sql`
    SELECT id, endpoint, p256dh_key, auth_key
    FROM push_subscriptions WHERE user_id = ${userId}
  `;
  if (rows.length === 0) return { ok: true, sent: 0 };

  const body = JSON.stringify(payload);

  // Fan out to every subscription in parallel rather than serial-
  // awaiting one at a time. A user with 5 devices used to wait for
  // 5 sequential webpush round-trips (each ~150-400ms to the push
  // service); now they go together. Web Push providers tolerate
  // parallel requests fine — we're well under the 100/sec/origin
  // soft limits at any plausible per-user fanout.
  const results = await Promise.allSettled(rows.map((r) =>
    webpush.sendNotification(
      { endpoint: r.endpoint, keys: { p256dh: r.p256dh_key, auth: r.auth_key } },
      body,
      { TTL: 60 * 60 * 24 },
    ).then(() => ({ kind: 'sent', id: r.id }))
     .catch((err) => {
       const status = err?.statusCode;
       if (status === 404 || status === 410) return { kind: 'expired', id: r.id };
       // eslint-disable-next-line no-console
       console.warn('[push] send failed:', status, err.message);
       return { kind: 'error', id: r.id };
     }),
  ));

  // Collect IDs for two batched DB writes instead of N serial ones.
  const sentIds    = [];
  const expiredIds = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.kind === 'sent')    sentIds.push(r.value.id);
    if (r.value.kind === 'expired') expiredIds.push(r.value.id);
  }

  if (sentIds.length > 0) {
    await sql.query(
      `UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = ANY($1::uuid[])`,
      [sentIds],
    );
  }
  if (expiredIds.length > 0) {
    await sql.query(
      `DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`,
      [expiredIds],
    );
  }
  return { ok: true, sent: sentIds.length, removed: expiredIds.length };
}

// /api/calendar/feed-token
//   GET    → return current feed URL (or null if none generated yet)
//   POST   → generate or regenerate. Body unused — the act of POSTing
//            rolls the token, which invalidates any previously-shared URL.
//   DELETE → revoke (clears the token; existing subscribers start 404'ing).
//
// We store the SHA-256 of the token. The raw value only ever exists in
// memory long enough to return it from this endpoint (and on regenerate
// is freshly issued). If the DB row leaks the URL is unrecoverable —
// that's the point of hashing.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function generateRawToken() {
  // 32 bytes hex = 64 chars. Long enough that brute-forcing is hopeless.
  return crypto.randomBytes(32).toString('hex');
}

function urlFor(rawToken) {
  return `${appUrl()}/api/calendar/feed/${rawToken}`;
}

// Some calendar apps (Apple Cal, Google Cal subscribe-by-URL) accept
// webcal:// — same content, just signals "subscribe, don't open in
// browser". We surface both so the UI can offer the right one per app.
function webcalFor(rawToken) {
  return urlFor(rawToken).replace(/^https?:\/\//, 'webcal://');
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT ical_feed_token_hash, ical_feed_token_created_at
        FROM calendar_settings WHERE workspace_id = ${workspaceId}
      `;
      const has = !!rows[0]?.ical_feed_token_hash;
      // We can't return the URL once the token is hashed — owner must
      // regenerate to get a fresh URL if they lost the old one.
      return ok(res, {
        enabled: has,
        createdAt: rows[0]?.ical_feed_token_created_at || null,
      });
    }

    if (req.method === 'POST') {
      const raw = generateRawToken();
      const hash = hashToken(raw);
      // Upsert to handle workspaces with no calendar_settings row yet.
      await sql`
        INSERT INTO calendar_settings (workspace_id, ical_feed_token_hash, ical_feed_token_created_at)
        VALUES (${workspaceId}, ${hash}, NOW())
        ON CONFLICT (workspace_id) DO UPDATE SET
          ical_feed_token_hash       = EXCLUDED.ical_feed_token_hash,
          ical_feed_token_created_at = EXCLUDED.ical_feed_token_created_at
      `;
      return ok(res, {
        enabled: true,
        createdAt: new Date().toISOString(),
        // Raw token is returned ONCE — UI shows the URL with a Copy
        // button; on refresh the user only sees "feed enabled" state.
        url:        urlFor(raw),
        webcalUrl:  webcalFor(raw),
      });
    }

    if (req.method === 'DELETE') {
      await sql`
        UPDATE calendar_settings SET
          ical_feed_token_hash       = NULL,
          ical_feed_token_created_at = NULL
        WHERE workspace_id = ${workspaceId}
      `;
      return ok(res, { enabled: false });
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

// The owner's switch for automatic review requests.
//
// A few hours after a visit the owner marks complete, Ivy emails the client
// "How was it?" with a link to leave a review (api/cron/review-requests.js).
// That used to run for every business with no way to turn it off. It is on
// unless the owner switches it off (workspaces.review_requests_off_at holds
// when they did); switching it back on takes effect for visits from then on,
// within the job's own window.
import { sql } from './db.js';

export const REVIEW_REQUEST_LABEL = 'Ask for a review after a visit';

export async function readReviewRequests(workspaceId) {
  const [w, asked] = await Promise.all([
    sql`SELECT review_requests_off_at FROM workspaces WHERE id = ${workspaceId}`,
    sql`SELECT COUNT(*)::int AS n FROM bookings
         WHERE workspace_id = ${workspaceId} AND review_requested_at > NOW() - INTERVAL '30 days'`.catch(() => ({ rows: [{ n: 0 }] })),
  ]);
  const offAt = w.rows[0]?.review_requests_off_at || null;
  return { enabled: !offAt, turnedOffAt: offAt, askedLast30Days: asked.rows[0]?.n || 0 };
}

// Returns { enabled, changed }.
export async function setReviewRequests(workspaceId, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
  const before = await readReviewRequests(workspaceId);
  if (before.enabled === enabled) return { enabled, changed: false };
  if (enabled) await sql`UPDATE workspaces SET review_requests_off_at = NULL WHERE id = ${workspaceId}`;
  else await sql`UPDATE workspaces SET review_requests_off_at = NOW() WHERE id = ${workspaceId}`;
  return { enabled, changed: true };
}

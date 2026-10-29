// "Loving Ivy?" check-in for owners on the iPhone app.
//
// Once a week a push asks how Ivy is going. Tapping it opens a small card
// in the app (src/components/ReviewPrompt.jsx):
//   • "Yes, I love it" → ask for a 5-star review, which opens Apple's own
//     rating window (SKStoreReviewController) with an App Store link as a
//     fallback.
//   • "Not really"     → offer support, with a quiet link to review anyway
//     so unhappy users are never blocked from the App Store (no review
//     gating, which Apple and the FTC treat as misleading).
// Every step can be closed. Nobody is asked again soon after answering:
//   yes → not for 120 days (Apple shows its rating window at most 3 times
//          a year anyway); no → not for 30 days; ignored → weekly, then
//          monthly after 4 ignored asks in a row.
import { sql } from './db.js';
import { isWorkspaceActive } from './clientPortal.js';
import { sendPushToUser } from './push.js';

export const APP_STORE_ID = '6808542331';
export const WRITE_REVIEW_URL = `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`;
export const MIN_ACCOUNT_AGE_DAYS = 7;
export const ACTIVE_WITHIN_DAYS = 14;
export const WEEKLY_DAYS = 7;
export const BACKOFF_AFTER_UNANSWERED = 4;
export const BACKOFF_DAYS = 30;
export const AFTER_YES_DAYS = 120;
export const AFTER_NO_DAYS = 30;
export const VALID_ANSWERS = new Set(['yes', 'no', 'dismissed']);
export const VALID_ACTIONS = new Set(['review_requested', 'app_store_opened', 'support_opened', 'closed']);

export const PUSH_PAYLOAD = {
  title: 'Loving Ivy?',
  body: 'Got a second? Tell us how Ivy is working for you.',
  url: '/?ivy_feedback=1',
  tag: 'ivy-feedback',
};

// Owners due an ask right now. Workspace activity is re-checked in JS with
// the same predicate the paywall uses.
export async function dueForReviewPrompt({ limit = 500 } = {}) {
  const { rows } = await sql.query(`
    SELECT u.id AS user_id, w.id AS workspace_id, w.subscription_status, w.trial_ends_at,
           w.subscription_period_end, w.comp_until
      FROM users u
      JOIN workspaces w ON w.owner_id = u.id
     WHERE u.deleted_at IS NULL
       AND w.onboarded_at IS NOT NULL
       AND u.created_at < NOW() - ($1::int || ' days')::interval
       AND GREATEST(u.last_active_at, u.last_login_at) > NOW() - ($2::int || ' days')::interval
       AND EXISTS (SELECT 1 FROM push_device_tokens t WHERE t.user_id = u.id AND t.platform = 'ios')
       AND (u.review_prompt_sent_at IS NULL OR u.review_prompt_sent_at < NOW() - (
             CASE WHEN u.review_prompt_unanswered >= $3::int THEN $4::int ELSE $5::int END || ' days')::interval)
       -- COALESCE: a never-answered owner (NULL answer) must count as "not yes".
       AND NOT COALESCE(u.review_prompt_answer = 'yes' AND u.review_prompt_answered_at > NOW() - ($6::int || ' days')::interval, FALSE)
       AND NOT COALESCE(u.review_prompt_answer = 'no'  AND u.review_prompt_answered_at > NOW() - ($7::int || ' days')::interval, FALSE)
     ORDER BY u.review_prompt_sent_at NULLS FIRST
     LIMIT $8`,
    [MIN_ACCOUNT_AGE_DAYS, ACTIVE_WITHIN_DAYS, BACKOFF_AFTER_UNANSWERED, BACKOFF_DAYS, WEEKLY_DAYS, AFTER_YES_DAYS, AFTER_NO_DAYS, limit]);
  return rows.filter((r) => isWorkspaceActive(r));
}

// Stamp-first so overlapping runs never double-ask; then push (category
// 'engagement', so owners who turned those off are skipped by sendPushToUser).
export async function sendReviewPrompts() {
  const due = await dueForReviewPrompt();
  let sent = 0;
  for (const r of due) {
    const upd = await sql`
      UPDATE users SET review_prompt_sent_at = NOW(),
                       review_prompt_unanswered = review_prompt_unanswered + 1
       WHERE id = ${r.user_id}
         AND (review_prompt_sent_at IS NULL OR review_prompt_sent_at < NOW() - INTERVAL '1 day')
       RETURNING id`;
    if (upd.rows.length === 0) continue;
    await sendPushToUser({ userId: r.user_id, type: 'engagement', payload: PUSH_PAYLOAD }).catch(() => {});
    sent++;
  }
  return { due: due.length, sent };
}

// Record what the owner did on the card.
export async function recordReviewPromptAnswer({ userId, answer, action = null }) {
  if (answer && !VALID_ANSWERS.has(answer)) throw new Error('invalid answer');
  if (action && !VALID_ACTIONS.has(action)) throw new Error('invalid action');
  if (answer === 'yes' || answer === 'no') {
    await sql`
      UPDATE users SET review_prompt_answer = ${answer}, review_prompt_answered_at = NOW(),
                       review_prompt_unanswered = 0,
                       review_prompt_last_action = COALESCE(${action}, review_prompt_last_action)
       WHERE id = ${userId}`;
  } else if (action) {
    await sql`UPDATE users SET review_prompt_last_action = ${action} WHERE id = ${userId}`;
  }
  return { ok: true };
}

// "Finish signing up" reminders: up to three short emails to a business
// owner who created an account but never started a trial or a plan.
//
//   step 1  ~3 hours after sign-up    "Looks like you didn't finish signing up"
//   step 2  ~24 hours after sign-up   "Your Ivy account is still waiting for you"
//   step 3  ~3 days after sign-up     "Still thinking about Ivy?"
//
// Who: owners (they have a workspace) only. Never clients or helpers (no
// workspace), testers, beta / sponsored / super-admin accounts, comped
// workspaces (and anyone with a complimentary invite on file, claimed or
// not: they never see the paywall), deleted accounts, or anyone whose workspace has a plan, a
// trial, a past plan, or a trial claim (including a trial used by the same
// email on an earlier account). Email verified or not.
//
// Stops as soon as they start a trial or subscribe (they no longer match),
// delete their account, or turn the reminders off (the 'signup_reminders'
// email category: Account > Notifications, the unsubscribe link, or
// "unsubscribe from all").
//
// Never more than one per person in 23 hours, never the same step twice:
// each send is claimed by bumping users.signup_reminder_step under a guard
// that re-checks everything, so two overlapping runs cannot both send.
// Also never on the same day as the setup nudge (api/cron/setup-nudge.js),
// which in turn skips anyone who had one of these in the last day.
//
// These are service emails covered by the required "account and service
// emails" box at sign-up, so marketing consent is not needed. They go out
// through sendEmailToUser with their own optional category, which gives
// them the List-Unsubscribe header and one-click unsubscribe.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { TRIAL_DAYS } from './billing.js';

export const SIGNUP_REMINDER_TYPE = 'signup_reminders';
export const SIGNUP_REMINDER_STEPS = 3;
// Hours after sign-up each step becomes due (index = step about to send - 1).
export const STEP_DUE_HOURS = [3, 24, 72];
// Minimum gap between two reminders to the same person.
export const MIN_GAP_HOURS = 23;
// Only recent sign-ups are reminded; older accounts are left alone (and
// accounts that existed before this feature are never swept up).
export const WINDOW_DAYS = 10;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Where "Finish setting up" goes: the onboarding questions when they are
// not done, otherwise the app root, which shows the plan and trial screen
// to an owner without a plan.
export function finishUrl({ onboarded }) {
  return `${appUrl()}${onboarded ? '/' : '/onboarding'}`;
}

// The three emails. Pure: the admin preview renders the same output.
export function renderSignupReminder({ step, firstName, onboarded = false }) {
  const fn = escapeHtml(firstNameOf(firstName) || 'there');
  const cta = { ctaText: 'Finish setting up', ctaUrl: finishUrl({ onboarded }) };
  // The unsubscribe link sits right under this (added by sendEmailToUser).
  // Settings are not mentioned: an owner without a plan sees the plan
  // screen first, so the link is the one place they can always reach.
  const footer = "You're getting this because you started creating an Ivy account. "
    + "Don't want these reminders? Use the unsubscribe link below.";
  if (step === 1) {
    const next = onboarded
      ? `<p>Your workspace is set up. The last step is starting your ${TRIAL_DAYS}-day free trial, and then you're in.</p>`
      : '<p>Answer a few quick questions about your business and your workspace is ready to go. It only takes a few minutes.</p>';
    return {
      subject: "Looks like you didn't finish signing up",
      preheader: 'Your spot is saved. Pick up right where you left off.',
      html: emailShell({
        heading: "You're almost there",
        preheader: 'Your spot is saved. Pick up right where you left off.',
        body: `<p>Hi ${fn},</p>
          <p>Looks like you started signing up for Ivy and didn't finish. No problem, we saved your spot.</p>
          ${next}`,
        ...cta, footer,
      }),
    };
  }
  if (step === 2) {
    return {
      subject: 'Your Ivy account is still waiting for you',
      preheader: 'Everything is saved just the way you left it.',
      html: emailShell({
        heading: 'Pick up where you left off',
        preheader: 'Everything is saved just the way you left it.',
        body: `<p>Hi ${fn},</p>
          <p>Your Ivy account is saved, just the way you left it.</p>
          <p>Once you finish, your booking page, clients, invoices and Ivy, your assistant, are all together in one place.</p>
          <p>If something got in the way or you have a question, just reply to this email and we'll help.</p>`,
        ...cta, footer,
      }),
    };
  }
  return {
    subject: 'Still thinking about Ivy?',
    preheader: 'This is the last reminder we will send.',
    html: emailShell({
      heading: 'One last nudge from us',
      preheader: 'This is the last reminder we will send.',
      body: `<p>Hi ${fn},</p>
        <p>This is the last reminder we'll send about finishing your sign-up. We don't want to crowd your inbox.</p>
        <p>Your account is still saved if you'd like to come back. It only takes a few minutes to finish.</p>
        <p>If Ivy isn't the right fit right now, no hard feelings. If you have a moment, reply and tell us why. It really helps.</p>`,
      ...cta, footer,
    }),
  };
}

// Same normalisation as trialEmailKey() in billingGuard.js (and the
// billing_trial_claims backfill): a trial used by this address on an
// earlier, deleted account still counts.
const EMAIL_HASH_SQL = `encode(sha256(convert_to(
  regexp_replace(LOWER(TRIM(u.email)), '[+]deleted-[0-9a-f-]+@', '@'), 'UTF8')), 'hex')`;

// Everything that makes user `u` someone we may remind right now,
// whatever the step. Used both to find candidates and inside the claim,
// so a change between the two (trial started, account deleted, reminders
// turned off) stops the send.
export const ELIGIBLE_SQL = `
      u.deleted_at IS NULL
  AND u.email IS NOT NULL
  AND u.created_at > NOW() - INTERVAL '${WINDOW_DAYS} days'
  AND COALESCE(u.user_type, 'regular') NOT IN ('beta', 'sponsored', 'super_admin')
  AND NOT COALESCE(u.is_tester, FALSE)
  AND COALESCE(u.notification_prefs->>'email_${SIGNUP_REMINDER_TYPE}', 'true') <> 'false'
  AND EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
  AND NOT EXISTS (
    SELECT 1 FROM workspaces w
     WHERE w.owner_id = u.id
       AND (w.subscription_status IN ('active', 'trialing', 'past_due', 'suspended')
            OR w.stripe_subscription_id IS NOT NULL
            OR w.apple_original_transaction_id IS NOT NULL
            OR w.trial_started_at IS NOT NULL
            OR w.trial_ends_at IS NOT NULL
            OR w.converted_at IS NOT NULL
            OR w.comp_until IS NOT NULL
            OR w.setup_nudge_sent_at > NOW() - INTERVAL '24 hours'
            OR EXISTS (SELECT 1 FROM billing_trial_claims c WHERE c.workspace_id = w.id)))
  AND NOT EXISTS (SELECT 1 FROM billing_trial_claims c WHERE c.email_hash = ${EMAIL_HASH_SQL})
  AND NOT EXISTS (SELECT 1 FROM comp_invites ci WHERE LOWER(ci.email) = LOWER(u.email))`;

// The next step is due: not all three sent, old enough for it, and the
// last one was at least MIN_GAP_HOURS ago.
export const DUE_SQL = `
      u.signup_reminder_step < ${SIGNUP_REMINDER_STEPS}
  AND u.created_at <= NOW() - (CASE u.signup_reminder_step
        WHEN 0 THEN ${STEP_DUE_HOURS[0]} WHEN 1 THEN ${STEP_DUE_HOURS[1]} ELSE ${STEP_DUE_HOURS[2]} END) * INTERVAL '1 hour'
  AND (u.signup_reminder_last_sent_at IS NULL
       OR u.signup_reminder_last_sent_at <= NOW() - INTERVAL '${MIN_GAP_HOURS} hours')`;

export async function findDueReminders({ limit, shardFilter = '' }) {
  const { rows } = await sql.query(
    `SELECT u.id, u.email, u.name, u.signup_reminder_step AS step,
            u.signup_reminder_last_sent_at AS last_sent_at,
            (SELECT w.onboarded_at FROM workspaces w WHERE w.owner_id = u.id
              ORDER BY w.created_at ASC, w.id ASC LIMIT 1) AS onboarded_at
       FROM users u
      WHERE ${DUE_SQL}
        AND ${ELIGIBLE_SQL}
        ${shardFilter}
      ORDER BY u.created_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

// Claim step `fromStep + 1` for one person. Returns the claimed step, or
// null when another run got there first or they no longer qualify.
export async function claimReminder(userId, fromStep) {
  const { rows } = await sql.query(
    `UPDATE users u
        SET signup_reminder_step = u.signup_reminder_step + 1,
            signup_reminder_last_sent_at = NOW()
      WHERE u.id = $1 AND u.signup_reminder_step = $2
        AND ${DUE_SQL}
        AND ${ELIGIBLE_SQL}
      RETURNING u.signup_reminder_step AS step`,
    [userId, fromStep],
  );
  return rows[0]?.step ?? null;
}

// Give a claimed step back when the email provider refused the send, so
// the next run retries it. Only undoes our own claim.
async function releaseReminder(userId, claimedStep, prevSentAt) {
  await sql`
    UPDATE users
       SET signup_reminder_step = ${claimedStep - 1},
           signup_reminder_last_sent_at = ${prevSentAt ? new Date(prevSentAt).toISOString() : null}
     WHERE id = ${userId} AND signup_reminder_step = ${claimedStep}
  `.catch(() => {});
}

// Send one person's next reminder. Returns 'sent' | 'muted' | 'skipped' | 'failed'.
export async function sendNextReminder(row) {
  const step = await claimReminder(row.id, row.step);
  if (!step) return 'skipped';
  const r = renderSignupReminder({ step, firstName: row.name, onboarded: !!row.onboarded_at });
  const result = await sendEmailToUser({
    userId: row.id, type: SIGNUP_REMINDER_TYPE, to: row.email, subject: r.subject, html: r.html,
  }).catch((e) => ({ ok: false, sent: false, reason: e?.message }));
  if (result?.sent) return 'sent';
  if (result?.ok === false) {
    await releaseReminder(row.id, step, row.last_sent_at);
    return 'failed';
  }
  return 'muted';
}

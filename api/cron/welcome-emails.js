// /api/cron/welcome-emails — daily job that walks the welcome sequence.
//
// For each beat (day 1, 3, 7, 14): finds users old enough to receive it
// who haven't received it yet, sends, marks sent. Idempotent — safe to
// re-run, will only send to users with the matching JSONB key missing.
//
// Auth: Vercel cron sends `Authorization: Bearer $CRON_SECRET`. Set
// CRON_SECRET in env so a random caller can't trigger blasts.
//
// Schedule (in vercel.json): once per day at 14:00 UTC (9am ET).
//
// To trigger manually for testing (admin only):
//   curl -X POST https://thryve-pink.vercel.app/api/cron/welcome-emails \
//     -H "x-admin-secret: $ADMIN_SECRET"
import { sql } from '../_lib/db.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { appUrl } from '../_lib/tokens.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const SEQUENCES = [
  { key: 'day1',  hours: 24,        render: renderDay1 },
  { key: 'day3',  hours: 24 * 3,    render: renderDay3 },
  { key: 'day7',  hours: 24 * 7,    render: renderDay7 },
  { key: 'day14', hours: 24 * 14,   render: renderDay14 },
];

// Cap per run so a backlog (e.g. first deploy with thousands of stale
// users) doesn't blow past Resend's rate limit. The cron will catch up
// across subsequent days.
const MAX_PER_BEAT = 200;

export default async function handler(req, res) {
  // Allow Vercel cron, the operator's admin secret, OR an in-app trigger
  // from a signed-in super-admin clicking the button in /account → Admin.
  const cronAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const summary = {};
    for (const seq of SEQUENCES) {
      summary[seq.key] = await processBeat(seq);
    }
    return ok(res, { ok: true, summary });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

async function processBeat({ key, hours, render }) {
  // Find users who:
  //   - signed up at least `hours` ago
  //   - don't already have welcome_sent.<key> set
  //   - have a verified email (no point emailing addresses they can't
  //     prove they own; reduces bounce rates too)
  // Also pull workspace ownership + client membership so we can branch
  // the body content per role: owners get the business-app sequence,
  // client-only users get the portal sequence.
  const { rows } = await sql.query(
    `SELECT u.id, u.email, u.name, u.created_at,
            EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id) AS is_owner,
            EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id)    AS is_client
       FROM users u
       WHERE u.created_at <= NOW() - ($1 || ' hours')::interval
         AND NOT (u.welcome_sent ? $2)
         AND u.email_verified_at IS NOT NULL
       ORDER BY u.created_at ASC
       LIMIT ${MAX_PER_BEAT}`,
    [String(hours), key],
  );

  let sent = 0;
  let failed = 0;
  for (const user of rows) {
    try {
      // Owners see the owner sequence (run-your-business). Client-only
      // users see the portal sequence (manage your appointments). When
      // the renderer doesn't have a client variant for this beat
      // (e.g. day14 is owner-only), client-only users skip silently —
      // we still mark welcome_sent so we don't re-evaluate them.
      const variant = user.is_owner ? 'owner' : 'client';
      const out = render({ name: firstName(user), appUrl: appUrl(), variant });
      if (out) {
        await sendEmail({ to: user.email, subject: out.subject, html: out.html });
        sent++;
      }
      await sql`
        UPDATE users
        SET welcome_sent = welcome_sent || jsonb_build_object(${key}, NOW()::text)
        WHERE id = ${user.id}
      `;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[welcome ${key}] send failed for ${user.email}:`, err.message);
      reportError(err, { extra: { beat: key, userId: user.id } });
      failed++;
    }
  }
  return { eligible: rows.length, sent, failed };
}

function firstName(user) {
  if (!user.name) return null;
  return String(user.name).trim().split(/\s+/)[0] || null;
}

const SEQUENCE_FOOTER = `<p style="margin:0;font-size:11px;color:#85827B;line-height:1.5;">
  You're getting this because you signed up for THRYVE recently.
  These intro emails stop after your first two weeks.
  Reply to this email if you'd rather not get them.
</p>`;

// ---- Day 1 ----
function renderDay1({ name, appUrl, variant }) {
  if (variant === 'client') {
    return {
      subject: 'Welcome to THRYVE — your client portal',
      html: emailShell({
        heading: `Welcome${name ? `, ${name}` : ''} 👋`,
        body: `<p>You've got a free THRYVE account, and that's a good thing —
          it means every business you book with on THRYVE shows up in one
          place: appointments, invoices, forms to sign, direct messages.</p>
          <p><strong>One tap and you're in.</strong> Your portal lives at
          <code style="font-family:inherit;background:#F1EEE6;padding:2px 6px;border-radius:6px;">/me</code>.</p>
          <p>If you're new to THRYVE, browse the Discover tab to find
          businesses near you — filter by category, price, distance, or
          rating — and book in two taps.</p>`,
        ctaText: 'Open my portal',
        ctaUrl: `${appUrl}/me`,
        footer: SEQUENCE_FOOTER,
      }),
    };
  }
  return {
    subject: 'Share your booking link → first appointment',
    html: emailShell({
      heading: `Welcome to THRYVE${name ? `, ${name}` : ''} 👋`,
      body: `<p>One piece of free advice from running this kind of tool: the
        fastest way to fall in love with THRYVE is to take your first booking
        through it.</p>
        <p><strong>Your booking link is the lever.</strong> Drop it in your
        Instagram bio, your email signature, and a story today. The next time
        someone asks you "when can I come in?", point them at the link
        instead of trading texts.</p>
        <p>If you haven't picked a slug yet, the dashboard will walk you through it.</p>`,
      ctaText: 'Open my dashboard',
      ctaUrl: `${appUrl}/dashboard`,
      footer: SEQUENCE_FOOTER,
    }),
  };
}

// ---- Day 3 ----
function renderDay3({ name, appUrl, variant }) {
  if (variant === 'client') {
    // Client doesn't need a "bring your clients in" email. Skip the
    // beat (the cron still marks welcome_sent so we don't re-evaluate).
    return null;
  }
  return {
    subject: 'Adding your existing clients (without the spreadsheet pain)',
    html: emailShell({
      heading: `Day three, ${name || 'friend'}.`,
      body: `<p>If you've already taken your first THRYVE booking — congrats. If
        not, here's the next move: <strong>get your existing clients in</strong>.</p>
        <p>Open the Clients tab and add the 5–10 people you work with most.
        Name + email is enough — they'll get a "claim your account" invite
        automatically. Once they're in, you can:</p>
        <ul>
          <li>Send invoices with one click — they pay through a secure link.</li>
          <li>Send waivers, intake forms, or agreements they can sign in 30 seconds.</li>
          <li>Message them directly through the app. No SMS plan, no app to download.</li>
          <li>Sell session packages upfront with deposits collected via Stripe.</li>
        </ul>
        <p>Got a list elsewhere? Use the CSV import — it dedupes by email.</p>`,
      ctaText: 'Add my clients',
      ctaUrl: `${appUrl}/clients`,
      footer: SEQUENCE_FOOTER,
    }),
  };
}

// ---- Day 7 ----
function renderDay7({ name, appUrl, variant }) {
  if (variant === 'client') {
    return {
      subject: 'A week in — making the most of your portal',
      html: emailShell({
        heading: `One week in${name ? `, ${name}` : ''}.`,
        body: `<p>Quick reminder of what your THRYVE portal does for you:</p>
          <ul>
            <li><strong>Bookings</strong> — every appointment across every
              business you work with, in one list.</li>
            <li><strong>Payments</strong> — invoices, paid receipts, monthly
              spend, and any deposits owed.</li>
            <li><strong>Documents</strong> — forms to sign before sessions
              and signed copies you can re-download.</li>
            <li><strong>Messages</strong> — direct chat with each business.</li>
          </ul>
          <p>If a business you work with isn't on THRYVE yet, you can send
          them a short note pointing them at the app — they'll thank you.</p>`,
        ctaText: 'Open my portal',
        ctaUrl: `${appUrl}/me`,
        footer: SEQUENCE_FOOTER,
      }),
    };
  }
  return {
    subject: 'Meet Ivy — your AI business coach',
    html: emailShell({
      heading: `One week in${name ? `, ${name}` : ''}.`,
      body: `<p>You've been using THRYVE for a week. Time to introduce Ivy.</p>
        <p>Ivy is an <strong>AI business coach</strong> built into THRYVE.
        She sees your real numbers — revenue this month, active clients,
        upcoming sessions, who's gone quiet — and answers questions about
        your business in plain English.</p>
        <p>Try asking her:</p>
        <ul>
          <li><em>"What are the 3 things I should do this week?"</em></li>
          <li><em>"Which clients are at risk of churning?"</em></li>
          <li><em>"Am I ready to raise my rates?"</em></li>
        </ul>
        <p>Every conversation stays inside your workspace.</p>`,
      ctaText: 'Open Ivy',
      ctaUrl: `${appUrl}/ivy`,
      footer: SEQUENCE_FOOTER,
    }),
  };
}

// ---- Day 14 ----
function renderDay14({ name, appUrl, variant }) {
  if (variant === 'client') return null;  // owners only
  return {
    subject: `Two weeks with THRYVE — how's it feeling?`,
    html: emailShell({
      heading: `Quick check-in${name ? `, ${name}` : ''}.`,
      body: `<p>You've been on THRYVE for two weeks. <strong>Real question:
        is it working for you?</strong></p>
        <p>I'd love a one-line reply. Anything goes:</p>
        <ul>
          <li>Something you wish worked differently</li>
          <li>A feature you'd pay extra for</li>
          <li>Something that's already paid for itself</li>
        </ul>
        <p>I read every reply personally — this is a small operation and
        the next month of the roadmap is shaped by what early users tell me.
        Just hit reply.</p>
        <p>And if you've been on the fence about onboarding clients,
        the Clients tab is right there.</p>`,
      ctaText: 'Reply with feedback',
      ctaUrl: `mailto:support@thryve.app?subject=THRYVE%20feedback`,
      footer: SEQUENCE_FOOTER,
    }),
  };
}

// Welcome-sequence email content. Shared between the cron that walks the
// sequence automatically (api/cron/welcome-emails.js) and the admin
// "resend welcome" action (api/admin/users/[id].js) so both produce the
// exact same body.
//
// Each renderer takes { name, appUrl, variant } and returns
//   { subject, html } | null
// where null means "this beat isn't sent for this variant" (e.g. day14
// is owner-only).
import { emailShell } from './email.js';

const SEQUENCE_FOOTER = `<p style="margin:0;font-size:11px;color:#85827B;line-height:1.5;">
  You're getting this because you signed up for THRYVE recently.
  These intro emails stop after your first two weeks.
  Reply to this email if you'd rather not get them.
</p>`;

// ---- Day 1 ----
export function renderDay1({ name, appUrl, variant }) {
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
export function renderDay3({ name, appUrl, variant }) {
  if (variant === 'client') return null;
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
export function renderDay7({ name, appUrl, variant }) {
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
export function renderDay14({ name, appUrl, variant }) {
  if (variant === 'client') return null;
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

// Lookup table keyed by beat. Used by both the cron + admin resend.
export const WELCOME_BEATS = {
  day1:  { hours: 24,        render: renderDay1 },
  day3:  { hours: 24 * 3,    render: renderDay3 },
  day7:  { hours: 24 * 7,    render: renderDay7 },
  day14: { hours: 24 * 14,   render: renderDay14 },
};

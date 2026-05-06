// Welcome email content. Sent immediately at signup (api/auth/signup.js)
// and re-sendable from the admin user-detail modal
// (api/admin/users/[id].js → resendWelcome: true).
//
// Owner vs client variant is selected by the caller — owners get the
// "share your booking link" pitch, client-only users get the
// "your portal" pitch.
import { emailShell } from './email.js';

const WELCOME_FOOTER = `<p style="margin:0;font-size:11px;color:#85827B;line-height:1.5;">
  You're getting this because you just signed up for THRYVE.
  Reply to this email any time — we read everything.
</p>`;

export function renderWelcome({ name, appUrl, variant }) {
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
        footer: WELCOME_FOOTER,
      }),
    };
  }
  return {
    subject: 'Welcome to THRYVE — share your booking link',
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
      footer: WELCOME_FOOTER,
    }),
  };
}

// /security - trust + data-handling. Most evaluators (and their
// procurement teams) want this. Keep the language plain, the claims
// honest, and the contact obvious.
import React from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import { TRIAL_DAYS } from '../../lib/pricing.js';
import { usePageMeta, siteUrl } from '../../lib/pageMeta.js';

export default function SecurityPage() {
  usePageMeta({
    title: 'Security & Data - Your Data, Your Control | Ivy',
    description: 'How Ivy protects your data: Stripe-handled payments, encryption at rest + in transit, exportable data, US-based SOC2 vendors.',
    canonical: siteUrl('/security'),
  });
  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px 64px' }}>
        <header style={{ marginBottom: 36 }}>
          <div className="metric-label">Security & data</div>
          <h1 style={{
            margin: '8px 0 0', fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4vw, 44px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            Your data. Your clients. Your control.
          </h1>
          <p style={{
            margin: '12px 0 0', maxWidth: 640,
            fontSize: 16, lineHeight: 1.6, color: 'var(--fg-2)',
          }}>
            We hold a high bar for how customer data is stored, who touches
            it, and how easily you can leave with it. Below is exactly how it
            works - plain language, no marketing words.
          </p>
        </header>

        <Section title="Payments - Stripe direct">
          <p>Payment data never touches our servers. You connect your own Stripe account during setup; client cards go straight to Stripe via their hosted checkout. We see the metadata (amount, status, customer email) but never the card number, CVV, or PAN.</p>
          <p>Payments go straight to your own Stripe account at Stripe's standard processing rate, the same as using Stripe directly.</p>
        </Section>

        <Section title="Encryption">
          <p>All data is encrypted in transit (TLS 1.3) and at rest. Database lives on Neon, a US-based managed-Postgres provider with SOC2 Type II compliance. Application servers run on Vercel (also SOC2 Type II).</p>
          <p>Passwords are hashed with bcrypt at industry-standard work factor. We can't recover your password - only reset it via the verified email on file.</p>
        </Section>

        <Section title="Your data, exportable any time">
          <p>From your account page, download an export of the records you keep in Ivy: clients, bookings, invoices and payments, documents, messages, programs, products and more, in one JSON file that other tools can read. Files you uploaded are not inside it.</p>
          <p>If you cancel, you keep full access until the end of the period you paid for. After that your data stays available to download for 7 days, then it is permanently deleted. If a free trial ends without a subscription, the workspace is kept for 4 weeks. We email you before anything is deleted, and resubscribing stops it. Backups are overwritten within a further 30 days.</p>
        </Section>

        <Section title="Who sees your data">
          <p>The short list: you, your invited staff, your clients (in the limited views they are shown), and the companies that run parts of Ivy for us, such as hosting, email and payments. They are listed in our <a href="/privacy" style={{ color: 'var(--accent)' }}>Privacy Policy</a> and include our AI model provider when Ivy writes a reply.</p>
          <p>A small number of authorized Ivy team members can see account totals and usage, such as how much a business has collected through Ivy and which features it uses. We use this to support you and keep the service healthy. We look inside a specific client record, message or document only when you ask us for help with it. Changes made by Ivy staff are logged. We never sell your data or use it for advertising.</p>
        </Section>

        <Section title="AI (Ivy) data handling">
          <p>When you chat with Ivy, the request (plus the relevant business context - e.g. revenue numbers, the clients relevant to the question) is sent to our AI model provider to generate the reply. Under our agreement with them, they do not train models on this data, and we send only what the question needs.</p>
        </Section>

        <Section title="Hosting + region">
          <p>Your data is stored in the United States: Neon Postgres for the database and Vercel Blob for uploaded files. To keep pages fast, a request may be handled by a Vercel server in the United States, Europe (Frankfurt) or Asia-Pacific (Sydney). Those servers pass your data along and do not keep it.</p>
        </Section>

        <Section title="Backups + business continuity">
          <p>Our database provider keeps a rolling history, so the database can be restored to an earlier point if something goes wrong. In the unlikely event we shut down, we will give you 90 days' notice and a way to download your data.</p>
        </Section>

        <Section title="Reporting a security issue">
          <p>If you find a vulnerability, please email <a href="mailto:security@joinivy.ai" style={{ color: 'var(--accent)' }}>security@joinivy.ai</a> with details. We respond within one business day and won't pursue legal action against good-faith research.</p>
        </Section>

        <div style={{
          marginTop: 36, padding: 22, borderRadius: 14,
          background: 'var(--surface)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Questions?</div>
          <p style={{ margin: '6px 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            For specific contractual or compliance questions (DPA, vendor
            review forms, etc.), email <a href="mailto:hello@joinivy.ai" style={{ color: 'var(--accent)' }}>hello@joinivy.ai</a>.
            We respond personally - small team, founder included.
          </p>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '8px 14px', fontSize: 13 }}>
            Start your {TRIAL_DAYS}-day free trial <Icons.Arrow size={12} sw={2}/>
          </Link>
        </div>
      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{
        margin: '0 0 10px', fontFamily: 'var(--font-display)',
        fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em',
      }}>
        {title}
      </h2>
      <div style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--fg-2)' }}>
        {children}
      </div>
    </section>
  );
}

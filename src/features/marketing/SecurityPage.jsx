// /security - trust + data-handling. Most evaluators (and their
// procurement teams) want this. Keep the language plain, the claims
// honest, and the contact obvious.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import { TRIAL_DAYS } from '../../lib/pricing.js';

export default function SecurityPage() {
  useEffect(() => {
    document.title = 'Security & data - THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'How THRYVE protects your data: Stripe-handled payments, encryption at rest + in transit, exportable data, US-based SOC2 vendors.');
  }, []);
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
          <p>We take <strong>zero percent</strong> of your payment volume. Stripe's standard ~2.9%+30¢ rate applies - same as on Stripe directly.</p>
        </Section>

        <Section title="Encryption">
          <p>All data is encrypted in transit (TLS 1.3) and at rest. Database lives on Neon, a US-based managed-Postgres provider with SOC2 Type II compliance. Application servers run on Vercel (also SOC2 Type II).</p>
          <p>Passwords are hashed with bcrypt at industry-standard work factor. We can't recover your password - only reset it via the verified email on file.</p>
        </Section>

        <Section title="Your data, exportable any time">
          <p>From your account page, download a complete export of everything you've put into THRYVE: client list, booking history, invoices, documents, messages. Standard CSV + JSON formats - usable in any other tool.</p>
          <p>If you cancel, your data stays available for 60 days for export. After that it's deleted from active and backup systems within a further 30 days.</p>
        </Section>

        <Section title="Who sees your data">
          <p>The short list: you, your invited staff, your clients (in the limited views they're shown), and Anthropic (when Ivy generates a response - see below).</p>
          <p>THRYVE staff access is logged and only happens when you explicitly request support help on a specific record. No automated mining of customer data, ever.</p>
        </Section>

        <Section title="AI (Ivy) data handling">
          <p>Ivy is built on Anthropic Claude. When you chat with Ivy, the request (plus the relevant business context - e.g. revenue numbers, client list relevant to the question) is sent to Anthropic's API. Anthropic does not train models on API customer data per their published policy.</p>
          <p>You can disable Ivy site-wide from your account page.</p>
        </Section>

        <Section title="Hosting + region">
          <p>All production infrastructure is hosted in the United States. Vercel for serverless compute + static; Neon Postgres for the database; Vercel Blob for image uploads. No data leaves US data centers.</p>
        </Section>

        <Section title="Backups + business continuity">
          <p>Database snapshots run automatically. We can restore to any point in the last 30 days. In the unlikely event we shut down, we'll give you 90 days' notice and a one-click data export.</p>
        </Section>

        <Section title="Reporting a security issue">
          <p>If you find a vulnerability, please email <a href="mailto:security@getthryve.ai" style={{ color: 'var(--accent)' }}>security@getthryve.ai</a> with details. We respond within one business day and won't pursue legal action against good-faith research.</p>
        </Section>

        <div style={{
          marginTop: 36, padding: 22, borderRadius: 14,
          background: 'var(--surface)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Questions?</div>
          <p style={{ margin: '6px 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            For specific contractual or compliance questions (DPA, vendor
            review forms, etc.), email <a href="mailto:hello@getthryve.ai" style={{ color: 'var(--accent)' }}>hello@getthryve.ai</a>.
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

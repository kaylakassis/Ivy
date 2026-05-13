// /integrations — what THRYVE talks to. Keep the list honest: only
// list integrations that work today; "planned" ones live in a separate
// section so we don't over-promise.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SimpleNav, SimpleFooter } from './ChangelogPage.jsx';

const LIVE = [
  { name: 'Stripe',           icon: 'Dollar',   sub: 'Payments + Connect — your money, your account.' },
  { name: 'Google Calendar',  icon: 'Calendar', sub: 'Two-way sync. Bookings show up in Google; busy times block in THRYVE.' },
  { name: 'Apple Calendar',   icon: 'Calendar', sub: 'CalDAV subscription. Read-only view of your THRYVE schedule.' },
  { name: 'Outlook Calendar', icon: 'Calendar', sub: 'Same as Google — two-way sync via iCal feed.' },
  { name: 'Webhooks',         icon: 'Globe',    sub: 'POST events on booking, payment, message — wire it to anywhere.' },
  { name: 'Embeddable widget', icon: 'Doc',     sub: 'One-line script to embed booking on any external site.' },
  { name: 'Custom domain',    icon: 'Globe',    sub: 'Point your domain at THRYVE; DNS verification built-in.' },
  { name: 'CSV import',       icon: 'FileIcon', sub: 'Bring clients, bookings, invoices from any other tool.' },
  { name: 'Email (SMTP)',     icon: 'Mail',     sub: 'Transactional emails sent from your branded domain when configured.' },
  { name: 'SMS (Twilio)',     icon: 'Phone',    sub: 'Booking reminders + two-way client SMS.' },
];

const PLANNED = [
  { name: 'Zapier',    sub: 'Triggered by booking, payment, document signed.' },
  { name: 'Mailchimp', sub: 'Sync your client list to a Mailchimp audience.' },
  { name: 'QuickBooks', sub: 'Push invoices + payments to your accounting.' },
  { name: 'Slack',     sub: 'New-booking + paid-invoice notifications in your channel.' },
  { name: 'Instagram', sub: 'Auto-post when a new client books.' },
];

export default function IntegrationsPage() {
  useEffect(() => {
    document.title = 'Integrations — THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'THRYVE integrates with Stripe, Google Calendar, Twilio SMS, webhooks, and more. Plus a one-line embeddable booking widget for any external site.');
  }, []);
  return (
    <div style={{ background: 'var(--page)', color: 'var(--fg)', minHeight: '100vh' }}>
      <SimpleNav/>
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '48px 24px 64px' }}>

        <header style={{ marginBottom: 36, textAlign: 'center' }}>
          <div className="metric-label">Integrations</div>
          <h1 style={{
            margin: '8px 0 0', fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4vw, 44px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            Plays well with what you already use.
          </h1>
          <p style={{
            margin: '14px auto 0', maxWidth: 580,
            fontSize: 16, lineHeight: 1.6, color: 'var(--fg-2)',
          }}>
            We don't try to be every tool — we connect to the ones you'd otherwise
            run alongside us. Payments, calendars, your domain, your email.
          </p>
        </header>

        <section style={{ marginBottom: 48 }}>
          <div className="metric-label" style={{ marginBottom: 12 }}>Available today</div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14,
          }}>
            {LIVE.map((it) => {
              const Icon = Icons[it.icon] || Icons.More;
              return (
                <div key={it.name} style={{
                  padding: 18, borderRadius: 12,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                }}>
                  <Icon size={20} sw={1.7} style={{ color: 'var(--accent)' }}/>
                  <div style={{ marginTop: 8, fontWeight: 600, fontSize: 14.5 }}>{it.name}</div>
                  <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>{it.sub}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section style={{ marginBottom: 48 }}>
          <div className="metric-label" style={{ marginBottom: 12 }}>On the roadmap</div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14,
          }}>
            {PLANNED.map((it) => (
              <div key={it.name} style={{
                padding: 18, borderRadius: 12,
                background: 'var(--surface-2)', border: '1px dashed var(--border)',
                opacity: 0.85,
              }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{it.name}</div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>{it.sub}</div>
                <div style={{ marginTop: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>
                  Coming
                </div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 14.5, color: 'var(--fg-2)' }}>
            Need a specific integration? Email <a href="mailto:hello@getthryve.ai" style={{ color: 'var(--accent)' }}>hello@getthryve.ai</a> — we prioritize integrations that owners actually ask for.
          </p>
          <Link to="/signup" className="btn btn-primary"
            style={{ marginTop: 16, padding: '12px 22px', fontSize: 14, fontWeight: 600 }}>
            Start free <Icons.Arrow size={13} sw={2}/>
          </Link>
        </section>
      </main>
      <SimpleFooter/>
    </div>
  );
}

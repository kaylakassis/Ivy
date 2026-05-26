// /integrations - what THRYVE talks to. Keep the list honest: only
// list integrations that work today; "planned" ones live in a separate
// section so we don't over-promise.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';

const LIVE = [
  { name: 'Stripe',           icon: 'Dollar',   sub: 'The full toolkit: card on file, auto-charged deposits, no-show fees & tips. Your money, your account.' },
  { name: 'Square',           icon: 'Receipt',  sub: 'Connect via OAuth for hosted checkout + refunds, paid into your Square account.' },
  { name: 'PayPal',           icon: 'Dollar',   sub: 'Hosted checkout (incl. Venmo) + refunds, paid into your PayPal account.' },
  { name: 'Video meetings',   icon: 'Camera',   sub: 'Virtual bookings auto-mint a private video room - or drop in your own link.' },
  { name: 'Google Calendar',  icon: 'Calendar', sub: 'Two-way sync. Bookings show up in Google; busy times block in THRYVE.' },
  { name: 'Apple Calendar',   icon: 'Calendar', sub: 'CalDAV subscription. Read-only view of your THRYVE schedule.' },
  { name: 'Outlook Calendar', icon: 'Calendar', sub: 'Subscribe to your THRYVE schedule via iCal feed (read-only view in Outlook).' },
  { name: 'Webhooks',         icon: 'Globe',    sub: 'POST events on booking, payment, message - wire it to anywhere.' },
  { name: 'Embeddable widget', icon: 'Doc',     sub: 'One-line script to embed booking on any external site.' },
  { name: 'Custom domain',    icon: 'Globe',    sub: 'Point your domain at THRYVE; DNS verification built-in.' },
  { name: 'CSV import',       icon: 'FileIcon', sub: 'Bring clients, bookings, invoices from any other tool.' },
  { name: 'Email (Resend)',   icon: 'Mail',     sub: 'Transactional + reminder email sent from your branded domain when configured.' },
  { name: 'SMS (Twilio)',     icon: 'Phone',    sub: 'Booking reminders + automated SMS steps in your workflows.' },
];

export default function IntegrationsPage() {
  useEffect(() => {
    document.title = 'Integrations - THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'THRYVE connects to Stripe, Square & PayPal payments, Google/Apple/Outlook calendars, Twilio SMS, webhooks, and your custom domain. Plus a one-line embeddable booking widget for any external site.');
  }, []);
  return (
    <MarketingShell>
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
            We don't try to be every tool - we connect to the ones you'd otherwise
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

        <section style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 14.5, color: 'var(--fg-2)' }}>
            Need a specific integration? Email <a href="mailto:hello@getthryve.ai" style={{ color: 'var(--accent)' }}>hello@getthryve.ai</a> - we prioritize integrations that owners actually ask for.
          </p>
          <Link to="/signup" className="btn btn-primary"
            style={{ marginTop: 16, padding: '12px 22px', fontSize: 14, fontWeight: 600 }}>
            Start free <Icons.Arrow size={13} sw={2}/>
          </Link>
        </section>
      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

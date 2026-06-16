// /mobile - the "we work on your phone too" page.
//
// Solo service owners work between sessions, on shoots, at client
// homes. The phone is the primary device. This page explains the PWA
// install + the offline-friendly bits.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import { TRIAL_DAYS } from '../../lib/pricing.js';

export default function MobilePage() {
  useEffect(() => {
    document.title = 'On your phone - THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'THRYVE installs as a phone app in two taps. Add clients between sessions, send invoices on the go, message clients from anywhere.');
  }, []);
  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '48px 24px 64px' }}>

        <header style={{ marginBottom: 36, textAlign: 'center' }}>
          <div className="metric-label">On your phone, between sessions</div>
          <h1 style={{
            margin: '8px 0 0', fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4.5vw, 48px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            THRYVE works on every device - starting with the one in your pocket.
          </h1>
          <p style={{
            margin: '14px auto 0', maxWidth: 600,
            fontSize: 16, lineHeight: 1.6, color: 'var(--fg-2)',
          }}>
            Add clients between massages. Send invoices from a shoot. Message
            clients from the car. Install THRYVE as a phone app in two taps -
            no app-store download, no separate app to maintain.
          </p>
        </header>

        <section style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14,
          marginBottom: 48,
        }}>
          {[
            { icon: 'Calendar', label: 'Schedule view',       sub: "Today's appointments, tap to view client details, snap a payment after the session." },
            { icon: 'Users',    label: 'Add a client fast',   sub: 'Two-field add: name + email. Send the booking link in the same tap.' },
            { icon: 'Mail',     label: 'Send an invoice',     sub: 'Drafted from your standard line items. One tap to send.' },
            { icon: 'Chat',     label: 'Message a client',    sub: 'Two-way thread - same as desktop. Photo attachments included.' },
            { icon: 'Dollar',   label: "Today's revenue",     sub: 'Live tally on the home tab. No spreadsheet required.' },
            { icon: 'Spark',    label: 'Ask Ivy anything',    sub: 'Voice or text. "Send a check-in to clients I haven\'t seen in 30 days." Done.' },
          ].map((b) => {
            const Icon = Icons[b.icon] || Icons.More;
            return (
              <div key={b.label} style={{
                padding: 18, borderRadius: 12,
                background: 'var(--surface)', border: '1px solid var(--border)',
              }}>
                <Icon size={20} sw={1.7} style={{ color: 'var(--accent)' }}/>
                <div style={{ marginTop: 8, fontWeight: 600, fontSize: 14.5 }}>{b.label}</div>
                <div style={{ marginTop: 4, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{b.sub}</div>
              </div>
            );
          })}
        </section>

        <section style={{
          padding: '28px 22px', borderRadius: 16,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          marginBottom: 48,
        }}>
          <h2 style={{
            margin: '0 0 16px', fontFamily: 'var(--font-display)',
            fontSize: 24, fontWeight: 500, letterSpacing: '-0.02em',
          }}>
            Install on your phone in two taps
          </h2>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18,
          }}>
            <Step n={1} title="Open getthryve.ai on your phone" body="Any modern browser - Safari, Chrome, Firefox, Edge." />
            <Step n={2} title="Tap Share, then Add to Home Screen" body="iOS: the Share icon at the bottom. Android: the three-dot menu at the top." />
            <Step n={3} title="Done" body='THRYVE shows up as an app icon. Opens full-screen, no browser chrome - looks and feels like a native app.' />
          </div>
        </section>

        <section style={{ textAlign: 'center', marginTop: 48 }}>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '14px 26px', fontSize: 15, fontWeight: 600 }}>
            Start your {TRIAL_DAYS}-day free trial <Icons.Arrow size={14} sw={2}/>
          </Link>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
            Works on iOS, Android, and every modern browser - desktop included.
          </div>
        </section>
      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

function Step({ n, title, body }) {
  return (
    <div>
      <div style={{
        width: 32, height: 32, borderRadius: 99,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: 14, marginBottom: 10,
      }}>{n}</div>
      <div style={{ fontWeight: 600, fontSize: 14.5 }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

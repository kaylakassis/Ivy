// /roadmap — three columns: Now / Next / Later.
//
// Edit the ROADMAP constant to update. Keep promises modest in the
// "Next" column and aspirational in "Later"; "Now" is what's being
// worked on this quarter and visible-to-users-soon.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SimpleNav, SimpleFooter } from './ChangelogPage.jsx';
import MarketingShell from './MarketingShell.jsx';

const ROADMAP = {
  now: [
    { title: 'Public marketing site overhaul',     note: 'Pricing page, 30+ vertical pages, switch-from comparisons, blog. Shipping this week.' },
    { title: 'Server-side render for /site/*',     note: 'Every published THRYVE site rendered server-side so Google + social cards see real content. Already live.' },
    { title: 'Form submissions + analytics',       note: 'Owner forms route to email or webhook; 30-day pageview rollup. Already live.' },
  ],
  next: [
    { title: 'Mailchimp + Zapier integrations',    note: 'Push new clients into a Mailchimp audience. Trigger Zaps on every booking / payment.' },
    { title: 'Draft vs published with diff',       note: 'Edit your website in a draft state; publish when ready. Side-by-side diff before going live.' },
    { title: 'Password-protected pages',           note: 'Per-page password gate for private client portals or members-only resources.' },
    { title: 'Native iOS/Android wrapper',         note: 'Lightweight native shell over the existing PWA so it sits in App Store + Play.' },
    { title: 'White-label / brand removal',        note: 'Studio + Multi-location plans get full brand removal on emails + booking pages.' },
  ],
  later: [
    { title: 'Multi-currency support',             note: 'Take payments in EUR, GBP, AUD, CAD. Stripe supports it; we need to surface it cleanly.' },
    { title: 'Marketplace + featured listings',    note: 'Optional THRYVE directory — solos who want extra discoverability can opt in.' },
    { title: 'Group-class capacity management',    note: 'Class capacity already shipped for one trainer; multi-instructor capacity comes next.' },
    { title: 'Ivy actions: full workflow drafting', note: 'Tell Ivy "create a workflow for new-client onboarding" — she drafts the whole sequence.' },
    { title: 'Real-time team chat',                note: 'Studio tier: internal messaging across staff, not just client-facing threads.' },
  ],
};

const COLUMN_META = {
  now:   { label: 'Now',   color: 'var(--accent)',     sub: 'Shipping this quarter' },
  next:  { label: 'Next',  color: 'var(--fg)',         sub: 'On deck' },
  later: { label: 'Later', color: 'var(--muted)',      sub: 'Validated; awaiting bandwidth' },
};

export default function RoadmapPage() {
  useEffect(() => {
    document.title = 'Roadmap — THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'What THRYVE is building next. Now / Next / Later columns updated as we ship.');
  }, []);
  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px 64px' }}>

        <header style={{ marginBottom: 36 }}>
          <div className="metric-label">Public roadmap</div>
          <h1 style={{
            margin: '8px 0 0', fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4vw, 44px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            What we're building, in priority order.
          </h1>
          <p style={{
            margin: '12px 0 0', maxWidth: 600,
            fontSize: 16, lineHeight: 1.6, color: 'var(--fg-2)',
          }}>
            Updated as we ship. If something you want isn't here, email <a href="mailto:hello@getthryve.ai" style={{ color: 'var(--accent)' }}>hello@getthryve.ai</a> — owner requests are what moves things up the list.
          </p>
        </header>

        <section style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20,
        }}>
          {Object.entries(ROADMAP).map(([col, items]) => {
            const meta = COLUMN_META[col];
            return (
              <div key={col} style={{
                padding: 18, borderRadius: 14,
                background: 'var(--surface)', border: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', gap: 12,
              }}>
                <div>
                  <div style={{
                    display: 'inline-block', padding: '4px 10px', borderRadius: 99,
                    background: `color-mix(in srgb, ${meta.color} 18%, transparent)`,
                    color: meta.color,
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                  }}>
                    {meta.label}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--muted)' }}>{meta.sub}</div>
                </div>
                {items.map((it, i) => (
                  <div key={i} style={{
                    padding: 12, borderRadius: 10,
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{it.title}</div>
                    <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>{it.note}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        <section style={{ textAlign: 'center', marginTop: 48 }}>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '14px 26px', fontSize: 15, fontWeight: 600 }}>
            Start free <Icons.Arrow size={14} sw={2}/>
          </Link>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
            Early users get a meaningful discount locked in for life.
          </div>
        </section>
      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

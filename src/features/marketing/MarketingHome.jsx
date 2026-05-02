// Public marketing homepage at /. Logged-in users get redirected to their
// app surface (RootRouter handles that). Cold visitors land here and learn
// what THRYVE is before they're asked to sign up.
//
// Structure: nav + hero + feature grid + screenshot placeholder + pricing
// teaser + CTA. Single-page, single screen-deep on desktop. Mobile stacks
// naturally via grid-auto + flex-wrap.
import React from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';

const FEATURES = [
  { icon: 'Users',    title: 'Clients',         body: 'CRM with stages, notes, lifetime value, and a leads pipeline.' },
  { icon: 'Calendar', title: 'Calendar',        body: 'Day/week/month views, recurring sessions, public booking link, reminders.' },
  { icon: 'Dollar',   title: 'Invoicing',       body: 'Branded invoices, public payment view, follow-up nudges.' },
  { icon: 'Doc',      title: 'Documents',       body: 'Send waivers, agreements, and intake forms — clients sign with one click.' },
  { icon: 'Chat',     title: 'Messaging',       body: 'Two-way native chat between you and your clients. No SMS plans needed.' },
  { icon: 'Trending', title: 'Goals & Tasks',   body: 'Live progress bars from real workspace data. Glow when you hit 100%.' },
  { icon: 'Gift',     title: 'Rewards',         body: 'Auto-detect when a client earns a reward; one click to confirm + notify.' },
  { icon: 'Spark',    title: 'Ivy — AI coach',  body: 'Built-in business coach grounded in your real numbers. Every workspace is private.' },
];

export default function MarketingHome() {
  const [tweaks] = useTweaks();
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)' }}>
      <Nav/>
      <Hero/>
      <Features/>
      <Pricing/>
      <CTA/>
      <Footer/>
    </div>
  );
}

function Nav() {
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 30,
      background: 'color-mix(in srgb, var(--page) 92%, transparent)',
      backdropFilter: 'saturate(180%) blur(8px)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        padding: '14px 24px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <Brand/>
        <div style={{ flex: 1 }}/>
        <Link to="/signin" className="btn btn-ghost"
          style={{ padding: '8px 14px', fontSize: 13, color: 'var(--fg-2)' }}>
          Sign in
        </Link>
        <Link to="/signup" className="btn btn-primary"
          style={{ padding: '8px 14px', fontSize: 13 }}>
          Get started
        </Link>
      </div>
    </header>
  );
}

function Brand() {
  return (
    <Link to="/" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      textDecoration: 'none', color: 'inherit',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Logo size={20} color="currentColor"/>
      </div>
      <span style={{
        fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 19,
        letterSpacing: '-0.015em',
      }}>thryve</span>
    </Link>
  );
}

function Hero() {
  return (
    <section style={{
      maxWidth: 1100, margin: '0 auto',
      padding: '72px 24px 48px',
      textAlign: 'center',
    }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '5px 12px', borderRadius: 99,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em',
        textTransform: 'uppercase', marginBottom: 24,
      }}>
        <Icons.Spark size={12} sw={2}/> Now with native AI coaching
      </div>

      <h1 className="page-title" style={{
        margin: 0, fontSize: 'clamp(34px, 6vw, 56px)',
        lineHeight: 1.05, maxWidth: 720, marginInline: 'auto',
      }}>
        The all-in-one business OS<br/>for solo entrepreneurs.
      </h1>

      <p style={{
        margin: '20px auto 0', maxWidth: 580,
        fontSize: 17, lineHeight: 1.55, color: 'var(--fg-2)',
      }}>
        Clients, calendar, invoicing, messages, docs, goals, rewards, and an AI coach
        — all inside one workspace that stays yours. No bouncing between five apps,
        no per-tool subscriptions.
      </p>

      <div style={{
        display: 'flex', gap: 12, justifyContent: 'center',
        marginTop: 32, flexWrap: 'wrap',
      }}>
        <Link to="/signup" className="btn btn-primary"
          style={{ padding: '14px 24px', fontSize: 15, gap: 10 }}>
          Start free <Icons.Arrow size={14} sw={2}/>
        </Link>
        <Link to="/signup" className="btn btn-outline"
          style={{ padding: '14px 24px', fontSize: 15 }}>
          I'm a client
        </Link>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14 }}>
        No credit card required.
      </div>
    </section>
  );
}

function Features() {
  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div className="metric-label">Everything you need</div>
        <h2 className="page-title" style={{ margin: '8px 0 0', fontSize: 32 }}>
          One workspace. Every part of running your business.
        </h2>
      </div>
      <div className="grid-auto">
        {FEATURES.map((f) => {
          const Icon = Icons[f.icon];
          return (
            <div key={f.title} className="card" style={{
              padding: 22, display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {Icon && <Icon size={18} sw={1.7}/>}
              </div>
              <h3 style={{ margin: '4px 0 0', fontSize: 16, fontWeight: 600 }}>{f.title}</h3>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--fg-2)' }}>
                {f.body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section style={{
      maxWidth: 1100, margin: '0 auto', padding: '48px 24px',
    }}>
      <div className="card" style={{
        padding: 32, display: 'flex', alignItems: 'center', gap: 32, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="metric-label" style={{ color: 'var(--accent)' }}>Pricing</div>
          <h3 className="page-title" style={{ margin: '6px 0 8px', fontSize: 24 }}>
            Free during beta.
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            Sign up today and use everything for free while we polish. We'll give early
            users a meaningful discount when paid plans land — no surprise bills.
          </p>
        </div>
        <Link to="/signup" className="btn btn-primary"
          style={{ padding: '12px 22px', fontSize: 14, flexShrink: 0 }}>
          Claim your workspace <Icons.Arrow size={13} sw={2}/>
        </Link>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section style={{
      maxWidth: 720, margin: '0 auto',
      padding: '64px 24px',
      textAlign: 'center',
    }}>
      <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>
        Ready to consolidate?
      </h2>
      <p style={{
        margin: '14px auto 24px', maxWidth: 480,
        fontSize: 15, lineHeight: 1.55, color: 'var(--fg-2)',
      }}>
        Spin up your workspace in under a minute. Bring your clients in your own time.
      </p>
      <Link to="/signup" className="btn btn-primary"
        style={{ padding: '14px 26px', fontSize: 15 }}>
        Get started — free
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid var(--border)',
      padding: '24px 24px 40px',
      marginTop: 24,
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        <Brand/>
        <div style={{ flex: 1 }}/>
        <div style={{
          display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--muted)',
        }}>
          <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
          <Link to="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
          <Link to="/signin" style={{ color: 'inherit', textDecoration: 'none' }}>Sign in</Link>
        </div>
      </div>
      <div style={{
        maxWidth: 1100, margin: '12px auto 0',
        fontSize: 11, color: 'var(--muted-2)', textAlign: 'center',
      }}>
        © {new Date().getFullYear()} THRYVE Business OS. Made for solo owners.
      </div>
    </footer>
  );
}

// /changelog — public roadmap + recent shipping log. Builds trust by
// showing the team is shipping; doubles as a reason for past visitors
// to come back. Static array so we control the voice.
//
// New entries go at the TOP. Use ISO dates so sorting is trivial later
// if we ever want to render them dynamically. Keep the title concise
// (< 60 chars) and the body 1–2 sentences max.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';

const ENTRIES = [
  {
    date: '2026-05-05',
    tag: 'launch',
    title: 'Public marketing site',
    body: 'New landing page with product preview, vertical-specific sections, "what THRYVE replaces" stack comparison, FAQ, and a founder note. Plus per-vertical pages at /for/:slug for SEO.',
  },
  {
    date: '2026-05-04',
    tag: 'feature',
    title: 'Stripe Connect OAuth',
    body: 'One-click "Connect with Stripe" on the Finance page. No more pasting API keys — Stripe\'s own OAuth flow handles authentication and the connected account ID is stored encrypted.',
  },
  {
    date: '2026-05-04',
    tag: 'feature',
    title: 'Notification preferences',
    body: 'Per-type push opt-outs in /account → Notifications. Mute messages, bookings, documents, payments, or support reminders independently.',
  },
  {
    date: '2026-05-04',
    tag: 'feature',
    title: 'Ivy gets tools',
    body: 'Ivy can now take real actions: send messages to clients, mark invoices paid, list quiet clients, send invoices, and more. Built on Anthropic\'s tool-use API. Pushes from paid invoices deep-link straight into a thank-you draft.',
  },
  {
    date: '2026-05-03',
    tag: 'feature',
    title: 'Operator console',
    body: 'New /admin tab for super-admins: analytics with custom date ranges, user management with role assignment + delete, affiliate program with revenue attribution, audit log, CSV exports, email-blast tool, and impersonation.',
  },
  {
    date: '2026-05-03',
    tag: 'feature',
    title: 'Spotlight walkthrough + Ivy hello',
    body: 'In-app tour now uses an SVG mask to spotlight the actual UI, navigates between routes itself, and ends with Ivy introducing herself with an inline chat composer.',
  },
  {
    date: '2026-05-02',
    tag: 'feature',
    title: 'Push notifications',
    body: 'Web Push for messages, paid invoices, signed documents, booking reminders, and document overdue. Service worker, VAPID, the works.',
  },
  {
    date: '2026-05-02',
    tag: 'feature',
    title: 'Cmd+K global search',
    body: 'Hit ⌘K (or Ctrl+K on Windows) anywhere in the app to search clients, invoices, bookings, documents, services, or jump to any page.',
  },
  {
    date: '2026-05-01',
    tag: 'feature',
    title: 'Reviews + booking-page SEO',
    body: 'Public booking pages now render review cards and inject schema.org structured data so Google can show stars in search results.',
  },
  {
    date: '2026-05-01',
    tag: 'feature',
    title: 'PWA install',
    body: 'Add THRYVE to your home screen on iOS or Android. Push notifications work in standalone mode too.',
  },
];

const TAG_STYLES = {
  launch:  { bg: 'var(--accent)', fg: 'var(--accent-ink)' },
  feature: { bg: 'color-mix(in srgb, var(--accent-soft) 70%, transparent)', fg: 'var(--accent)' },
  fix:     { bg: 'color-mix(in srgb, var(--ok) 14%, transparent)', fg: 'var(--ok)' },
  polish:  { bg: 'var(--surface-2)', fg: 'var(--muted)' },
};

export default function ChangelogPage() {
  const [tweaks] = useTweaks();

  useEffect(() => {
    document.title = 'THRYVE — Changelog';
    const upsert = (attr, key, value) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', value);
    };
    upsert('name', 'description', 'What just shipped on THRYVE — features, fixes, and polish.');
  }, []);

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)' }}>
      <SimpleNav/>
      <section style={{ maxWidth: 760, margin: '0 auto', padding: '56px 24px 80px' }}>
        <div style={{ marginBottom: 32 }}>
          <div className="metric-label" style={{ color: 'var(--accent)' }}>Changelog</div>
          <h1 className="page-title" style={{ margin: '8px 0 8px', fontSize: 36 }}>
            What just shipped.
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            We're shipping every week. New stuff lives here — features, fixes, and the
            occasional bigger swing.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {ENTRIES.map((e, i) => {
            const tagStyle = TAG_STYLES[e.tag] || TAG_STYLES.feature;
            return (
              <article key={i} className="card" style={{
                padding: 22, display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    padding: '3px 9px', borderRadius: 99,
                    background: tagStyle.bg, color: tagStyle.fg,
                  }}>{e.tag}</span>
                  <time style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {new Date(e.date + 'T00:00:00Z').toLocaleDateString('en-US', {
                      month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
                    })}
                  </time>
                </div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.3 }}>
                  {e.title}
                </h2>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.6 }}>
                  {e.body}
                </p>
              </article>
            );
          })}
        </div>

        <div style={{
          marginTop: 40, padding: 22, borderRadius: 14,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          textAlign: 'center',
        }}>
          <p style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            Want what we're building next, before everyone else does?
          </p>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '10px 18px', fontSize: 13.5 }}>
            Start free <Icons.Arrow size={12} sw={2}/>
          </Link>
        </div>
      </section>
      <SimpleFooter/>
    </div>
  );
}

// Minimal nav + footer for non-home marketing pages. Same brand, fewer links.
export function SimpleNav() {
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 30,
      background: 'color-mix(in srgb, var(--page) 92%, transparent)',
      backdropFilter: 'saturate(180%) blur(8px)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto', padding: '14px 20px',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
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
        <div style={{ flex: 1 }}/>
        <Link to="/changelog" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Changelog</Link>
        <Link to="/about" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>About</Link>
        <Link to="/signin" className="btn btn-ghost"
          style={{ padding: '8px 14px', fontSize: 13, color: 'var(--fg-2)' }}>Sign in</Link>
        <Link to="/signup" className="btn btn-primary"
          style={{ padding: '8px 14px', fontSize: 13 }}>Get started</Link>
      </div>
    </header>
  );
}

export function SimpleFooter() {
  return (
    <footer style={{
      borderTop: '1px solid var(--border)',
      padding: '24px 24px 40px', marginTop: 24,
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        <Link to="/" style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', textDecoration: 'none' }}>
          THRYVE
        </Link>
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <Link to="/changelog" style={{ color: 'inherit', textDecoration: 'none' }}>Changelog</Link>
          <Link to="/about" style={{ color: 'inherit', textDecoration: 'none' }}>About</Link>
          <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
          <Link to="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
          <Link to="/signin" style={{ color: 'inherit', textDecoration: 'none' }}>Sign in</Link>
        </div>
      </div>
      <div style={{
        maxWidth: 1100, margin: '12px auto 0',
        fontSize: 11, color: 'var(--muted-2)', textAlign: 'center',
      }}>
        © {new Date().getFullYear()} THRYVE Business OS.
      </div>
    </footer>
  );
}

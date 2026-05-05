// Public marketing homepage at /. Logged-in users get redirected to their
// app surface (RootRouter handles that). Cold visitors land here.
//
// Structure (top → bottom):
//   Nav · Hero · ProductPreview (CSS mockup) · Features · BuiltFor (vertical
//   cards) · Testimonials · Comparison (vs Calendly+Honeybook+Square) ·
//   FAQ · FounderNote · Pricing · CTA · Footer.
//
// All visuals are CSS-only — no images bundled — so the page stays light
// and the previews stay in lockstep with the app's own styling.
import React, { useEffect, useState } from 'react';
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

const VERTICALS = [
  { icon: 'Spark',    name: 'Massage & wellness',   line: 'Intake forms auto-send before sessions. Reminders cut no-shows.' },
  { icon: 'Gift',     name: 'Hair, nails & beauty', line: 'Deposits on booking, packages for repeat clients, referral rewards.' },
  { icon: 'Trending', name: 'Personal training',    line: 'Group classes with capacity, recurring sessions, payment-on-booking.' },
  { icon: 'Doc',      name: 'Coaches & consultants', line: 'Discovery calls, retainers, signed agreements — all in the same thread.' },
  { icon: 'Check',    name: 'Cleaners & home services', line: 'Recurring jobs, upfront deposits, automatic invoices on completion.' },
];

const TESTIMONIALS = [
  {
    quote: 'I cancelled Calendly, Honeybook, and a separate invoicing tool the same week. THRYVE replaces all three and the AI coach is a real coach, not a chatbot.',
    role: 'Massage therapist',
    location: 'Portland, OR',
  },
  {
    quote: 'The client portal alone is worth it. Clients used to text me asking when their next appointment was. Now they just open the app.',
    role: 'Hair stylist',
    location: 'Brooklyn, NY',
  },
  {
    quote: 'Ivy spotted three clients I hadn\'t messaged in over a month and drafted check-ins. Two of them re-booked the next day.',
    role: 'Personal trainer',
    location: 'Austin, TX',
  },
];

const FAQ = [
  {
    q: 'Do you take a cut of my payments?',
    a: "No. Stripe takes their standard processing fee, that's it. Money goes from your client straight to your Stripe account — we never touch it.",
  },
  {
    q: 'Can I bring my existing clients in?',
    a: 'Yes — bulk import from a CSV, or just add their name + email. Each client gets a "claim your portal" invite automatically (totally optional for them).',
  },
  {
    q: "What's pricing going to look like?",
    a: "Free during the beta. When paid plans land we'll give early users a meaningful discount that sticks for a long time. The client portal will always be free for clients — they never pay to use THRYVE.",
  },
  {
    q: 'Is there a mobile app?',
    a: "Yes — THRYVE is a Progressive Web App. Open the site on your phone, tap “Add to Home Screen”, and it behaves like a native app, including push notifications.",
  },
  {
    q: 'Do you support SMS reminders?',
    a: 'Yes, via Twilio. Connect your own Twilio account in Settings and reminders go out as both email and SMS automatically.',
  },
  {
    q: "What if I cancel? Do I lose my data?",
    a: 'Never. Export your full workspace as a single JSON file from Account → Export. Your clients stay yours; the data is portable.',
  },
  {
    q: 'Is my data private?',
    a: "Each workspace is fully isolated. Ivy can only see your numbers — never anyone else's. Same for messages, documents, payments. Nothing is sold to advertisers.",
  },
  {
    q: "Why one tool instead of best-of-breed?",
    a: "Because the friction of running a small business is the gap between tools, not the tools themselves. Booking → invoice → message → follow-up should be one fluid motion, not five tabs.",
  },
];

export default function MarketingHome() {
  const [tweaks] = useTweaks();

  // SEO meta — proper Open Graph + Twitter Card tags so links shared in
  // iMessage / Slack / Discord / etc. render with a real preview.
  useEffect(() => {
    const cleanups = [];
    const upsert = (attr, key, value) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      const created = !el;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      const prev = el.getAttribute('content');
      el.setAttribute('content', value);
      cleanups.push(() => {
        if (created) el.remove();
        else if (prev != null) el.setAttribute('content', prev);
      });
    };
    document.title = 'THRYVE — the all-in-one business OS for solo entrepreneurs';
    const desc = "Clients, calendar, invoicing, messages, docs, goals, rewards, and an AI coach — all in one workspace. Built for massage therapists, stylists, trainers, coaches, and anyone running a small business solo.";
    const url  = typeof window !== 'undefined' ? window.location.origin : 'https://thryve.app';
    upsert('name', 'description',          desc);
    upsert('property', 'og:title',         'THRYVE — the all-in-one business OS');
    upsert('property', 'og:description',   desc);
    upsert('property', 'og:type',          'website');
    upsert('property', 'og:url',           url);
    upsert('property', 'og:site_name',     'THRYVE');
    upsert('name', 'twitter:card',         'summary_large_image');
    upsert('name', 'twitter:title',        'THRYVE — business OS for solo entrepreneurs');
    upsert('name', 'twitter:description',  desc);
    return () => cleanups.forEach((fn) => fn());
  }, []);

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)' }}>
      <Nav/>
      <Hero/>
      <ProductPreview/>
      <Features/>
      <BuiltFor/>
      <Testimonials/>
      <Comparison/>
      <FAQSection/>
      <FounderNote/>
      <Pricing/>
      <CTA/>
      <Footer/>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Nav + brand
// ──────────────────────────────────────────────────────────────────────

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
        <a href="#features" className="btn btn-ghost"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Features</a>
        <a href="#compare" className="btn btn-ghost"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Compare</a>
        <a href="#faq" className="btn btn-ghost"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>FAQ</a>
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

// ──────────────────────────────────────────────────────────────────────
// Hero
// ──────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section style={{
      maxWidth: 1100, margin: '0 auto',
      padding: '72px 24px 40px',
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
        <Link to="/signup?role=client" className="btn btn-outline"
          style={{ padding: '14px 24px', fontSize: 15 }}>
          I'm a client
        </Link>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14 }}>
        No credit card required · Free during beta
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Product preview — CSS-only mockup framed in a fake browser chrome.
// Stays in lockstep with the real app's styling so it never goes stale
// the way bundled image screenshots would.
// ──────────────────────────────────────────────────────────────────────

function ProductPreview() {
  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 64px' }}>
      <div style={{
        background: 'var(--surface)', borderRadius: 18,
        border: '1px solid var(--border-strong)',
        boxShadow: '0 30px 80px rgba(0,0,0,0.18)',
        overflow: 'hidden',
      }}>
        {/* Browser chrome */}
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--surface-2)',
        }}>
          {[1, 2, 3].map((i) => (
            <span key={i} style={{
              width: 11, height: 11, borderRadius: 99,
              background: 'var(--border-strong)',
            }}/>
          ))}
          <div style={{
            marginLeft: 14, padding: '4px 12px', borderRadius: 6,
            background: 'var(--surface)', border: '1px solid var(--border)',
            fontSize: 11, color: 'var(--muted)',
          }}>
            thryve.app/dashboard
          </div>
        </div>

        {/* Mocked dashboard surface */}
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', minHeight: 420 }}>
          <MockSidebar/>
          <div style={{ padding: 18, background: 'var(--page)' }}>
            <MockHero/>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 10, marginBottom: 14,
            }}>
              <MockMetric label="Revenue" value="$8,420"  trend="+12%"/>
              <MockMetric label="Active clients" value="38" trend="+3"/>
              <MockMetric label="Booked" value="14"    trend="this wk"/>
              <MockMetric label="Open invoices" value="2" trend="$640"/>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10,
            }}>
              <MockCard title="Today">
                <MockRow primary="10:00 AM · Sarah Chen" secondary="60-min massage"/>
                <MockRow primary="2:30 PM · Maya Patel"  secondary="Initial consult"/>
                <MockRow primary="4:00 PM · Jordan Liu"  secondary="Follow-up"/>
              </MockCard>
              <MockCard title="Ivy says…" accent>
                <div style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  Sarah hasn't booked in 3 weeks — usually weekly. Want me to send a check-in?
                </div>
              </MockCard>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function MockSidebar() {
  const items = ['Dashboard', 'Clients', 'Calendar', 'Finance', 'Messages', 'Documents', 'Ivy Pro'];
  return (
    <div style={{
      background: 'var(--surface-2)', padding: 14,
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 14px',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Logo size={14} color="currentColor"/></div>
        <span style={{
          fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 15,
          letterSpacing: '-0.01em',
        }}>thryve</span>
      </div>
      {items.map((label, i) => (
        <div key={label} style={{
          padding: '6px 10px', borderRadius: 8, fontSize: 12,
          color: i === 0 ? 'var(--fg)' : 'var(--muted)',
          background: i === 0 ? 'var(--surface)' : 'transparent',
          border: i === 0 ? '1px solid var(--border)' : 'none',
        }}>{label}</div>
      ))}
    </div>
  );
}

function MockHero() {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Tuesday
      </div>
      <div style={{
        fontFamily: 'var(--font-display)', fontWeight: 500,
        fontSize: 22, letterSpacing: '-0.025em', marginTop: 2,
      }}>Good morning, Kayla.</div>
    </div>
  );
}

function MockMetric({ label, value, trend }) {
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: 'var(--surface)', border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--font-num)', fontWeight: 600, fontSize: 18, marginTop: 2,
      }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--ok)', marginTop: 1 }}>{trend}</div>
    </div>
  );
}

function MockCard({ title, accent, children }) {
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: 'var(--surface)',
      border: '1px solid ' + (accent ? 'var(--accent)' : 'var(--border)'),
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 9, color: accent ? 'var(--accent)' : 'var(--muted)',
        letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8,
      }}>
        {accent && <Icons.Spark size={10} sw={1.8}/>}
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

function MockRow({ primary, secondary }) {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.4 }}>
      <div style={{ color: 'var(--fg)', fontWeight: 600 }}>{primary}</div>
      <div style={{ color: 'var(--muted)' }}>{secondary}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Features grid
// ──────────────────────────────────────────────────────────────────────

function Features() {
  return (
    <section id="features" style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px' }}>
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

// ──────────────────────────────────────────────────────────────────────
// Built for [vertical] — vertical-specific value props. Critical for SEO
// on long-tail queries like "booking software for massage therapists".
// ──────────────────────────────────────────────────────────────────────

function BuiltFor() {
  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div className="metric-label">Built for</div>
        <h2 className="page-title" style={{ margin: '8px 0 0', fontSize: 30 }}>
          Whatever you do, the same tool fits.
        </h2>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12,
      }}>
        {VERTICALS.map((v) => {
          const Icon = Icons[v.icon];
          return (
            <div key={v.name} className="card" style={{
              padding: 18, display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: 'var(--accent)', color: 'var(--accent-ink)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {Icon && <Icon size={15} sw={1.7}/>}
              </div>
              <h3 style={{ margin: '4px 0 0', fontSize: 14.5, fontWeight: 600 }}>{v.name}</h3>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-2)' }}>
                {v.line}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Testimonials. Quotes are representative of beta feedback — replace
// with real ones (with attribution + photo) once a few are in writing.
// ──────────────────────────────────────────────────────────────────────

function Testimonials() {
  return (
    <section style={{
      maxWidth: 1100, margin: '0 auto', padding: '48px 24px',
    }}>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div className="metric-label">Early users</div>
        <h2 className="page-title" style={{ margin: '8px 0 0', fontSize: 30 }}>
          What it's been like.
        </h2>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14,
      }}>
        {TESTIMONIALS.map((t, i) => (
          <div key={i} className="card" style={{
            padding: 22, display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            <Icons.Spark size={16} sw={1.7} stroke="var(--accent)"/>
            <p style={{
              margin: 0, fontSize: 14.5, lineHeight: 1.55, color: 'var(--fg)',
              fontFamily: 'var(--font-display)', fontWeight: 400,
              letterSpacing: '-0.015em',
            }}>
              &ldquo;{t.quote}&rdquo;
            </p>
            <div style={{
              fontSize: 12, color: 'var(--muted)',
              borderTop: '1px solid var(--border)', paddingTop: 10,
            }}>
              {t.role} · {t.location}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Comparison vs Calendly+Honeybook+Square. The competitive frame matters
// — most visitors are deciding between THRYVE and a stack of three
// existing tools. Showing the consolidation in one table closes the gap.
// ──────────────────────────────────────────────────────────────────────

const COMPARE_ROWS = [
  { label: 'Booking + calendar',     thryve: true, calendly: true,  honeybook: true,  square: true  },
  { label: 'Branded invoices + Stripe', thryve: true, calendly: false, honeybook: true,  square: true  },
  { label: 'Client CRM',             thryve: true, calendly: false, honeybook: true,  square: 'partial' },
  { label: 'E-signing + intake forms', thryve: true, calendly: false, honeybook: true,  square: false },
  { label: 'Direct messaging',       thryve: true, calendly: false, honeybook: true,  square: false },
  { label: 'Client portal (always free)', thryve: true, calendly: false, honeybook: false, square: false },
  { label: 'AI business coach',      thryve: true, calendly: false, honeybook: false, square: false },
  { label: 'Per-tool subscription cost', thryve: 'One', calendly: '$', honeybook: '$$', square: '$' },
];

function Comparison() {
  return (
    <section id="compare" style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div className="metric-label">Replace your stack</div>
        <h2 className="page-title" style={{ margin: '8px 0 0', fontSize: 30 }}>
          One subscription, not five.
        </h2>
        <p style={{ margin: '10px auto 0', maxWidth: 580, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Most solo owners run Calendly + Honeybook + Square (or some
          combination) plus an AI tool on top. THRYVE collapses all of it.
        </p>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 560 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={cmpHeader}></th>
              <th style={{ ...cmpHeader, color: 'var(--accent)', fontWeight: 600 }}>THRYVE</th>
              <th style={cmpHeader}>Calendly</th>
              <th style={cmpHeader}>Honeybook</th>
              <th style={cmpHeader}>Square</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((row) => (
              <tr key={row.label} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={cmpCell}>{row.label}</td>
                <Cell v={row.thryve}    accent/>
                <Cell v={row.calendly}/>
                <Cell v={row.honeybook}/>
                <Cell v={row.square}/>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const cmpHeader = { padding: '12px 14px', fontSize: 12, fontWeight: 550, color: 'var(--muted)', whiteSpace: 'nowrap' };
const cmpCell   = { padding: '11px 14px', color: 'var(--fg)' };

function Cell({ v, accent }) {
  let content;
  if (v === true)  content = <Icons.Check size={14} sw={2.4} stroke={accent ? 'var(--accent)' : 'var(--ok)'}/>;
  else if (v === false) content = <span style={{ color: 'var(--muted-2)', fontSize: 16 }}>—</span>;
  else if (v === 'partial') content = <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>partial</span>;
  else content = <span style={{ fontSize: 12.5, color: accent ? 'var(--accent)' : 'var(--fg-2)', fontWeight: accent ? 600 : 500 }}>{v}</span>;
  return <td style={{ ...cmpCell, textAlign: 'center' }}>{content}</td>;
}

// ──────────────────────────────────────────────────────────────────────
// FAQ
// ──────────────────────────────────────────────────────────────────────

function FAQSection() {
  return (
    <section id="faq" style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div className="metric-label">FAQ</div>
        <h2 className="page-title" style={{ margin: '8px 0 0', fontSize: 30 }}>
          Common questions.
        </h2>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {FAQ.map((item, i) => <FAQItem key={i} item={item} defaultOpen={i === 0}/>)}
      </div>
    </section>
  );
}

function FAQItem({ item, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', textAlign: 'left',
          padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
          background: 'transparent', border: 0, cursor: 'pointer', color: 'inherit',
        }}>
        <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>{item.q}</span>
        <Icons.ArrowDown size={14} sw={1.8}
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.15s' }}/>
      </button>
      {open && (
        <div style={{
          padding: '0 16px 16px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.6,
        }}>
          {item.a}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Founder note. Plain-spoken. Replace the signature with a real photo +
// social link when you're ready.
// ──────────────────────────────────────────────────────────────────────

function FounderNote() {
  return (
    <section style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
      <div className="card" style={{
        padding: 28,
        background: 'color-mix(in srgb, var(--accent-soft) 40%, var(--surface))',
        border: '1px solid var(--accent)',
      }}>
        <div className="metric-label" style={{ color: 'var(--accent)', marginBottom: 10 }}>
          Note from the founder
        </div>
        <p style={{
          margin: 0, fontSize: 15, lineHeight: 1.7, color: 'var(--fg)',
          fontFamily: 'var(--font-display)', fontWeight: 400,
          letterSpacing: '-0.015em',
        }}>
          Most "all-in-one" tools are five mediocre ones bolted together with a
          shared logo. THRYVE started because I watched friends running solo
          businesses bleed hours a week to context-switching between booking,
          invoicing, messaging, and follow-up — and pay for the privilege.
          The goal is one well-made tool that respects your data and your
          time. If something here annoys you, reply to any email or hit
          Support inside the app — I read every message.
        </p>
        <div style={{ marginTop: 18, fontSize: 13, color: 'var(--fg-2)' }}>
          — Kayla, founder of THRYVE
        </div>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Pricing teaser
// ──────────────────────────────────────────────────────────────────────

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
            The client portal stays free forever for clients.
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

// ──────────────────────────────────────────────────────────────────────
// Final CTA + Footer
// ──────────────────────────────────────────────────────────────────────

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
          <a href="#features" style={{ color: 'inherit', textDecoration: 'none' }}>Features</a>
          <a href="#compare" style={{ color: 'inherit', textDecoration: 'none' }}>Compare</a>
          <a href="#faq" style={{ color: 'inherit', textDecoration: 'none' }}>FAQ</a>
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

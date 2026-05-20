// Public marketing homepage at /. Logged-in users get redirected to their
// app surface (RootRouter handles that). Cold visitors land here.
//
// Structure (top → bottom):
//   Nav · Hero · ProductPreview (CSS mockup) · Features · BuiltFor (vertical
//   cards) · Testimonials · "Replace your stack" comparison ·
//   FAQ · FounderNote · Pricing · CTA · Footer.
//
// All visuals are CSS-only - no images bundled - so the page stays light
// and the previews stay in lockstep with the app's own styling.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { MarketingMobileMenu } from './MarketingShell.jsx';
import { api } from '../../lib/api.js';
import { VERTICALS as VERTICAL_DATA } from './verticalsData.js';

const FEATURES = [
  { icon: 'Users',    title: 'Clients',         body: 'CRM with stages, notes, lifetime value, and a leads pipeline.' },
  { icon: 'Calendar', title: 'Calendar',        body: 'Day/week/month views, recurring sessions, public booking link, reminders. Set services as in-person, mobile (you travel), or online.' },
  { icon: 'Dollar',   title: 'Invoicing',       body: 'Branded invoices, recurring billing, time tracking, expenses - all under one money tab.' },
  { icon: 'Lock',     title: 'Card on file',    body: "Clients save a card once. Auto-charge late-cancel + no-show fees, accept tips, and never chase money again." },
  { icon: 'Heart',    title: 'Memberships',     body: 'Set up monthly tiers; clients subscribe straight from your booking page. Recurring revenue, no extra tools.' },
  { icon: 'Doc',      title: 'Documents',       body: 'Multi-signer waivers, agreements, and intake forms - clients sign with one click. PDFs land flattened with a tamper-evident audit page.' },
  { icon: 'Chat',     title: 'Messaging',       body: 'Two-way native chat between you and your clients. Prospects can ask questions before they book.' },
  { icon: 'Spark',    title: 'Ivy - AI coach',  body: 'Built-in business coach grounded in your real numbers. Every workspace is private.' },
];

// Derive the home's BuiltFor cards from the shared verticalsData so
// the home + per-vertical pages stay in sync. Each card is a clickable
// link to /for/<slug>.
const VERTICALS = Object.entries(VERTICAL_DATA).map(([slug, v]) => ({
  slug,
  icon: v.icon,
  name: capitalize(v.angle),
  line: v.homeLine || v.headline,
}));
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TESTIMONIALS = [
  {
    quote: 'I cut three subscriptions the same week. Bookings, invoices, and the AI coach all in one place - and the coach actually quotes my real numbers.',
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
    a: "No. Stripe takes their standard processing fee, that's it. Money goes from your client straight to your Stripe account - we never touch it.",
  },
  {
    q: 'Can I bring my existing clients in?',
    a: 'Yes - bulk import from a CSV, or just add their name + email. Each client gets a "claim your portal" invite automatically (totally optional for them).',
  },
  {
    q: "What's pricing going to look like?",
    a: "Start with a free trial, then one simple subscription at $39/mo - no per-seat math, no transaction fees. Early users get a meaningful discount locked in for life. The client portal is always free for clients - they never pay to use THRYVE.",
  },
  {
    q: 'Is there a mobile app?',
    a: "Yes - THRYVE is a Progressive Web App. Open the site on your phone, tap “Add to Home Screen”, and it behaves like a native app, including push notifications.",
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
    a: "Each workspace is fully isolated. Ivy can only see your numbers - never anyone else's. Same for messages, documents, payments. Nothing is sold to advertisers.",
  },
  {
    q: "Why one tool instead of best-of-breed?",
    a: "Because the friction of running a small business is the gap between tools, not the tools themselves. Booking → invoice → message → follow-up should be one fluid motion, not five tabs.",
  },
];

export default function MarketingHome() {
  const [tweaks] = useTweaks();

  // SEO meta - proper Open Graph + Twitter Card tags so links shared in
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
    document.title = 'THRYVE - the all-in-one business OS for solo entrepreneurs';
    const desc = "Clients, calendar, invoicing, messages, docs, goals, rewards, and an AI coach - all in one workspace. Built for massage therapists, stylists, trainers, coaches, and anyone running a small business solo.";
    const url  = typeof window !== 'undefined' ? window.location.origin : 'https://getthryve.ai';
    upsert('name', 'description',          desc);
    upsert('property', 'og:title',         'THRYVE - the all-in-one business OS');
    upsert('property', 'og:description',   desc);
    upsert('property', 'og:type',          'website');
    upsert('property', 'og:url',           url);
    upsert('property', 'og:site_name',     'THRYVE');
    upsert('name', 'twitter:card',         'summary_large_image');
    upsert('name', 'twitter:title',        'THRYVE - business OS for solo entrepreneurs');
    upsert('name', 'twitter:description',  desc);
    return () => cleanups.forEach((fn) => fn());
  }, []);

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)' }}>
      <Nav/>
      <Hero/>
      <ProductPreview/>
      <IvyHero/>
      <TrustStrip/>
      <Features/>
      <BuiltFor/>
      <UserCounter/>
      <Testimonials/>
      <Comparison/>
      <MobileBand/>
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
        padding: '14px 20px',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <Brand/>
        <div style={{ flex: 1 }}/>
        <a href="#features" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Features</a>
        <Link to="/pricing" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Pricing</Link>
        <a href="#compare" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Compare</a>
        <Link to="/blog" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Blog</Link>
        <a href="#faq" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>FAQ</a>
        <Link to="/signin" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 14px', fontSize: 13, color: 'var(--fg-2)' }}>
          Sign in
        </Link>
        <Link to="/signup" className="btn btn-primary marketing-nav-secondary"
          style={{ padding: '8px 14px', fontSize: 13 }}>
          Get started
        </Link>
        <MarketingMobileMenu extra={[
          { label: 'Features', href: '#features' },
          { label: 'Compare',  href: '#compare' },
          { label: 'FAQ',      href: '#faq' },
        ]}/>
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
        - all inside one workspace that stays yours. No bouncing between five apps,
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
        No credit card required · Free trial
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Product preview - CSS-only mockup framed in a fake browser chrome.
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
            getthryve.ai/dashboard
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
                  Sarah hasn't booked in 3 weeks - usually weekly. Want me to send a check-in?
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
// IvyHero - Ivy is THRYVE's most defensible 2026 differentiator: an AI
// that doesn't just answer questions, it takes ACTIONS against the
// owner's business (send invoice, message a quiet client, book a slot).
// We promote it out of the 8-tile feature grid into its own band so
// the value lands before the visitor scrolls into "yet another CRM."
// The chat-style mockup is pure CSS - no real assets needed, no flash
// of unloaded content, and it animates a single owner question into a
// real-looking Ivy response with an inline chart and action chip.
// ──────────────────────────────────────────────────────────────────────

function IvyHero() {
  const messages = React.useMemo(() => [
    { who: 'owner', text: "How much did I make from massage clients in March?" },
    { who: 'ivy',   text: "$4,820 across 56 sessions - up 22% over February. Want me to message the 8 clients who haven't rebooked yet?" },
    { who: 'owner', text: "Yes, send the soft check-in template." },
    { who: 'ivy',   text: "Done. 8 messages sent. I'll let you know when they reply.",
                    action: 'Sent · queued follow-ups for 7 days' },
  ], []);
  const [shown, setShown] = React.useState(1);
  React.useEffect(() => {
    if (shown >= messages.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 1100);
    return () => clearTimeout(t);
  }, [shown, messages.length]);

  return (
    <section style={{
      maxWidth: 1100, margin: '0 auto', padding: '40px 24px 8px',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #000) 100%)',
        color: 'var(--accent-ink)',
        borderRadius: 22, padding: 'clamp(28px, 4vw, 48px)',
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 32,
        alignItems: 'center',
      }} className="ivy-hero">
        <div>
          <div style={{
            display: 'inline-block', padding: '4px 10px', borderRadius: 99,
            background: 'rgba(0,0,0,0.18)', color: 'var(--accent-ink)',
            fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
            textTransform: 'uppercase', marginBottom: 14,
          }}>
            Native AI · only on THRYVE
          </div>
          <h2 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
            color: 'var(--accent-ink)',
          }}>
            Meet Ivy.<br/>The first business OS with an AI that <em>does</em> the work.
          </h2>
          <p style={{
            margin: '16px 0 0', fontSize: 16, lineHeight: 1.55,
            opacity: 0.85, maxWidth: 420,
          }}>
            Ivy knows your clients, your numbers, and your schedule. Ask her anything
            - and tell her to act. Send invoices, book sessions, message quiet
            clients, draft contracts. She runs on YOUR business, not a generic model.
          </p>
          <div style={{ marginTop: 22, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Link to="/signup" className="btn"
              style={{ padding: '12px 20px', fontSize: 14, fontWeight: 600,
                       background: 'var(--accent-ink)', color: 'var(--accent)',
                       borderRadius: 10 }}>
              Try Ivy free <Icons.Arrow size={13} sw={2}/>
            </Link>
            <Link to="/for/coaches" className="btn"
              style={{ padding: '12px 16px', fontSize: 14,
                       background: 'transparent', color: 'var(--accent-ink)',
                       border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10 }}>
              See it in action →
            </Link>
          </div>
        </div>
        <div style={{
          background: 'var(--surface)', color: 'var(--fg)',
          borderRadius: 16, padding: 18,
          boxShadow: '0 30px 60px -20px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', gap: 10,
          fontFamily: 'var(--font-body)', fontSize: 13.5,
          maxHeight: 360, overflow: 'hidden',
        }}>
          {messages.slice(0, shown).map((m, i) => (
            <div key={i} style={{
              alignSelf: m.who === 'owner' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: 12,
              background: m.who === 'owner' ? 'var(--surface-2)' : 'var(--accent-soft)',
              color: m.who === 'owner' ? 'var(--fg-2)' : 'var(--fg)',
              border: m.who === 'ivy' ? '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' : 'none',
              lineHeight: 1.45,
            }}>
              {m.who === 'ivy' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                              fontWeight: 600, color: 'var(--accent)',
                              marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  <Icons.Spark size={12}/> Ivy
                </div>
              )}
              {m.text}
              {m.action && (
                <div style={{
                  marginTop: 8, padding: '4px 10px', borderRadius: 99,
                  background: 'var(--accent)', color: 'var(--accent-ink)',
                  fontSize: 11, fontWeight: 600, display: 'inline-block',
                }}>{m.action}</div>
              )}
            </div>
          ))}
          {shown < messages.length && (
            <div style={{
              alignSelf: messages[shown].who === 'owner' ? 'flex-end' : 'flex-start',
              padding: '8px 14px', color: 'var(--muted)',
              fontSize: 12, fontStyle: 'italic',
            }}>typing…</div>
          )}
        </div>
      </div>
      <style>{`
        @media (max-width: 720px) {
          .ivy-hero { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  );
}

// Single-row trust strip rendered between the Ivy band and Features.
// Punchy reassurance set: payment partner, contract terms, data
// portability, etc. Reinforces "we're a real product, not a toy."
function TrustStrip() {
  const items = [
    'Stripe-verified · no transaction fees',
    'Cancel anytime · no contract',
    'Export your data any time',
    'Start with a free trial · simple $39/mo when you subscribe',
  ];
  return (
    <section style={{
      maxWidth: 1100, margin: '8px auto 0', padding: '20px 24px',
    }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center',
        fontSize: 12.5, color: 'var(--muted)',
      }}>
        {items.map((t) => (
          <div key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ color: 'var(--accent)' }}><Icons.Check size={12} sw={2.5}/></span>
            {t}
          </div>
        ))}
      </div>
    </section>
  );
}

// Live counter - pulls active-owner count from a public endpoint. Shows
// momentum on the page. Read-only, cached at the edge so this counter
// doesn't hammer the DB on every page load.
function UserCounter() {
  const [count, setCount] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    fetch('/api/public-stats')
      .then((r) => r.ok ? r.json() : null)
      .then((r) => { if (live && r) setCount(r.owners || null); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (count == null || count < 5) return null; // hide until momentum
  return (
    <section style={{
      maxWidth: 1100, margin: '0 auto', padding: '12px 24px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        Used by <strong style={{ color: 'var(--fg)' }}>{count.toLocaleString()}</strong> solo
        businesses · growing every week
      </div>
    </section>
  );
}

// Mobile band - the ICP works on phones between sessions. Promotes the
// PWA install + links to the dedicated /mobile page.
function MobileBand() {
  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 24px' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
        gap: 28, alignItems: 'center',
        padding: 'clamp(24px, 4vw, 40px)',
        borderRadius: 18,
        background: 'var(--surface)', border: '1px solid var(--border)',
      }} className="mobile-band">
        <div>
          <div className="metric-label" style={{ marginBottom: 6 }}>On your phone, between sessions</div>
          <h2 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 'clamp(24px, 3vw, 32px)', fontWeight: 500,
            letterSpacing: '-0.02em',
          }}>
            Works on every device - including the one in your pocket.
          </h2>
          <p style={{ margin: '12px 0 0', color: 'var(--fg-2)', fontSize: 14.5, lineHeight: 1.6 }}>
            Install THRYVE as a phone app in two taps. Add a client between
            massages, send an invoice from a shoot, message a client from your
            car. No store download, no separate app.
          </p>
          <Link to="/mobile" className="btn btn-outline"
            style={{ marginTop: 14, padding: '8px 14px', fontSize: 13 }}>
            See the mobile flow →
          </Link>
        </div>
        <PhoneMockup/>
      </div>
      <style>{`
        @media (max-width: 720px) {
          .mobile-band { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  );
}

function PhoneMockup() {
  return (
    <div style={{
      width: 240, height: 480, margin: '0 auto',
      borderRadius: 36, padding: 14,
      background: '#1a1a1a',
      boxShadow: '0 30px 60px -20px rgba(0,0,0,0.4)',
    }}>
      <div style={{
        height: '100%', borderRadius: 22, overflow: 'hidden',
        background: 'var(--page)', color: 'var(--fg)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '10px 14px', fontSize: 10, color: 'var(--muted)',
                      display: 'flex', justifyContent: 'space-between' }}>
          <span>9:41</span>
          <span>5G</span>
        </div>
        <div style={{ padding: '4px 14px 12px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)',
                        textTransform: 'uppercase', letterSpacing: '0.06em' }}>Today</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginTop: 4 }}>$485 earned</div>
        </div>
        {['10:00  Maya K.  · Massage', '11:30  Alex R.  · Consult', '14:00  Sam J.   · Follow-up'].map((row) => (
          <div key={row} style={{
            padding: '10px 14px', borderTop: '1px solid var(--border)',
            fontSize: 12, color: 'var(--fg-2)',
          }}>{row}</div>
        ))}
        <div style={{ marginTop: 'auto', padding: 12, borderTop: '1px solid var(--border)',
                      display: 'flex', gap: 8, fontSize: 10, color: 'var(--muted)' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>Home</div>
          <div style={{ flex: 1, textAlign: 'center' }}>Clients</div>
          <div style={{ flex: 1, textAlign: 'center', color: 'var(--accent)' }}>Today</div>
          <div style={{ flex: 1, textAlign: 'center' }}>Ivy</div>
        </div>
      </div>
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
          const Icon = Icons[f.icon] || Icons.Spark;
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
// Built for [vertical] - vertical-specific value props. Critical for SEO
// on long-tail queries like "booking software for massage therapists".
// ──────────────────────────────────────────────────────────────────────

// Wide list of service-business archetypes that THRYVE actually fits.
// Don't trim aggressively - the whole point of this section is to
// communicate "we are NOT limited to 5 verticals." Every entry is a
// real type of solo service business that books, invoices, and
// messages clients. Order is shuffled so the rotation feels random.
const ROTATING_VERTICALS = [
  'massage therapists', 'hair stylists', 'personal trainers', 'business coaches',
  'cleaners', 'dog walkers', 'pet groomers', 'yoga instructors', 'pilates teachers',
  'photographers', 'videographers', 'makeup artists', 'nail techs', 'lash artists',
  'brow artists', 'estheticians', 'tattoo artists', 'piercers', 'chiropractors',
  'acupuncturists', 'physical therapists', 'doulas', 'birth coaches', 'lactation consultants',
  'tutors', 'music teachers', 'voice coaches', 'language tutors', 'dance instructors',
  'handymen', 'electricians', 'plumbers', 'painters', 'lawn-care pros',
  'pool techs', 'locksmiths', 'mobile mechanics', 'mobile detailers', 'interior designers',
  'life coaches', 'career coaches', 'consultants', 'freelance designers', 'copywriters',
  'therapists', 'counselors', 'nutritionists', 'dietitians', 'lawyers',
  'accountants', 'real-estate agents', 'home stagers', 'event planners', 'wedding planners',
  'florists', 'caterers', 'private chefs', 'bartenders', 'DJs',
  'tour guides', 'driving instructors', 'sailing instructors', 'sports coaches', 'tennis pros',
  'golf pros', 'climbing coaches', 'martial-arts instructors', 'reiki practitioners', 'sound healers',
];

function BuiltFor() {
  return (
    <section style={{ maxWidth: 1100, margin: '0 auto', padding: '64px 24px' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="metric-label">Built for</div>
        <h2 className="page-title" style={{
          margin: '10px 0 0',
          // Stack the static prefix above the rotating word on phones so
          // the word never has to truncate, then put them inline at >=
          // small-tablet widths. clamp() keeps it readable everywhere.
          fontSize: 'clamp(28px, 5.4vw, 44px)',
          lineHeight: 1.05,
          letterSpacing: '-0.025em',
        }}>
          <span style={{ display: 'inline-block', marginRight: '0.35em' }}>Built for</span>
          <RotatingVertical/>
        </h2>
        <p style={{
          margin: '20px auto 0', maxWidth: 560,
          fontSize: 15, lineHeight: 1.55, color: 'var(--fg-2)',
        }}>
          If you take appointments, send invoices, or manage clients -
          THRYVE fits. The same tool, every solo service business.
        </p>
      </div>

      {/* Compact chip row that links to the per-vertical SEO pages. The
          big rotating word is the emotional pitch; this row is the
          "yes, we have a real page for what I do" reassurance, plus the
          long-tail SEO surface ("massage therapy software" etc.). */}
      <div style={{
        marginTop: 32,
        display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
      }}>
        {VERTICALS.map((v) => (
          <Link key={v.slug} to={`/for/${v.slug}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 999,
              background: 'var(--surface)',
              border: '1px solid var(--border-strong)',
              color: 'var(--fg-2)', textDecoration: 'none',
              fontSize: 13, fontWeight: 550,
              transition: 'border-color .15s, color .15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)';
              e.currentTarget.style.color = 'var(--accent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)';
              e.currentTarget.style.color = 'var(--fg-2)';
            }}>
            {v.name} <Icons.Arrow size={11} sw={2}/>
          </Link>
        ))}
      </div>
      <div style={{
        marginTop: 14, textAlign: 'center',
        fontSize: 12, color: 'var(--muted)',
      }}>
        Don't see your vertical? Doesn't matter - if it's a service
        business, it works.
      </div>
    </section>
  );
}

// Rotates through ROTATING_VERTICALS, swapping the visible word every
// ~2.2s. Each new word slides in from below + fades; the outgoing word
// slides up + fades. Fixed-height container so the headline never
// reflows. Honors prefers-reduced-motion: if the user has it set,
// the word still rotates (so the message lands) but without the slide.
function RotatingVertical() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setI((n) => (n + 1) % ROTATING_VERTICALS.length);
    }, 2200);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="rotating-vertical" style={{
      display: 'inline-block',
      verticalAlign: 'baseline',
      // Container height tracks the line-height of the parent. overflow
      // hidden clips the slide animation to the headline band.
      height: '1.05em',
      lineHeight: '1.05em',
      overflow: 'hidden',
      position: 'relative',
      // Min-width so very short words ("DJs") don't collapse the
      // headline width and cause it to jiggle on each swap.
      minWidth: '5ch',
    }}>
      <span key={i} className="rotating-vertical-word"
        style={{
          display: 'inline-block',
          color: 'var(--accent)',
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          whiteSpace: 'nowrap',
        }}>
        {ROTATING_VERTICALS[i]}
      </span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Testimonials. Quotes are representative of beta feedback - replace
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
// What THRYVE replaces. Job-to-be-done framing - names a category of
// tool ("your booking app", "your invoicing tool") rather than any
// specific brand, so the page stays out of comparison-disparagement
// territory and ages well as competitors come and go.
// ──────────────────────────────────────────────────────────────────────

const COMPARE_ROWS = [
  { label: 'Booking + calendar',           replaces: 'Your scheduling app' },
  { label: 'Branded invoices + Stripe payments', replaces: 'Your invoicing tool' },
  { label: 'Recurring invoicing + memberships',  replaces: 'Your subscription billing tool' },
  { label: 'Client CRM with notes & history',    replaces: 'Your spreadsheet or CRM app' },
  { label: 'E-signing + intake forms',     replaces: 'Your e-signature service' },
  { label: 'Direct messaging w/ clients',  replaces: 'Texts + email threads' },
  { label: 'Cards on file + auto-charge',  replaces: 'Manual payment chasing' },
  { label: 'Public booking site + reviews', replaces: 'Your DIY web page' },
  { label: 'Client portal (always free)',  replaces: 'Nothing - most solos don\'t have one' },
  { label: 'AI business coach (Ivy)',      replaces: 'Generic AI tool subscription' },
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
          Most solo owners pay $15-$50 a month each for half a dozen
          separate tools. THRYVE rolls every job into one system that
          actually talks to itself.
        </p>
      </div>
      {/* Card-stack layout that works on every viewport - no horizontal
          scroll on mobile (the old 3-col table overflowed at < 720px,
          forcing users to swipe sideways to see the checkmark). Each row
          shows the capability, what it replaces, and a tick. */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {COMPARE_ROWS.map((row, i) => (
          <div key={row.label} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 16px',
            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: 'var(--fg)',
                lineHeight: 1.35,
              }}>
                {row.label}
              </div>
              <div style={{
                fontSize: 12.5, color: 'var(--muted)', marginTop: 3,
                lineHeight: 1.4,
              }}>
                Replaces: {row.replaces}
              </div>
            </div>
            <div style={{
              flexShrink: 0,
              width: 28, height: 28, borderRadius: 99,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icons.Check size={14} sw={2.4} stroke="currentColor"/>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
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
          Most "all-in-one" tools are five mediocre ones bolted together.
          THRYVE started because not only have I been through this myself, but
          I watched friends running solo businesses bleed hours a week to
          context-switching between booking, invoicing, messaging, and
          follow-up - and pay for the privilege. Or even worse, they didn't
          know what tools to use to grow. The goal is one well-made tool that
          respects your data and your time. Your business, THRYVING.
        </p>
        <div style={{ marginTop: 18, fontSize: 13, color: 'var(--fg-2)' }}>
          - Kayla, founder of THRYVE
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
            Start with a free trial.
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            Use everything free on a trial, then a simple $39/mo when you subscribe -
            no per-seat math, no surprise bills. Early users get a discount locked in
            for life. The client portal stays free forever for clients.
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
        Get started - free
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid var(--border)',
      padding: '32px 24px 40px',
      marginTop: 24,
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 32, alignItems: 'flex-start',
      }}>
        <div>
          <Brand/>
          <p style={{
            margin: '14px 0 0', maxWidth: 280,
            fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5,
          }}>
            One workspace. Every part of running your business. Made for solo owners.
          </p>
        </div>
        <div>
          <div className="metric-label" style={{ marginBottom: 10 }}>Product</div>
          <FooterLinkList items={[
            { label: 'Features',  href: '#features' },
            { label: 'Compare',   href: '#compare' },
            { label: 'FAQ',       href: '#faq' },
            { label: 'Pricing',   to: '/pricing' },
          ]}/>
        </div>
        <div>
          <div className="metric-label" style={{ marginBottom: 10 }}>Company</div>
          <FooterLinkList items={[
            { label: 'About',     to: '/about' },
            { label: 'Privacy',   to: '/privacy' },
            { label: 'Terms',     to: '/terms' },
            { label: 'Sign in',   to: '/signin' },
          ]}/>
        </div>
        <div>
          <div className="metric-label" style={{ marginBottom: 10 }}>Stay close</div>
          <p style={{
            margin: '0 0 10px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5,
          }}>
            Short, weekly notes for solo founders. No spam. Unsubscribe with one click.
          </p>
          <NewsletterSignup source="home"/>
        </div>
      </div>
      <div style={{
        maxWidth: 1100, margin: '32px auto 0', paddingTop: 16,
        borderTop: '1px solid var(--border)',
        fontSize: 11, color: 'var(--muted-2)', textAlign: 'center',
      }}>
        © {new Date().getFullYear()} THRYVE Business OS.
      </div>
    </footer>
  );
}

function FooterLinkList({ items }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it) => (
        <li key={it.label}>
          {it.to ? (
            <Link to={it.to} style={{ color: 'var(--fg-2)', textDecoration: 'none', fontSize: 13 }}>
              {it.label}
            </Link>
          ) : (
            <a href={it.href} style={{ color: 'var(--fg-2)', textDecoration: 'none', fontSize: 13 }}>
              {it.label}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

// Tiny inline newsletter form. Posts to /api/newsletter, optimistic
// success state, never shows "you're already subscribed" (we treat
// duplicates as success to avoid being a subscription-checking oracle).
export function NewsletterSignup({ source }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await api.post('/newsletter', { email: email.trim().toLowerCase(), source });
      setDone(true);
    } catch (ex) {
      setErr(ex.message || 'Could not subscribe.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{
        padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
        background: 'color-mix(in srgb, var(--ok) 10%, transparent)',
        color: 'var(--ok)', border: '1px solid var(--ok)',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        <Icons.Check size={12} sw={2.4}/> You're on the list.
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com"
        style={{
          flex: 1, minWidth: 140, padding: '8px 10px', borderRadius: 8,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          fontSize: 13, color: 'var(--fg)', outline: 'none',
        }}/>
      <button type="submit" disabled={busy || !email.trim()} className="btn btn-primary"
        style={{ padding: '8px 12px', fontSize: 12.5 }}>
        {busy ? '…' : 'Subscribe'}
      </button>
      {err && <div style={{ fontSize: 11, color: 'var(--danger)', flexBasis: '100%' }}>{err}</div>}
    </form>
  );
}

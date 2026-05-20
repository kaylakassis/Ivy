// /pricing - the page that turns "interested visitor" into "signed-up
// owner." Every competitor publishes prices; without one we lose people
// to comparison-shop bounce. Three sections do the work:
//   1. tier table - what's included at each price
//   2. ROI calculator - show the savings live (RoiCalculator.jsx)
//   3. comparison vs the stack - visual reinforcement
//   4. FAQ specific to pricing concerns
//
// Edit the TIERS array and the FAQ array to update copy. Everything
// else is layout.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import RoiCalculator, { TOOL_STACK, STACK_TOTAL, THRYVE_PRICE } from './RoiCalculator.jsx';

const TIERS = [
  {
    id: 'solo',
    name: 'Solo',
    sub: 'For one person running their own book',
    priceBeta: 'Free during beta',
    priceGA: `$${THRYVE_PRICE} / month`,
    cta: 'Start free',
    ctaTo: '/signup',
    featured: false,
    features: [
      'Unlimited clients + pipeline',
      'Online booking + calendar sync',
      'Branded invoices + recurring billing',
      'Card on file + auto-charges',
      'Memberships + packages',
      'Documents + e-signature',
      'Two-way client messaging',
      'Free client portal',
      'Website builder + custom domain',
      'Workflows + automated reminders',
      'Goals + finance dashboard',
      'Reviews + rewards',
      'Ivy AI coach (chat + actions)',
      'Stripe payments (no transaction fee)',
      'Email support',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    sub: 'For 2-5 person teams sharing one workspace',
    priceBeta: 'Free during beta',
    priceGA: '$79 / month',
    cta: 'Start free',
    ctaTo: '/signup',
    featured: true,
    features: [
      'Everything in Solo, plus:',
      'Multi-staff scheduling',
      'Per-staff calendar + availability',
      'Per-staff commissions + payouts',
      'Shared client database',
      'Role-based permissions',
      'Branded emails (remove "powered by")',
      'Priority support (live chat)',
      'Unlimited custom domains',
      'Up to 5 staff seats included',
    ],
  },
  {
    id: 'enterprise',
    name: 'Multi-location',
    sub: 'For owners running multiple locations',
    priceBeta: 'Talk to us',
    priceGA: 'Custom',
    cta: 'Get in touch',
    ctaTo: 'mailto:hello@getthryve.ai?subject=THRYVE%20Multi-location',
    featured: false,
    features: [
      'Everything in Studio, plus:',
      'Multi-location admin console',
      'Cross-location reporting',
      'White-label option',
      'Dedicated onboarding manager',
      'SLA + bespoke contracts',
      'Custom integrations',
    ],
  },
];

const FAQ = [
  {
    q: 'What happens to my price after beta?',
    a: `Early beta users get a meaningful discount locked in for life. We'll publish exact details before we leave beta, and you'll have time to opt in or out. Worst case: $${THRYVE_PRICE}/mo Solo or $79/mo Studio.`,
  },
  {
    q: 'Do you take a cut of my payments?',
    a: "No. Ever. Stripe is your processor (you connect your own account); we never touch your money. You pay Stripe's standard ~2.9%+30¢ - same as on Stripe directly. THRYVE adds zero markup.",
  },
  {
    q: 'Per-client or per-seat fees?',
    a: 'No per-client fees, no per-booking fees, no per-invoice fees. Solo is one user. Studio includes 5 seats; additional seats are $9/mo each.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. No contract, no notice period. Cancel from your account page - your data stays accessible for 60 days for export, then is deleted.',
  },
  {
    q: 'Do you offer annual discounts?',
    a: 'Yes - pay annually and get 2 months free (effectively a 16% discount). Available once we leave beta.',
  },
  {
    q: 'Is there a free trial?',
    a: 'During beta the whole product is free. After GA, Solo will have a 14-day full-feature trial - no card required.',
  },
  {
    q: "What if I'm switching from another tool?",
    a: "We'll import your client list and booking history for free. Send a CSV, or share read-only access to your current tool, and we'll move it. Usually done within a business day.",
  },
  {
    q: 'Do you store my client data securely?',
    a: 'All data is encrypted at rest and in transit. Hosted on Vercel + Neon (US-based, SOC2 vendors). Stripe handles all payment info - we never see card numbers. Full data export available anytime from your account page.',
  },
];

export default function PricingPage() {
  useEffect(() => {
    document.title = 'Pricing - THRYVE';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', `One subscription. Every tool you'd otherwise piece together. Free during beta, then $${THRYVE_PRICE}/mo Solo or $79/mo Studio.`);
  }, []);

  return (
    <MarketingShell>
      <SimpleNav/>
      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px 64px' }}>

        {/* Hero */}
        <section style={{ textAlign: 'center', maxWidth: 760, margin: '0 auto 56px' }}>
          <div style={{
            display: 'inline-block', padding: '4px 12px', borderRadius: 99,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
            textTransform: 'uppercase', marginBottom: 16,
          }}>
            One price. Every tool you'd otherwise piece together.
          </div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--font-display)',
            fontSize: 'clamp(36px, 5vw, 56px)', fontWeight: 500,
            letterSpacing: '-0.025em', lineHeight: 1.1,
          }}>
            Simple pricing.<br/>No transaction fees, no per-seat math.
          </h1>
          <p style={{
            margin: '16px auto 0', maxWidth: 560,
            fontSize: 17, lineHeight: 1.55, color: 'var(--fg-2)',
          }}>
            Replace your full stack - CRM, scheduler, invoicing, contracts, website,
            email, AI - with one subscription. Free during beta; locked-in pricing
            after.
          </p>
        </section>

        {/* Tier table */}
        <section style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16,
          marginBottom: 64,
        }}>
          {TIERS.map((t) => (
            <div key={t.id} style={{
              padding: '28px 24px',
              borderRadius: 16,
              background: t.featured ? 'var(--accent)' : 'var(--surface)',
              color: t.featured ? 'var(--accent-ink)' : 'var(--fg)',
              border: `2px solid ${t.featured ? 'var(--accent)' : 'var(--border)'}`,
              boxShadow: t.featured ? '0 20px 40px -20px rgba(0,0,0,0.2)' : 'none',
              transform: t.featured ? 'translateY(-4px)' : 'none',
              display: 'flex', flexDirection: 'column', gap: 16,
            }}>
              {t.featured && (
                <div style={{
                  fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--accent-ink)', opacity: 0.7,
                }}>Most popular</div>
              )}
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontSize: 13, opacity: 0.75, marginTop: 4 }}>{t.sub}</div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 600, lineHeight: 1 }}>
                  {t.priceBeta}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                  {t.priceGA} when out of beta
                </div>
              </div>
              <Link to={t.ctaTo} className="btn btn-primary"
                style={{
                  padding: '12px 16px',
                  textAlign: 'center', fontWeight: 600,
                  background: t.featured ? 'var(--accent-ink)' : 'var(--accent)',
                  color:      t.featured ? 'var(--accent)' : 'var(--accent-ink)',
                }}>
                {t.cta} <Icons.Arrow size={14} sw={2}/>
              </Link>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {t.features.map((f, i) => (
                  <li key={i} style={{ display: 'flex', gap: 10, fontSize: 13.5, lineHeight: 1.45 }}>
                    <span style={{ flexShrink: 0, marginTop: 3, opacity: 0.7 }}>
                      <Icons.Check size={13} sw={2.5}/>
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        {/* ROI calculator */}
        <section style={{ marginBottom: 64 }}>
          <RoiCalculator/>
        </section>

        {/* Stack comparison */}
        <section style={{ marginBottom: 64 }}>
          <h2 style={{
            margin: '0 0 8px', fontFamily: 'var(--font-display)',
            fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em',
          }}>
            Replace ${STACK_TOTAL}/mo of stitched-together SaaS
          </h2>
          <p style={{ margin: '0 0 24px', color: 'var(--fg-2)', fontSize: 15 }}>
            The tools most solo businesses end up running in parallel. THRYVE
            does each of these - and then makes them talk to each other so the
            booking → invoice → message → follow-up is one fluid motion.
          </p>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 10,
            border: '1px solid var(--border)', borderRadius: 12,
            background: 'var(--surface)', padding: 18,
          }}>
            {TOOL_STACK.map((t) => (
              <div key={t.name} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</span>
                  <span style={{ fontSize: 13, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>${t.monthly}/mo</span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t.replaces}</span>
              </div>
            ))}
            <div style={{
              gridColumn: '1 / -1', marginTop: 8, padding: 14,
              borderTop: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-2)' }}>Total replaced</span>
              <span style={{
                fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600,
                color: 'var(--accent)', fontVariantNumeric: 'tabular-nums',
              }}>${STACK_TOTAL}/mo → ${THRYVE_PRICE}/mo</span>
            </div>
          </div>
        </section>

        {/* Trust panel */}
        <section style={{
          marginBottom: 64, padding: 24,
          background: 'var(--surface-2)', borderRadius: 16,
          border: '1px solid var(--border)',
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 18, textAlign: 'center',
          }}>
            {[
              { icon: 'Check',  label: 'Stripe-verified partner', sub: 'Your money goes straight to your Stripe - we never touch it.' },
              { icon: 'X',      label: 'Cancel anytime',          sub: 'No contracts, no notice period. Cancel from account page.' },
              { icon: 'Doc',    label: 'Export your data',        sub: 'Download everything any time. Your data stays yours.' },
              { icon: 'Heart',  label: 'No transaction fees',     sub: "You only pay Stripe's standard processing rate." },
            ].map((t) => {
              const Icon = Icons[t.icon] || Icons.Check;
              return (
                <div key={t.label}>
                  <Icon size={20} sw={1.6} style={{ color: 'var(--accent)' }}/>
                  <div style={{ marginTop: 8, fontSize: 14, fontWeight: 600 }}>{t.label}</div>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{t.sub}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* FAQ */}
        <section style={{ maxWidth: 800, margin: '0 auto' }}>
          <h2 style={{
            margin: '0 0 18px', fontFamily: 'var(--font-display)',
            fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em',
            textAlign: 'center',
          }}>
            Pricing questions
          </h2>
          {FAQ.map((item) => (
            <details key={item.q} style={{
              borderBottom: '1px solid var(--border)', padding: '14px 4px',
            }}>
              <summary style={{
                cursor: 'pointer', fontWeight: 600, fontSize: 15.5,
                color: 'var(--fg)', listStyle: 'none',
              }}>
                {item.q}
              </summary>
              <p style={{ margin: '10px 0 0', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
                {item.a}
              </p>
            </details>
          ))}
        </section>

        {/* Final CTA */}
        <section style={{ textAlign: 'center', marginTop: 64 }}>
          <Link to="/signup" className="btn btn-primary"
            style={{ padding: '14px 28px', fontSize: 15, fontWeight: 600 }}>
            Start free <Icons.Arrow size={14} sw={2}/>
          </Link>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
            No credit card required · Free during beta
          </div>
        </section>

      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

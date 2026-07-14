// /pricing - the page that turns "interested visitor" into "signed-up
// owner." Every competitor publishes prices; without one we lose people
// to comparison-shop bounce. Sections:
//   1. single plan card - one subscription, two states (free trial now,
//      "Active" once paid). We don't sell team/multi-location tiers
//      yet because they aren't supported.
//   2. ROI calculator - show the savings live (RoiCalculator.jsx)
//   3. comparison vs the stack - visual reinforcement
//   4. FAQ specific to pricing concerns
//
// Edit the PLAN object and the FAQ array to update copy. Everything
// else is layout.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import MarketingShell, { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import RoiCalculator from './RoiCalculator.jsx';
import { TOOL_STACK, STACK_TOTAL, IVY_PRICE, TRIAL_DAYS, IVY_PRICE_ANNUAL, ANNUAL_SAVINGS_PCT } from '../../lib/pricing.js';

// One plan, two states: a free trial while we're in beta, then a
// single paid subscription ("Active") at $8.99 every week. We
// deliberately don't sell team / multi-location tiers yet because they
// aren't supported - one honest plan beats three aspirational ones.
const PLAN = {
  name: 'Ivy',
  sub: 'Everything to run your business, in one place.',
  priceBeta: `${TRIAL_DAYS} days free`,
  priceGA: `$${IVY_PRICE} / week`,
  cta: `Start your ${TRIAL_DAYS}-day free trial`,
  ctaTo: '/signup',
  features: [
    'Unlimited clients + pipeline',
    'Online booking + calendar sync',
    'Branded invoices + recurring billing',
    'Card on file + auto-charges',
    'Memberships, packages & gift cards',
    'In-person sales - Tap to Pay on iPhone/Android',
    'Documents + e-signature',
    'Two-way client messaging',
    'Free client portal',
    'Website builder + custom domain',
    'Workflows + automated reminders',
    'Goals + finance dashboard',
    'Reviews + rewards',
    'Ivy AI assistant (chat + actions, personalized to you)',
    'Stripe payments (no transaction fee)',
    'Email support',
  ],
};

const FAQ = [
  {
    q: 'How much does Ivy cost?',
    a: `One simple subscription after your ${TRIAL_DAYS}-day free trial: $${IVY_PRICE}/week, or $${IVY_PRICE_ANNUAL}/yr billed annually (save about ${ANNUAL_SAVINGS_PCT}%). No per-seat math, no transaction fees. Early users get a meaningful discount locked in for life.`,
  },
  {
    q: 'Do you take a cut of my payments?',
    a: "No. Ever. Stripe is your processor (you connect your own account); we never touch your money. You pay Stripe's standard ~2.9%+30¢ - same as on Stripe directly. Ivy adds zero markup.",
  },
  {
    q: 'Per-client or per-seat fees?',
    a: 'No per-client fees, no per-booking fees, no per-invoice fees. One flat subscription covers your whole business.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. No contract, no notice period. Cancel from your account page - your data stays accessible for 60 days for export, then is deleted.',
  },
  {
    q: 'Is there a free trial?',
    a: `Yes. ${TRIAL_DAYS} days, the whole product unlocked. You add a card to start - $0 charged today - and you're not billed until the trial ends, so cancel anytime before then and you'll never pay a cent. Early users lock in a discount for life.`,
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
    document.title = 'Pricing - Ivy';
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', `One subscription. Every tool you'd otherwise piece together. ${TRIAL_DAYS}-day free trial, $0 today. Then $${IVY_PRICE} every week.`);
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
            email, AI - with one subscription. {TRIAL_DAYS}-day free trial, $0 today.
            Then a simple ${IVY_PRICE}/week when you're ready.
          </p>
        </section>

        {/* Two states: free trial, then "Active" (paid subscriber). */}
        <section style={{
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          gap: 12, marginBottom: 28, flexWrap: 'wrap',
        }}>
          <StateChip label={`${TRIAL_DAYS} days free`} sub="the whole product, $0 today" active/>
          <Icons.Arrow size={16} sw={2} style={{ color: 'var(--muted)' }}/>
          <StateChip label="Active" sub={`$${IVY_PRICE}/week when subscribed`}/>
        </section>

        {/* Single plan card */}
        <section style={{
          maxWidth: 460, margin: '0 auto 64px',
        }}>
          <div style={{
            padding: '32px 28px',
            borderRadius: 18,
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            border: '2px solid var(--accent)',
            boxShadow: '0 24px 48px -24px rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: 'column', gap: 18,
          }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 600 }}>{PLAN.name}</div>
              <div style={{ fontSize: 13.5, opacity: 0.75, marginTop: 4 }}>{PLAN.sub}</div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, fontWeight: 600, lineHeight: 1 }}>
                {PLAN.priceBeta}
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 6 }}>
                then {PLAN.priceGA} once you subscribe. No per-seat math, no transaction fees.
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                Or save with annual - <strong>${IVY_PRICE_ANNUAL}/yr</strong> (save about {ANNUAL_SAVINGS_PCT}%).
              </div>
            </div>
            <Link to={PLAN.ctaTo} className="btn btn-primary"
              style={{
                padding: '13px 16px',
                textAlign: 'center', fontWeight: 600,
                background: 'var(--accent-ink)', color: 'var(--accent)',
              }}>
              {PLAN.cta} <Icons.Arrow size={14} sw={2}/>
            </Link>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {PLAN.features.map((f, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, fontSize: 13.5, lineHeight: 1.45 }}>
                  <span style={{ flexShrink: 0, marginTop: 3, opacity: 0.7 }}>
                    <Icons.Check size={13} sw={2.5}/>
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
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
            Save $100+/mo on average — replace ${STACK_TOTAL}/mo of stitched-together SaaS
          </h2>
          <p style={{ margin: '0 0 24px', color: 'var(--fg-2)', fontSize: 15 }}>
            The tools most solo businesses end up running in parallel. Ivy
            does each of these - and then makes them talk to each other so the
            booking → invoice → message → follow-up is one fluid motion.
          </p>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
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
              }}>${STACK_TOTAL}/mo → ${IVY_PRICE}/week</span>
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
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
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
            Start your {TRIAL_DAYS}-day free trial <Icons.Arrow size={14} sw={2}/>
          </Link>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
            $0 today · Cancel anytime
          </div>
        </section>

      </main>
      <SimpleFooter/>
    </MarketingShell>
  );
}

// Pill showing the two account states: a free trial during beta, then
// "Active" (a paid subscriber). The active one gets the accent fill.
function StateChip({ label, sub, active }) {
  return (
    <div style={{
      padding: '10px 18px', borderRadius: 999, textAlign: 'center',
      background: active ? 'var(--accent)' : 'var(--surface)',
      color: active ? 'var(--accent-ink)' : 'var(--fg)',
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
      <div style={{ fontSize: 11.5, opacity: 0.75, marginTop: 1 }}>{sub}</div>
    </div>
  );
}

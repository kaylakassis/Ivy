// /about - long-form founder + mission page. The marketing home has a
// short FounderNote already; this is for visitors who want depth before
// signing up.
//
// Edit the BLOCKS array to update copy. Each block is a section with
// kicker + heading + paragraph(s). Keeps the visual rhythm consistent.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { SimpleNav, SimpleFooter } from './MarketingShell.jsx';
import { TRIAL_DAYS } from '../../lib/pricing.js';

const BLOCKS = [
  {
    kicker: 'The problem',
    heading: 'Solo owners pay for tools, not a system.',
    paragraphs: [
      "Most one-person businesses run their operation on five or six tools - one for booking, one for invoicing, another for payments, another for email, a spreadsheet or note app for the CRM, plus an AI tool on top. Each one charges $15-$50 a month. Each one has its own login, its own UI, and its own gaps.",
      "The friction isn't in any single tool - it's in the seams between them. The booking lands in one app. The invoice goes out from another. The follow-up message gets typed in your texts. None of them know about each other, so the owner glues them together with copy-paste and memory.",
    ],
  },
  {
    kicker: 'The shape',
    heading: "What Ivy OS actually is.",
    paragraphs: [
      "One workspace where every part of the business lives. Bookings know about clients. Clients know about invoices. Invoices know about payments. Payments know about the AI coach. The coach knows about everything and can quietly nudge - \"Sarah hasn't booked in three weeks; want me to send a check-in?\"",
      "Every workspace is fully isolated. Your numbers, your messages, your clients are yours. The AI coach can only see your data - never anyone else's. You can export everything as JSON any time and walk away if it isn't working.",
    ],
  },
  {
    kicker: 'The shape (cont.)',
    heading: 'Built so the client portal is free, forever.',
    paragraphs: [
      "Your clients shouldn't have to pay to interact with you. The portal - where they see their bookings, invoices, signed forms, and messages - is free for them and always will be. They sign up once and use the same portal across every business they work with on Ivy OS.",
      `When Ivy OS charges, it charges the business owner only - one simple subscription after a ${TRIAL_DAYS}-day free trial. Early users get a meaningful discount locked in for life. No surprise bills, no rugpulls.`,
    ],
  },
  {
    kicker: 'The bet',
    heading: 'AI is a coach, not a chatbot.',
    paragraphs: [
      "Ivy is built into Ivy OS because the coach matters more than the AI. She sees your real numbers - revenue this month, active clients, who's gone quiet, what's overdue - and answers in plain English with specific actions. Not \"consider engaging your top customers\" but \"send Sarah a check-in; she's 22 days quiet.\"",
      "She has tools. Tell her to draft a thank-you to a client who just paid and send it through the portal - she'll do all of it. The chat box is a deliberately small surface area for what's actually a working assistant.",
    ],
  },
  {
    kicker: 'The team',
    heading: "Small, on purpose.",
    paragraphs: [
      "Ivy OS is built by a business owner, for business owners. We answer support emails personally. We read every reply to every email we send. If you've used software where you couldn't reach a human and felt like your business was running someone else's roadmap, that's the opposite of what we want Ivy OS to be.",
      "Find us in /account → Help → Contact support. Or reply to any email we send you. Every message hits a real inbox.",
    ],
  },
];

export default function AboutPage() {
  const [tweaks] = useTweaks();

  useEffect(() => {
    document.title = 'About Ivy OS - the all-in-one business platform';
    const upsert = (attr, key, value) => {
      let el = document.querySelector(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute('content', value);
    };
    upsert('name', 'description', "Why Ivy OS exists, what it actually is, and who's behind it. The all-in-one business platform for solo entrepreneurs.");
    upsert('property', 'og:title', 'About Ivy OS');
    upsert('property', 'og:description', "Why Ivy OS exists, what it actually is, and who's behind it.");
  }, []);

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{ minHeight: '100vh', background: 'var(--page)' }}>
      <SimpleNav/>

      <section style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px 24px' }}>
        <div className="metric-label" style={{ color: 'var(--accent)' }}>About</div>
        <h1 className="page-title" style={{ margin: '8px 0 16px', fontSize: 'clamp(32px, 5vw, 44px)', lineHeight: 1.1 }}>
          One tool, made well, that respects your data and your time.
        </h1>
        <p style={{
          margin: 0, fontSize: 17, color: 'var(--fg-2)', lineHeight: 1.6,
        }}>
          Most "all-in-one" tools are five mediocre ones bolted together with a
          shared logo. Ivy OS is the opposite bet: one workspace where booking,
          invoicing, messaging, documents, and AI coaching share the same
          memory.
        </p>
      </section>

      {BLOCKS.map((b, i) => (
        <section key={i} style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px' }}>
          <div className="metric-label" style={{ color: 'var(--accent)' }}>{b.kicker}</div>
          <h2 className="page-title" style={{ margin: '8px 0 14px', fontSize: 26, lineHeight: 1.2 }}>
            {b.heading}
          </h2>
          {b.paragraphs.map((p, j) => (
            <p key={j} style={{
              margin: '0 0 14px', fontSize: 15.5, color: 'var(--fg-2)', lineHeight: 1.7,
            }}>
              {p}
            </p>
          ))}
        </section>
      ))}

      <section style={{ maxWidth: 720, margin: '40px auto 0', padding: '0 24px 80px' }}>
        <div className="card" style={{
          padding: 28,
          background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
          border: '1px solid var(--accent)',
        }}>
          <h3 className="page-title" style={{ margin: '0 0 8px', fontSize: 22 }}>
            Try it.
          </h3>
          <p style={{ margin: '0 0 18px', fontSize: 14.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            {TRIAL_DAYS} days free, $0 today, three minutes to set up.
            Bring one client in. See if it feels different.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link to="/signup" className="btn btn-primary"
              style={{ padding: '12px 20px', fontSize: 14 }}>
              Start your {TRIAL_DAYS}-day free trial <Icons.Arrow size={13} sw={2}/>
            </Link>
            <Link to="/pricing" className="btn btn-outline"
              style={{ padding: '12px 20px', fontSize: 14 }}>
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <SimpleFooter/>
    </div>
  );
}

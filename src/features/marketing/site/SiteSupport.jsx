// Public support page.
//
// Exists for two audiences. Real users who need help and have no other
// obvious front door, and Apple's App Store reviewer: guideline 1.5
// requires the Support URL in App Store Connect to resolve to a page
// carrying actual support information. Pointing that field at the
// marketing home page is a documented rejection cause, so this page is
// what https://joinivy.ai/support serves.
//
// Everything stated here is checked against the app: support@joinivy.ai
// is the address already used elsewhere in the product, in-app support
// lives at /account?support=1 (the sidebar's "Help & support"), export
// and delete both live on /account, and payouts run through the
// owner's own Stripe, Square or PayPal account.
import React from 'react';
import { SiteNav, SiteFooter, StickyCta, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome';

const PAGE_CSS = `
.site-root .narrow{max-width:760px;margin:0 auto}
.site-root h1{font-size:clamp(34px,4.4vw,52px);letter-spacing:-.025em;line-height:1.12;margin-bottom:18px}
.site-root h2{font-size:clamp(22px,2.6vw,28px);letter-spacing:-.02em;margin-bottom:20px}
.site-root .page-head{padding:160px 0 48px;position:relative;text-align:center}
.site-root .page-head::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:550px;background:radial-gradient(ellipse,rgba(207,255,80,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lede{font-size:18px;color:var(--muted);max-width:620px;margin:0 auto}
.site-root section{padding:48px 0}
.site-root .contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.site-root .contact-card{background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:28px;display:flex;flex-direction:column}
.site-root .contact-card .icon{width:40px;height:40px;border-radius:10px;background:var(--tint);border:1px solid rgba(207,255,80,.25);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:16px}
.site-root .contact-card h3{font-size:17px;font-weight:600;margin-bottom:8px}
.site-root .contact-card p{font-size:14.5px;color:var(--muted);margin-bottom:16px;flex:1 1 auto}
.site-root .contact-card a.mail{font-size:16px;font-weight:600;color:var(--lime);text-decoration:none;word-break:break-all}
.site-root .contact-card a.mail:hover{text-decoration:underline}
.site-root .response{font-size:14.5px;color:var(--muted);border:1px solid var(--border);border-radius:12px;padding:18px 20px;background:var(--bg)}
.site-root .response b{color:var(--text);font-weight:600}
.site-root .faq{border-top:1px solid var(--border)}
.site-root .faq-item{padding:24px 0;border-bottom:1px solid var(--border)}
.site-root .faq-item h3{font-size:16.5px;font-weight:600;margin-bottom:8px}
.site-root .faq-item p{font-size:15px;color:var(--muted);margin:0}
.site-root .faq-item p + p{margin-top:10px}
.site-root .faq-item a{color:var(--lime);text-decoration:none}
.site-root .faq-item a:hover{text-decoration:underline}
.site-root .legal-row{display:flex;flex-wrap:wrap;gap:22px;justify-content:center;font-size:14.5px;padding-top:8px}
.site-root .legal-row a{color:var(--muted);text-decoration:none}
.site-root .legal-row a:hover{color:var(--text)}
@media(max-width:820px){.site-root .contact-grid{grid-template-columns:1fr}}
`;

// One place to edit the questions. Answers stay short and concrete so
// the page is genuinely usable rather than reassuring-sounding filler.
const FAQ = [
  {
    q: 'How does the free trial work?',
    a: ['Every account starts with a 14 day free trial with everything unlocked. Nothing is charged until the trial ends, and you can cancel any time before then without paying.'],
  },
  {
    q: 'How do I cancel my subscription?',
    a: ['If you subscribed on iPhone, cancel in your Apple ID settings under Subscriptions. Apple handles billing for in-app purchases, so cancellations have to happen there.',
        'If you subscribed on the web, open Account, then Billing, then Manage billing.'],
  },
  {
    q: 'Can I get my data out?',
    a: ['Yes, at any time and without asking us. Open Account, then Export, and you get everything as a JSON file: clients, bookings, invoices, documents and messages. This works even if your subscription has lapsed.'],
  },
  {
    q: 'How do I delete my account?',
    a: ['Open Account, then Delete account. Export your data first if you want a copy, because deletion is permanent.'],
  },
  {
    q: 'How do I get paid by my clients?',
    a: ['Connect your own Stripe, Square or PayPal account under Finance. Client payments go straight to your account, not through us, and payouts follow whatever schedule your processor uses.'],
  },
  {
    q: 'Do my clients have to pay for anything?',
    a: ['No. The client portal is free for them, always. They can see their bookings, invoices, documents and messages from you without ever paying us or subscribing to anything.'],
  },
  {
    q: 'I forgot my password.',
    a: ['Use the reset link on the sign in page and we will email you a way back in. If the email does not arrive within a few minutes, check spam, then write to us.'],
  },
  {
    q: 'Who can see my business data?',
    a: ['Only you. Every workspace is isolated from every other one, and the AI assistant can only ever read your workspace. See the security page for how that is enforced.'],
  },
];

export default function SiteSupport() {
  useSiteFonts();
  usePageMeta({
    title: 'Support | Ivy',
    description: 'Get help with Ivy. Email support@joinivy.ai or use Help and support inside the app. Answers to common questions about trials, billing, cancelling, data export and account deletion.',
    canonical: 'https://joinivy.ai/support',
  });

  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <SiteNav active="/support" />

      <header className="page-head">
        <div className="container">
          <span className="eyebrow">Support</span>
          <h1>Stuck on something?</h1>
          <p className="lede">You are talking to the people who build Ivy, not a ticket queue. Write to us and you will get a real answer.</p>
        </div>
      </header>

      <section style={{ paddingTop: 0 }}>
        <div className="container narrow">
          <div className="contact-grid">
            <div className="contact-card">
              <div className="icon" aria-hidden="true">✉</div>
              <h3>Email us</h3>
              <p>The fastest way to reach us, whether or not you have an account. Tell us what you were doing and what happened.</p>
              <a className="mail" href="mailto:support@joinivy.ai">support@joinivy.ai</a>
            </div>
            <div className="contact-card">
              <div className="icon" aria-hidden="true">💬</div>
              <h3>From inside Ivy</h3>
              <p>Already signed in? Open Help and support in the sidebar to start a conversation with us without leaving the app.</p>
              <a className="mail" href="/account?support=1">Open Help and support</a>
            </div>
          </div>
          <p className="response">
            <b>What to expect.</b> We answer every message, usually within one business day.
            If something is broken and blocking your work, say so in the subject line and we will
            treat it that way.
          </p>
        </div>
      </section>

      <section style={{ paddingTop: 8 }}>
        <div className="container narrow">
          <h2>Common questions</h2>
          <div className="faq">
            {FAQ.map((item) => (
              <div className="faq-item" key={item.q}>
                <h3>{item.q}</h3>
                {item.a.map((para, i) => <p key={i}>{para}</p>)}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ paddingTop: 8 }}>
        <div className="container narrow">
          <div className="legal-row">
            <a href="/security">Security</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Use</a>
            <a href="/pricing">Pricing</a>
          </div>
        </div>
      </section>

      <StickyCta />
      <SiteFooter />
    </div>
  );
}

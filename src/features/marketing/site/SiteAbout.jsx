// About page, ported pixel-faithfully from the static about.html prototype.
import React from 'react';
import { SiteNav, SiteFooter, StickyCta, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome';

const PAGE_CSS = `
.site-root{scroll-behavior:smooth}
.site-root .narrow{max-width:720px;margin:0 auto}
.site-root h1{font-size:clamp(34px,4.4vw,52px);letter-spacing:-.025em;line-height:1.12;margin-bottom:18px}
.site-root h2{font-size:clamp(24px,3vw,32px);letter-spacing:-.02em;margin-bottom:14px}
.site-root .k-label{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--lime);margin-bottom:12px}
.site-root .page-head{padding:160px 0 56px;position:relative;text-align:center}
.site-root .page-head::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:550px;background:radial-gradient(ellipse,rgba(207,255,80,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lede{font-size:18px;color:var(--muted);max-width:660px;margin:0 auto}
.site-root section{padding:56px 0}
.site-root .block{padding:48px 0;border-bottom:1px solid var(--border)}
.site-root .block:last-child{border-bottom:none}
.site-root .block p{font-size:16.5px;color:var(--muted);margin-bottom:18px;max-width:720px}
.site-root .block p:last-child{margin-bottom:0}
.site-root .block p b{color:var(--text);font-weight:600}
.site-root .sec-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:44px;text-align:left}
.site-root .sec-card{background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:26px}
.site-root .sec-card .icon{width:40px;height:40px;border-radius:10px;background:var(--tint);border:1px solid rgba(207,255,80,.25);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:16px}
.site-root .sec-card h3{font-size:16px;font-weight:600;margin-bottom:8px}
.site-root .sec-card p{font-size:14px;color:var(--muted)}
@media(max-width:900px){.site-root .sec-grid{grid-template-columns:1fr}}
`;

export default function SiteAbout() {
  useSiteFonts();
  usePageMeta({
    title: 'About Ivy - One Tool for Solo Service Businesses | Security & Data Ownership',
    description: "Why Ivy exists: solo owners pay for tools, not a system. One workspace where booking, invoicing, messaging, documents, and AI share the same memory - with isolated workspaces, encrypted data, JSON export anytime, and a client portal that's free forever.",
    canonical: 'https://joinivy.ai/about',
  });
  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <SiteNav active="/about" />

      <header className="page-head">
        <div className="container">
          <span className="eyebrow">About</span>
          <h1>One tool, made well, that respects<br />your <span className="lime">data</span> and your <span className="lime">time</span>.</h1>
          <p className="lede">Most "all-in-one" tools are five mediocre ones bolted together with a shared logo. Ivy is the opposite bet: one workspace where booking, invoicing, messaging, documents, and AI assistance share the same memory.</p>
        </div>
      </header>

      <section style={{ paddingTop: 0 }}>
        <div className="container narrow">
          <div className="block">
            <div className="k-label">The problem</div>
            <h2>Solo owners pay for tools, not a system.</h2>
            <p>Most one-person businesses run their operation on five or six tools - one for booking, one for invoicing, another for payments, another for email, a spreadsheet or note app for the CRM, plus an AI tool on top. Each one charges $15–$50 a month. Each one has its own login, its own UI, and its own gaps.</p>
            <p>The friction isn't in any single tool - it's in <b>the seams between them</b>. The booking lands in one app. The invoice goes out from another. The follow-up message gets typed in your texts. None of them know about each other, so the owner glues them together with copy-paste and memory.</p>
          </div>
          <div className="block">
            <div className="k-label">The shape</div>
            <h2>What Ivy actually is.</h2>
            <p>One workspace where every part of the business lives. Bookings know about clients. Clients know about invoices. Invoices know about payments. Payments know about Ivy. <b>Ivy knows about everything</b> and can quietly nudge - "Sarah hasn't booked in three weeks; want me to send a check-in?"</p>
            <p>Every workspace is fully isolated. Your numbers, your messages, your clients are yours. The AI assistant can only see your data - never anyone else's. You can export everything as JSON any time and walk away if it isn't working.</p>
          </div>
          <div className="block">
            <div className="k-label">The shape (cont.)</div>
            <h2>Built so the client portal is free, forever.</h2>
            <p>Your clients shouldn't have to pay to interact with you. The portal - where they see their bookings, invoices, signed forms, and messages - is <b>free for them and always will be</b>. They sign up once and use the same portal across every business they work with on Ivy.</p>
            <p>When Ivy charges, it charges the business owner only - one simple subscription after a 14-day free trial. Early users get a meaningful discount locked in for life. No surprise bills, no rugpulls.</p>
          </div>
          <div className="block">
            <div className="k-label">The bet</div>
            <h2>AI that does the work, not a chatbot.</h2>
            <p>Ivy is built in because what she does matters more than the fact that she's AI. She sees your real numbers - revenue this month, active clients, who's gone quiet, what's overdue - and answers in plain English with specific actions. Not "consider engaging your top customers" but <b>"send Sarah a check-in; she's 22 days quiet."</b></p>
            <p>She has tools. Tell her to draft a thank-you to a client who just paid and send it through the portal - she'll do all of it. The chat box is a deliberately small surface area for what's actually a working assistant.</p>
          </div>
          <div className="block">
            <div className="k-label">The team</div>
            <h2>Small, on purpose.</h2>
            <p>Ivy is built by a business owner, for business owners. We answer support emails personally. We read every reply to every email we send. If you've used software where you couldn't reach a human and felt like your business was running someone else's roadmap, that's the opposite of what we want Ivy to be.</p>
            <p>Find us in <b>/account → Help → Contact support</b>. Or reply to any email we send you. Every message hits a real inbox.</p>
          </div>
        </div>
      </section>

      <section className="alt center" id="security">
        <div className="container">
          <span className="eyebrow">Security</span>
          <h2 style={{ fontSize: 'clamp(28px,3.4vw,38px)' }}>Your data. Your clients. Your control.</h2>
          <p className="section-sub">You're trusting Ivy with client relationships and revenue. Here's exactly how that trust is handled.</p>
          <div className="sec-grid">
            <div className="sec-card"><div className="icon">🔒</div><h3>Fully isolated workspaces</h3><p>Your numbers, messages, and clients are yours. The AI assistant can only see your data - never anyone else's. Encrypted in transit and at rest.</p></div>
            <div className="sec-card"><div className="icon">💳</div><h3>We never touch your money</h3><p>Payments go straight from your client to your own Stripe account. All card data is handled by Stripe - we never see card numbers.</p></div>
            <div className="sec-card"><div className="icon">📤</div><h3>Export everything as JSON</h3><p>Download your complete data any time and walk away if it isn't working. No hostage-taking.</p></div>
            <div className="sec-card"><div className="icon">✍️</div><h3>Legally binding signatures</h3><p>Documents are signed, stamped, and stored with a complete record - waivers, intakes, and agreements that hold up.</p></div>
          </div>
        </div>
      </section>

      <section className="center" style={{ padding: '88px 0' }}>
        <div className="container">
          <h2 style={{ fontSize: 'clamp(28px,3.4vw,38px)' }}>Try it.</h2>
          <p className="section-sub" style={{ margin: '0 auto 30px' }}>14 days free, $0 today, just a few minutes to set up. Bring one client in. See if it feels different.</p>
          <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
          <a href="/pricing" className="btn btn-ghost" style={{ marginLeft: 10 }}>See pricing</a>
          <p className="trust" style={{ marginTop: 14 }}>$0 today · Cancel anytime</p>
        </div>
      </section>

      <SiteFooter />
      <StickyCta />
    </div>
  );
}

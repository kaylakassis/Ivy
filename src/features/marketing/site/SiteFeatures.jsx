// Features page, ported pixel-faithful from the ivy-site-handoff prototype
// (features.html). Chrome (nav/footer/sticky CTA) + BASE_CSS come from
// Chrome.jsx; PAGE_CSS below is the page-specific remainder of the
// prototype's stylesheet, scoped under .site-root.
import React from 'react';
import { SiteNav, SiteFooter, StickyCta, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome';

const PAGE_CSS = `
.site-root h1{font-size:clamp(36px,4.6vw,54px);letter-spacing:-.025em;line-height:1.1;margin-bottom:18px}
.site-root h2{font-size:clamp(26px,3.2vw,36px);letter-spacing:-.02em;line-height:1.15;margin-bottom:14px}
.site-root .k-label{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--lime);margin-bottom:12px}
.site-root .page-head{padding:160px 0 40px;position:relative;text-align:center}
.site-root .page-head::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:550px;background:radial-gradient(ellipse,rgba(207,255,80,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lede{font-size:18px;color:var(--muted);max-width:620px;margin:0 auto}
.site-root section{padding:72px 0}
.site-root .split{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}
.site-root .split.rev>div:first-child{order:2}
.site-root .checks{list-style:none;margin-top:22px;display:grid;gap:12px}
.site-root .checks li{font-size:15px;color:var(--muted);display:flex;gap:11px}
.site-root .checks li::before{content:'✓';color:var(--lime);font-weight:700;flex-shrink:0}
.site-root .checks li b{color:var(--text);font-weight:600}
.site-root .visual{background:var(--panel2);border:1px solid var(--border2);border-radius:16px;padding:26px;box-shadow:0 24px 60px rgba(0,0,0,.4)}
.site-root .visual .row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--border);font-size:14px}
.site-root .visual .row:last-child{border-bottom:none}
.site-root .visual .row .l{color:var(--text);font-weight:500}
.site-root .visual .row .l small{display:block;color:var(--dim);font-weight:400;font-size:12.5px}
.site-root .tag{font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px;white-space:nowrap}
.site-root .tag.green{background:var(--tint);color:var(--lime);border:1px solid rgba(207,255,80,.3)}
.site-root .tag.grey{background:var(--panel);color:var(--muted);border:1px solid var(--border2)}
.site-root .tag.amber{background:rgba(251,191,36,.08);color:#fcd34d;border:1px solid rgba(251,191,36,.25)}
.site-root .mini-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:44px;text-align:left}
.site-root .mini{background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:24px;transition:.2s}
.site-root .mini:hover{border-color:rgba(207,255,80,.35)}
.site-root .mini .icon{font-size:22px;margin-bottom:12px}
.site-root .mini h4{font-size:15.5px;font-weight:600;margin-bottom:6px}
.site-root .mini p{font-size:13.5px;color:var(--muted)}
.site-root .cta-final{text-align:center;padding:96px 0}
@media(max-width:900px){
 .site-root .split,.site-root .split.rev{grid-template-columns:1fr;gap:40px}
 .site-root .split.rev>div:first-child{order:0}
 .site-root .mini-grid{grid-template-columns:1fr 1fr}
}
@media(max-width:560px){.site-root .mini-grid{grid-template-columns:1fr}}
`;

export default function SiteFeatures() {
  useSiteFonts();
  usePageMeta({
    title: 'Ivy Features - Booking, Invoicing, CRM, E-Signature, Website Builder & AI Assistant',
    description: 'Everything Ivy does for solo service businesses: online booking with reminders, branded invoicing with card on file, client CRM, legally binding e-signature, two-way messaging, website builder with custom domain, workflows, and an AI assistant that does your busywork. One plan, everything included.',
    canonical: 'https://joinivy.ai/features',
  });
  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <SiteNav active="/features" />

      <header className="page-head">
        <div className="container">
          <span className="eyebrow">Features</span>
          <h1>Everything your business needs.<br /><span className="lime">Nothing it doesn't.</span></h1>
          <p className="lede">Every feature ships in the one plan - no tiers, no locked doors, no "contact sales." Built for therapists, coaches, stylists, photographers, trainers, contractors, tutors, and every other business of one. See <a href="/pricing" style={{ color: 'var(--lime)', textDecoration: 'underline', textUnderlineOffset: '3px' }}>pricing</a>.</p>
        </div>
      </header>

      <section>
        <div className="container split">
          <div>
            <div className="k-label">Ivy AI assistant</div>
            <h2>Chat + actions, personalized to you.</h2>
            <p className="section-sub">Ivy sees your real numbers and answers in plain English with specific actions - not "consider engaging your top customers" but "send Sarah a check-in; she's 22 days quiet." Anything that reaches a client waits for your approval.</p>
            <ul className="checks">
              <li><b>Ask anything:</b> quiet clients, overdue invoices, this week's bookings, revenue this month</li>
              <li><b>Delegate anything:</b> draft invoices and quotes, book sessions, create tasks, log expenses</li>
              <li><b>Automate in plain English:</b> describe a rule, Ivy builds the workflow</li>
              <li><b>Approval-gated sends:</b> messages, invoices, contracts, and campaigns preview before they go out</li>
            </ul>
          </div>
          <div className="visual">
            <div className="row"><span className="l">"Who hasn't booked in 30 days?"<small>reads your real client data</small></span><span className="tag green">instant</span></div>
            <div className="row"><span className="l">"Invoice Sarah for 3 sessions"<small>drafts with line items + tax</small></span><span className="tag green">drafted</span></div>
            <div className="row"><span className="l">"Send it"<small>anything client-facing needs your OK</small></span><span className="tag amber">needs approval</span></div>
            <div className="row"><span className="l">"Remind clients to rebook after 45 days"<small>becomes a live automation</small></span><span className="tag grey">workflow created</span></div>
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="container split rev">
          <div>
            <div className="k-label">Booking &amp; scheduling</div>
            <h2>Your calendar fills itself.</h2>
            <p className="section-sub">Share one link. Clients book around your real availability - no login, no back-and-forth - and reminders go out automatically so no-shows stop happening.</p>
            <ul className="checks">
              <li><b>Online booking + calendar sync</b> - a public page at your own link, embeddable anywhere</li>
              <li><b>Services, packages &amp; capacity</b> with per-weekday availability and blocked time</li>
              <li><b>Deposits, intake forms &amp; signatures</b> collected in the booking flow itself</li>
              <li><b>Automated reminders</b> by email and SMS - 1 week, 2 days, 1 day, and 2 hours before</li>
              <li><b>Card on file</b> - late-cancel and no-show policies that actually enforce themselves</li>
            </ul>
          </div>
          <div className="visual">
            <div className="row"><span className="l">Friday 10:00 - Deep Tissue, Maya R.<small>deposit paid · intake signed</small></span><span className="tag green">confirmed</span></div>
            <div className="row"><span className="l">Friday 2:00 - Consult, new lead<small>booked from your website</small></span><span className="tag grey">new</span></div>
            <div className="row"><span className="l">Reminder → Jordan T.<small>2 days before, email + SMS</small></span><span className="tag green">sent</span></div>
            <div className="row"><span className="l">Saturday - blocked<small>your weekend stays yours</small></span><span className="tag amber">unavailable</span></div>
          </div>
        </div>
      </section>

      <section>
        <div className="container split">
          <div>
            <div className="k-label">Money</div>
            <h2>Get paid without chasing.</h2>
            <p className="section-sub">Payments go straight to your Stripe account - Ivy never touches your money and takes no transaction fee. You only pay Stripe's standard processing rate.</p>
            <ul className="checks">
              <li><b>Branded invoices + recurring billing</b> with line items, tax, discounts, and public pay links</li>
              <li><b>Card on file + auto-charges</b> - no more chasing checks</li>
              <li><b>Memberships, packages &amp; gift cards</b> - recurring revenue, built in</li>
              <li><b>In-person sales</b> - Tap to Pay on iPhone/Android</li>
              <li><b>Overdue autopilot:</b> due-soon warnings and overdue nudges without you lifting a finger</li>
              <li><b>Goals + finance dashboard</b> with a Schedule-C-ready tax export (QuickBooks/Xero compatible)</li>
            </ul>
          </div>
          <div className="visual">
            <div className="row"><span className="l">Invoice #1042 - $360<small>paid via public link, no client login</small></span><span className="tag green">paid</span></div>
            <div className="row"><span className="l">Monthly retainer - $500<small>recurring, auto-charged on the 1st</small></span><span className="tag grey">scheduled</span></div>
            <div className="row"><span className="l">Invoice #1039 - $180<small>due-soon reminder went out today</small></span><span className="tag amber">due in 3 days</span></div>
            <div className="row"><span className="l">Transaction fee to Ivy<small>on every payment, forever</small></span><span className="tag green">$0.00</span></div>
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="container split rev">
          <div>
            <div className="k-label">Clients</div>
            <h2>A CRM that remembers everything.</h2>
            <p className="section-sub">Bookings know about clients. Clients know about invoices. Every note, document, and message per client - one drawer, full history. Plus a free portal your clients will actually use.</p>
            <ul className="checks">
              <li><b>Unlimited clients + pipeline</b> - leads → active → paused, with tags and conversion analytics</li>
              <li><b>CSV import</b> - bring your whole client list from your old tools in minutes</li>
              <li><b>Two-way client messaging:</b> direct and group threads, photos, voice memos with auto-transcription</li>
              <li><b>Free client portal:</b> bookings, invoices, signed forms, and messages - free for them, forever</li>
              <li><b>Reviews + rewards:</b> automatic review requests after sessions, referral rewards built in</li>
            </ul>
          </div>
          <div className="visual">
            <div className="row"><span className="l">Maya R. - Active<small>12 bookings · $1,440 lifetime · signed waiver</small></span><span className="tag green">VIP tag</span></div>
            <div className="row"><span className="l">New lead from your website<small>contact form → client record, automatic</small></span><span className="tag grey">lead</span></div>
            <div className="row"><span className="l">Sarah - 22 days quiet<small>Ivy flagged her before you noticed</small></span><span className="tag amber">follow up</span></div>
            <div className="row"><span className="l">Review request → Sam K.<small>sent automatically after session</small></span><span className="tag green">5 stars</span></div>
          </div>
        </div>
      </section>

      <section>
        <div className="container split">
          <div>
            <div className="k-label">Presence</div>
            <h2>Look established. Instantly.</h2>
            <p className="section-sub">A real website, legally binding e-signature, and email campaigns - the pieces that used to cost three separate subscriptions and a weekend of setup.</p>
            <ul className="checks">
              <li><b>Website builder + custom domain</b> - drag-and-drop pages, templates, gallery, product store</li>
              <li><b>SEO built in</b> with traffic analytics; site forms turn visitors into leads automatically</li>
              <li><b>Documents + e-signature:</b> waivers, intakes, and agreements from rich text or your own PDFs</li>
              <li><b>Email campaigns</b> to all clients or tagged segments, with one-click unsubscribe compliance</li>
              <li><b>Works as a phone app:</b> install to your home screen in two taps, push notifications included</li>
            </ul>
          </div>
          <div className="visual">
            <div className="row"><span className="l">yourstudio.com<small>published from Ivy, SEO + sitemap automatic</small></span><span className="tag green">live</span></div>
            <div className="row"><span className="l">Intake + waiver<small>auto-sends when a client books</small></span><span className="tag grey">attached</span></div>
            <div className="row"><span className="l">"Spring openings" campaign<small>to 214 clients, opt-outs honored</small></span><span className="tag green">sent</span></div>
            <div className="row"><span className="l">Website form → new lead<small>straight into your CRM</small></span><span className="tag grey">captured</span></div>
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="container center">
          <span className="eyebrow">And the rest</span>
          <h2>Yes, that's included too.</h2>
          <div className="mini-grid">
            <div className="mini"><div className="icon">⚡</div><h4>Workflows + automated reminders</h4><p>Trigger-based automations: new lead, quiet client, completed booking - send emails, SMS, tasks, or documents.</p></div>
            <div className="mini"><div className="icon">📁</div><h4>Projects</h4><p>Group related bookings, invoices, quotes, and documents under one umbrella - like "Smith wedding."</p></div>
            <div className="mini"><div className="icon">⏱️</div><h4>Time tracking</h4><p>Billable timers per client that convert straight into invoice line items.</p></div>
            <div className="mini"><div className="icon">🎯</div><h4>Goals</h4><p>Revenue, booking, and client goals that track themselves against your real numbers.</p></div>
            <div className="mini"><div className="icon">🧾</div><h4>Expenses</h4><p>Log deductible expenses that roll straight into your quarterly tax export.</p></div>
            <div className="mini"><div className="icon">📈</div><h4>Analytics</h4><p>Lead conversion, churn, revenue trends, and website traffic - 30/90/365-day views.</p></div>
          </div>
        </div>
      </section>

      <section className="cta-final">
        <div className="container">
          <h2>See it all in one trial.</h2>
          <p className="section-sub" style={{ margin: '0 auto 30px' }}>Every feature unlocked from day one. 14 days free, $0 today.</p>
          <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
          <p className="trust" style={{ marginTop: '14px' }}>$0 today · Cancel anytime</p>
        </div>
      </section>

      <SiteFooter />
      <StickyCta />
    </div>
  );
}

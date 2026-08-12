// Pricing page, ported pixel-faithfully from the ivy-site-handoff prototype
// (pricing.html). Page-specific CSS lives in PAGE_CSS below; shared chrome and
// base styles come from Chrome.jsx. The ROI calculator script is ported as
// React state (two sliders + derived values, same conservative math).
import React, { useState } from 'react';
import { SiteNav, SiteFooter, StickyCta, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome';

const JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    { '@type': 'Question', name: 'How much does Ivy cost?', acceptedAnswer: { '@type': 'Answer', text: 'Ivy costs $8.99/week once you subscribe, or $375/year with annual billing (about 20% off). Everyone starts with a 14-day free trial - $0 today, the whole product unlocked.' } },
    { '@type': 'Question', name: 'Does Ivy take a cut of my payments?', acceptedAnswer: { '@type': 'Answer', text: "Never. Payments go directly from your client to your own Stripe account - Ivy never touches your money. You only pay Stripe's standard processing rate, and nothing to Ivy beyond the subscription." } },
    { '@type': 'Question', name: 'Does Ivy charge per-client or per-seat fees?', acceptedAnswer: { '@type': 'Answer', text: 'No. Unlimited clients, unlimited bookings, unlimited invoices - one flat subscription. No per-seat math.' } },
    { '@type': 'Question', name: 'Can I cancel Ivy anytime?', acceptedAnswer: { '@type': 'Answer', text: 'Yes. No contracts, no notice period - cancel from your account page in two clicks. Your data stays exportable.' } },
    { '@type': 'Question', name: 'Does Ivy have a free trial?', acceptedAnswer: { '@type': 'Answer', text: 'Yes - 14 days, the whole product, $0 today. Ivy reminds you before the trial ends, and if you cancel before day 14 you never pay a cent.' } },
    { '@type': 'Question', name: "What if I'm switching to Ivy from another tool?", acceptedAnswer: { '@type': 'Answer', text: 'Bring your client list over via CSV import in minutes. Your invoices export in QuickBooks- and Xero-compatible formats, so nothing about your books breaks.' } },
    { '@type': 'Question', name: 'Does Ivy store my client data securely?', acceptedAnswer: { '@type': 'Answer', text: "Yes. Every workspace is fully isolated - the AI assistant can only see your data, never anyone else's. Data is encrypted in transit and at rest, all card data is handled by Stripe, and you can export everything as JSON any time." } },
  ],
};

const PAGE_CSS = `
.site-root html{scroll-behavior:smooth}
.site-root h1{font-size:clamp(36px,4.8vw,56px);letter-spacing:-.025em;line-height:1.1;margin-bottom:18px}
.site-root h2{font-size:clamp(28px,3.4vw,38px);letter-spacing:-.02em;margin-bottom:14px}
.site-root .page-head{padding:160px 0 24px;position:relative;text-align:center}
.site-root .page-head::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:550px;background:radial-gradient(ellipse,rgba(207,255,80,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lede{font-size:18px;color:var(--muted);max-width:640px;margin:0 auto}
.site-root section{padding:64px 0}
/* TRIAL FLOW PILLS */
.site-root .flow{display:flex;gap:14px;align-items:center;justify-content:center;margin-top:34px;flex-wrap:wrap}
.site-root .flow .stage{padding:12px 22px;border-radius:12px;text-align:center}
.site-root .flow .stage b{display:block;font-size:15px;font-family:var(--head);font-weight:600}
.site-root .flow .stage span{font-size:12.5px}
.site-root .flow .free{background:var(--lime);color:var(--ink)}
.site-root .flow .free span{color:rgba(11,12,8,.7)}
.site-root .flow .active{background:var(--panel2);border:1px solid var(--border2)}
.site-root .flow .active span{color:var(--dim)}
.site-root .flow .arrow{color:var(--dim)}
/* LIME PRICE CARD */
.site-root .price-card{max-width:560px;margin:40px auto 0;background:var(--lime);color:var(--ink);border-radius:20px;padding:44px;text-align:left}
.site-root .price-card .plan{font-family:var(--head);font-size:24px;font-weight:600}
.site-root .price-card .plan-sub{font-size:14px;color:rgba(11,12,8,.7);margin-bottom:20px}
.site-root .price-card .amount{font-family:var(--head);font-size:54px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.site-root .price-card .terms{font-size:13.5px;color:rgba(11,12,8,.78);margin:10px 0 2px}
.site-root .price-card .annual{font-size:13.5px;color:rgba(11,12,8,.78);margin-bottom:24px}
.site-root .price-card .annual b{color:var(--ink)}
.site-root .price-card .btn{background:var(--ink);color:var(--lime);width:100%;justify-content:center;text-decoration:underline;text-underline-offset:3px}
.site-root .price-card ul{list-style:none;margin:26px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:9px 18px}
.site-root .price-card li{font-size:13.5px;color:rgba(11,12,8,.85);display:flex;gap:8px}
.site-root .price-card li::before{content:'✓';font-weight:700;flex-shrink:0}
@media(max-width:640px){.site-root .price-card ul{grid-template-columns:1fr}}
/* ROI CALC */
.site-root .calc{max-width:760px;margin:44px auto 0;background:var(--panel2);border:1px solid var(--border2);border-radius:18px;padding:36px;text-align:left}
.site-root .calc label{display:flex;justify-content:space-between;font-size:14px;color:var(--muted);margin:22px 0 8px;font-weight:500}
.site-root .calc label output{color:var(--lime);font-weight:600;font-family:var(--head)}
.site-root input[type=range]{width:100%;accent-color:#CFFF50;cursor:pointer}
.site-root .calc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:30px}
.site-root .calc-cell{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:18px}
.site-root .calc-cell .k{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.site-root .calc-cell .v{font-family:var(--head);font-size:24px;font-weight:600;color:var(--lime);margin-top:4px}
.site-root .calc-cell .d{font-size:12px;color:var(--dim);margin-top:2px}
.site-root .calc-total{margin-top:16px;background:var(--tint);border:1px solid rgba(207,255,80,.3);border-radius:12px;padding:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.site-root .calc-total .k{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.site-root .calc-total .v{font-family:var(--head);font-size:30px;font-weight:600;color:var(--lime)}
.site-root .calc .fine{font-size:12.5px;color:var(--dim);margin-top:18px}
@media(max-width:640px){.site-root .calc-grid{grid-template-columns:1fr}}
/* MATH TABLE */
.site-root .math{max-width:680px;margin:44px auto 0;background:var(--bg);border:1px solid var(--border);border-radius:16px;overflow:hidden;text-align:left}
.site-root .math .rowm{display:flex;justify-content:space-between;gap:16px;padding:14px 26px;border-bottom:1px solid var(--border);font-size:14.5px;align-items:baseline}
.site-root .math .rowm .t{color:var(--text);font-weight:500}
.site-root .math .rowm .t small{display:block;color:var(--dim);font-weight:400;font-size:12.5px}
.site-root .math .rowm .p{color:var(--dim);white-space:nowrap}
.site-root .math .rowm.total{background:var(--tint)}
.site-root .math .rowm.total .t,.site-root .math .rowm.total .p{color:var(--lime);font-weight:600}
/* TRUST GRID */
.site-root .trust-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:44px;text-align:left}
.site-root .trust-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:24px}
.site-root .trust-card h4{font-size:15px;font-weight:600;margin-bottom:6px}
.site-root .trust-card p{font-size:13px;color:var(--muted)}
@media(max-width:900px){.site-root .trust-grid{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.site-root .trust-grid{grid-template-columns:1fr}}
/* FAQ */
.site-root .faq{max-width:720px;margin:44px auto 0;text-align:left}
.site-root details{background:var(--panel);border:1px solid var(--border);border-radius:12px;margin-bottom:12px;overflow:hidden}
.site-root details[open]{border-color:rgba(207,255,80,.35)}
.site-root summary{padding:19px 24px;font-weight:600;font-size:15.5px;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center}
.site-root summary::-webkit-details-marker{display:none}
.site-root summary::after{content:'+';color:var(--lime);font-size:20px;font-weight:400;transition:.2s}
.site-root details[open] summary::after{transform:rotate(45deg)}
.site-root details .a{padding:0 24px 20px;font-size:14.5px;color:var(--muted)}
`;

export default function SitePricing() {
  useSiteFonts();
  usePageMeta({
    title: 'Ivy Pricing - $8.99/week, No Transaction Fees | 14-Day Free Trial',
    description: 'Ivy costs $8.99/week (or $375/year) with a 14-day free trial, $0 today. One plan includes booking, invoicing, CRM, e-signature, website builder, and the Ivy AI assistant. No transaction fees, no per-seat math - an affordable HoneyBook, Calendly, and Squarespace alternative.',
    canonical: 'https://joinivy.ai/pricing',
    jsonLd: JSON_LD,
  });

  // ROI calculator, same conservative math as the prototype's calc():
  // $75/hr rate, 60% of admin automated, 8% no-show rate recovered,
  // $100/mo average tool savings.
  const [clients, setClients] = useState(40);
  const [hours, setHours] = useState(8);
  const tools = 100;
  const adminBack = Math.round(hours * 4.33 * 0.6);
  const noShows = Math.max(1, Math.round(clients * 0.08));
  const rate = 75;
  const total = tools + adminBack * rate + noShows * rate;
  const totalLabel = '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '/mo';

  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <SiteNav active="/pricing" />

      <header className="page-head">
        <div className="container">
          <span className="eyebrow">One price. Every tool you'd otherwise piece together.</span>
          <h1>Simple pricing.<br />No transaction fees, no per-seat math.</h1>
          <p className="lede">Replace your full stack - CRM, scheduler, invoicing, contracts, website, email, AI - with one subscription. 14-day free trial, $0 today. Then a simple $8.99/week when you're ready.</p>
          <div className="flow">
            <div className="stage free"><b>14 days free</b><span>the whole product, $0 today</span></div>
            <span className="arrow">→</span>
            <div className="stage active"><b>Active</b><span>$8.99/week when subscribed</span></div>
          </div>
        </div>
      </header>

      <section style={{ paddingTop: 16 }}>
        <div className="container">
          <div className="price-card">
            <div className="plan">Ivy</div>
            <div className="plan-sub">Everything to run your business, in one place.</div>
            <div className="amount">14 days free</div>
            <p className="terms">then $8.99 / week once you subscribe. No per-seat math, no transaction fees.</p>
            <p className="annual">Or save with annual - <b>$375/yr</b> (save about 20%).</p>
            <a href="/signup" className="btn">Start your 14-day free trial →</a>
            <ul>
              <li>Unlimited clients + pipeline</li>
              <li>Online booking + calendar sync</li>
              <li>Branded invoices + recurring billing</li>
              <li>Card on file + auto-charges</li>
              <li>Memberships, packages & gift cards</li>
              <li>In-person sales - QR checkout on any phone</li>
              <li>Documents + e-signature</li>
              <li>Two-way client messaging</li>
              <li>Free client portal</li>
              <li>Website builder + custom domain</li>
              <li>Workflows + automated reminders</li>
              <li>Goals + finance dashboard</li>
              <li>Reviews + rewards</li>
              <li>Ivy AI assistant (chat + actions, personalized to you)</li>
              <li>Stripe payments (no transaction fee)</li>
              <li>Email support</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="alt center">
        <div className="container">
          <span className="eyebrow">ROI calculator</span>
          <h2>See what Ivy puts back in your pocket.</h2>
          <p className="section-sub">Move the two sliders. Numbers update live. No signup needed.</p>
          <div className="calc">
            <label>Clients you serve per month <output>{clients} clients</output></label>
            <input type="range" min="5" max="200" value={clients} onChange={(e) => setClients(+e.target.value)} />
            <label>Hours a week you spend on admin (billing, scheduling, follow-ups) <output>{hours} hrs/wk</output></label>
            <input type="range" min="1" max="30" value={hours} onChange={(e) => setHours(+e.target.value)} />
            <div className="calc-grid">
              <div className="calc-cell"><div className="k">Tool savings</div><div className="v">+$100/month on average</div><div className="d">replacing the separate tools most solos run in parallel</div></div>
              <div className="calc-cell"><div className="k">Admin hours back</div><div className="v">{adminBack} hrs/mo</div><div className="d">billing + reminders, automated</div></div>
              <div className="calc-cell"><div className="k">No-shows prevented</div><div className="v">{noShows}/mo</div><div className="d">card on file + auto reminders</div></div>
            </div>
            <div className="calc-total"><span className="k">Total monthly upside</span><span className="v">{totalLabel}</span></div>
            <p className="fine">Ivy is $8.99/week, and you start with a 14-day free trial ($0 today). The math is deliberately conservative: a $75/hr billable rate, Ivy automating 60% of your admin time, an 8% no-show rate that reminders + card-on-file recover, and $100/mo average tool savings - many solos save even more. Your real numbers are usually higher.</p>
          </div>
        </div>
      </section>

      <section className="center">
        <div className="container">
          <span className="eyebrow">Do the math</span>
          <h2>Save $100+/mo on average - most solos spend $138/month or even more on stitched-together SaaS.</h2>
          <p className="section-sub">The tools most solo businesses end up running in parallel. Ivy does each of these - and then makes them talk to each other so the booking → invoice → message → follow-up is one fluid motion.</p>
          <div className="math">
            <div className="rowm"><span className="t">HoneyBook<small>clients + invoices + contracts</small></span><span className="p">$39/mo</span></div>
            <div className="rowm"><span className="t">Calendly<small>booking pages + reminders</small></span><span className="p">$12/mo</span></div>
            <div className="rowm"><span className="t">Acuity Scheduling<small>advanced scheduling + intake forms</small></span><span className="p">$16/mo</span></div>
            <div className="rowm"><span className="t">QuickBooks Self-Employed<small>invoices + expenses + taxes</small></span><span className="p">$20/mo</span></div>
            <div className="rowm"><span className="t">Mailchimp<small>newsletter + email blasts</small></span><span className="p">$13/mo</span></div>
            <div className="rowm"><span className="t">Squarespace<small>website + custom domain</small></span><span className="p">$23/mo</span></div>
            <div className="rowm"><span className="t">DocuSign<small>legally-binding e-signatures</small></span><span className="p">$15/mo</span></div>
            <div className="rowm total"><span className="t">Total replaced</span><span className="p">$138+/mo on average → $8.99/week</span></div>
          </div>
          <p style={{ marginTop: 20, fontSize: 14 }}><a href="/compare" className="lime" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>See the full comparison: Ivy vs HoneyBook vs Calendly →</a></p>
          <div className="trust-grid">
            <div className="trust-card"><h4>Stripe-verified partner</h4><p>Your money goes straight to your Stripe - we never touch it.</p></div>
            <div className="trust-card"><h4>Cancel anytime</h4><p>No contracts, no notice period. Cancel from account page.</p></div>
            <div className="trust-card"><h4>Export your data</h4><p>Download everything any time. Your data stays yours.</p></div>
            <div className="trust-card"><h4>No transaction fees</h4><p>You only pay Stripe's standard processing rate.</p></div>
          </div>
        </div>
      </section>

      <section className="alt center">
        <div className="container">
          <span className="eyebrow">Pricing questions</span>
          <h2>Fair questions, straight answers.</h2>
          <div className="faq">
            <details open>
              <summary>How much does Ivy cost?</summary>
              <div className="a">$8.99/week once you subscribe, or $375/yr with annual billing (about 20% off). Everyone starts with a 14-day free trial - $0 today, the whole product unlocked.</div>
            </details>
            <details>
              <summary>Do you take a cut of my payments?</summary>
              <div className="a">Never. Payments go directly from your client to your own Stripe account - Ivy never touches your money. You only pay Stripe's standard processing rate, and nothing to us beyond the subscription.</div>
            </details>
            <details>
              <summary>Per-client or per-seat fees?</summary>
              <div className="a">No. Unlimited clients, unlimited bookings, unlimited invoices - one flat subscription. No per-seat math.</div>
            </details>
            <details>
              <summary>Can I cancel anytime?</summary>
              <div className="a">Yes. No contracts, no notice period - cancel from your account page in two clicks. Your data stays exportable.</div>
            </details>
            <details>
              <summary>Is there a free trial?</summary>
              <div className="a">Yes - 14 days, the whole product, $0 today. We remind you before the trial ends, and if you cancel before day 14 you never pay a cent.</div>
            </details>
            <details>
              <summary>What if I'm switching from another tool?</summary>
              <div className="a">Bring your client list over via CSV import in minutes. Your invoices export in QuickBooks- and Xero-compatible formats, so nothing about your books breaks.</div>
            </details>
            <details>
              <summary>Do you store my client data securely?</summary>
              <div className="a">Yes. Every workspace is fully isolated - your numbers, messages, and clients are yours, and the AI assistant can only see your data, never anyone else's. Data is encrypted in transit and at rest, all card data is handled by Stripe, and you can export everything as JSON any time.</div>
            </details>
          </div>
        </div>
      </section>

      <section className="center" style={{ padding: '88px 0' }}>
        <div className="container">
          <h2>Try it.</h2>
          <p className="section-sub" style={{ margin: '0 auto 30px' }}>14 days free, $0 today, just a few minutes to set up. Bring one client in. See if it feels different.</p>
          <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
          <p className="trust" style={{ marginTop: 14 }}>$0 today · Cancel anytime</p>
        </div>
      </section>

      <SiteFooter />
      <StickyCta />
    </div>
  );
}

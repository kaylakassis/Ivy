// /compare - Ivy vs HoneyBook vs Calendly vs the DIY stack. Ported
// pixel-faithfully from the ivy-site-handoff prototype (compare.html).
import React from 'react';
import { SiteNav, SiteFooter, StickyCta, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome';

const PAGE_CSS = `
.site-root h1{font-size:clamp(34px,4.4vw,52px);letter-spacing:-.025em;line-height:1.12;margin-bottom:18px}
.site-root h2{font-size:clamp(26px,3.2vw,36px);letter-spacing:-.02em;margin-bottom:14px}
.site-root .page-head{padding:160px 0 40px;position:relative;text-align:center}
.site-root .page-head::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:550px;background:radial-gradient(ellipse,rgba(207,255,80,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lede{font-size:18px;color:var(--muted);max-width:660px;margin:0 auto}
.site-root section{padding:64px 0}
/* TABLE */
.site-root .tbl-wrap{overflow-x:auto;margin-top:44px;border:1px solid var(--border2);border-radius:16px}
.site-root table{width:100%;border-collapse:collapse;font-size:14px;min-width:760px}
.site-root th,.site-root td{padding:14px 18px;text-align:left;border-bottom:1px solid var(--border)}
.site-root tr:last-child td{border-bottom:none}
.site-root th{font-family:var(--head);font-weight:600;font-size:14.5px;background:var(--panel2);white-space:nowrap}
.site-root th.ivy-col,.site-root td.ivy-col{background:var(--tint);border-left:1px solid rgba(207,255,80,.3);border-right:1px solid rgba(207,255,80,.3)}
.site-root th.ivy-col{color:var(--lime)}
.site-root td{color:var(--muted)}
.site-root td:first-child{color:var(--text);font-weight:500}
.site-root .yes{color:var(--lime);font-weight:600}
.site-root .no{color:var(--dim)}
.site-root .part{color:#fcd34d}
.site-root .tbl-note{font-size:12.5px;color:var(--dim);margin-top:14px}
/* NOT RIGHT */
.site-root .not-right{max-width:760px;margin:44px auto 0;text-align:left}
.site-root .nr-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:26px;margin-bottom:14px}
.site-root .nr-card h3{font-size:17px;font-weight:600;margin-bottom:8px}
.site-root .nr-card p{font-size:14.5px;color:var(--muted)}
.site-root .nr-card p a{color:var(--lime);text-decoration:underline;text-underline-offset:3px}
/* WHY CARDS */
.site-root .why-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:44px;text-align:left}
.site-root .why{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:26px}
.site-root .why h3{font-size:16px;font-weight:600;margin-bottom:8px}
.site-root .why p{font-size:14px;color:var(--muted)}
@media(max-width:900px){.site-root .why-grid{grid-template-columns:1fr}}
`;

export default function SiteCompare() {
  useSiteFonts();
  usePageMeta({
    title: 'Ivy vs HoneyBook vs Calendly vs the DIY Stack - Honest Comparison',
    description: "Looking for a HoneyBook alternative or Calendly alternative? An honest comparison of Ivy vs HoneyBook, Calendly, and the DIY tool stack for solo service businesses - including when Ivy might NOT be right for you. Ivy is $8.99/week with no transaction fees.",
    canonical: 'https://joinivy.ai/compare',
  });
  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <SiteNav active="/compare" />

      <header className="page-head">
        <div className="container">
          <span className="eyebrow">Honest comparison</span>
          <h1>Ivy vs HoneyBook vs Calendly<br />vs <span className="lime">doing it all yourself</span>.</h1>
          <p className="lede">Each of these tools is good at its job. The question is how many jobs you have - and how many subscriptions, logins, and copy-paste routines you want holding them together.</p>
        </div>
      </header>

      <section style={{ paddingTop: 16 }}>
        <div className="container center">
          <div className="tbl-wrap">
            <table>
              <tbody>
                <tr>
                  <th></th>
                  <th className="ivy-col">Ivy</th>
                  <th>HoneyBook</th>
                  <th>Calendly</th>
                  <th>DIY stack (5–8 tools)</th>
                </tr>
                <tr>
                  <td>Best at</td>
                  <td className="ivy-col">The whole business, connected</td>
                  <td>Client flow & contracts</td>
                  <td>Scheduling links</td>
                  <td>Each tool's one job</td>
                </tr>
                <tr>
                  <td>Price</td>
                  <td className="ivy-col"><span className="yes">$8.99/week</span> (or $375/yr)</td>
                  <td>from ~$39/mo</td>
                  <td>from ~$12/mo</td>
                  <td>$138+/mo on average</td>
                </tr>
                <tr>
                  <td>Online booking + reminders</td>
                  <td className="ivy-col"><span className="yes">✓ included</span></td>
                  <td><span className="part">partial</span></td>
                  <td><span className="yes">✓</span></td>
                  <td><span className="part">separate tool</span></td>
                </tr>
                <tr>
                  <td>Invoicing + recurring billing</td>
                  <td className="ivy-col"><span className="yes">✓ included</span></td>
                  <td><span className="yes">✓</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="part">separate tool</span></td>
                </tr>
                <tr>
                  <td>E-signature & contracts</td>
                  <td className="ivy-col"><span className="yes">✓ included</span></td>
                  <td><span className="yes">✓</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="part">separate tool</span></td>
                </tr>
                <tr>
                  <td>Website builder + custom domain</td>
                  <td className="ivy-col"><span className="yes">✓ included</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="part">separate tool</span></td>
                </tr>
                <tr>
                  <td>Email campaigns</td>
                  <td className="ivy-col"><span className="yes">✓ included</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="part">separate tool</span></td>
                </tr>
                <tr>
                  <td>Free client portal</td>
                  <td className="ivy-col"><span className="yes">✓ forever</span></td>
                  <td><span className="part">client-facing files</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="no"> - </span></td>
                </tr>
                <tr>
                  <td>AI that takes real actions</td>
                  <td className="ivy-col"><span className="yes">✓ built in, approval-gated</span></td>
                  <td><span className="part">writing assists</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="part">ChatGPT on the side</span></td>
                </tr>
                <tr>
                  <td>Everything shares one memory</td>
                  <td className="ivy-col"><span className="yes">✓ one workspace</span></td>
                  <td><span className="part">within its features</span></td>
                  <td><span className="no"> - </span></td>
                  <td><span className="no">you are the integration</span></td>
                </tr>
                <tr>
                  <td>Platform transaction fees</td>
                  <td className="ivy-col"><span className="yes">0% - straight to your Stripe</span></td>
                  <td>varies by payment type</td>
                  <td>n/a</td>
                  <td>varies per tool</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="tbl-note">Based on publicly listed plans and features as of July 2026 - always verify current details on each vendor's site. "Partial" means the capability exists in a limited form or on higher tiers.</p>
        </div>
      </section>

      <section className="alt center">
        <div className="container">
          <span className="eyebrow">The honest part</span>
          <h2>When Ivy might <span className="lime">not</span> be right for you.</h2>
          <p className="section-sub">We'd rather you figure this out on this page than on day 13 of the trial.</p>
          <div className="not-right">
            <div className="nr-card">
              <h3>You have a team.</h3>
              <p>Ivy is built for businesses of one. You can assign staff to services (chair-rental style), but there's no multi-seat team dashboard or role-based access. If you're managing employees, a team-first platform will serve you better today.</p>
            </div>
            <div className="nr-card">
              <h3>You need deep accounting.</h3>
              <p>Ivy tracks revenue and expenses and exports Schedule-C-ready, QuickBooks/Xero-compatible CSVs - but it doesn't replace a full accounting suite or your accountant. Many owners run Ivy for operations and keep their accountant happy with the export.</p>
            </div>
            <div className="nr-card">
              <h3>You don't take payments through Stripe.</h3>
              <p>Ivy's payments run on Stripe, going directly to your own account. If your business can't or won't use Stripe, Ivy's payment features won't work for you yet.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="center">
        <div className="container">
          <span className="eyebrow">Why owners switch</span>
          <h2>The seams are the real cost.</h2>
          <div className="why-grid">
            <div className="why"><h3>One bill instead of five</h3><p>Most solos spend $138/month or more across separate tools. Ivy is $8.99/week for all of it - see <a href="/pricing" style={{ color: 'var(--lime)', textDecoration: 'underline', textUnderlineOffset: '3px' }}>pricing</a>.</p></div>
            <div className="why"><h3>Tools that talk to each other</h3><p>The booking knows the client, the invoice knows the booking, the follow-up knows the invoice. No copy-paste glue, no "let me check the other app."</p></div>
            <div className="why"><h3>An assistant, not another inbox</h3><p>Ivy is the only option here with an AI that takes real actions on your data - draft, book, remind, follow up - with your approval on anything client-facing.</p></div>
          </div>
          <div style={{ marginTop: 48 }}>
            <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
            <p className="trust" style={{ marginTop: 14 }}>$0 today · Cancel anytime · Import your clients via CSV in minutes</p>
          </div>
        </div>
      </section>

      <SiteFooter />
      <StickyCta />
    </div>
  );
}

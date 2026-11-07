// /vs/:slug - switch-from-competitor landing page, on the marketing site's
// design system (site/Chrome.jsx + site/LandingKit.jsx): same nav, footer,
// type scale, cards and buttons as the home page and /compare.
//
// Data per competitor comes from compareData.js; keep its copy word for
// word. Designed for high-intent search queries: "<competitor> alternative",
// "switch from <competitor>", etc.
import React, { useMemo } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { SiteNav, SiteFooter, StickyCta, useSiteFonts, BASE_CSS } from './site/Chrome.jsx';
import { LANDING_CSS, Hero, PricingStrip, FinalCta, LinkTile, VerticalTile } from './site/LandingKit.jsx';
import { COMPETITORS, FEATURE_ROWS, COMPETITOR_LIST } from './compareData.js';
import { VERTICALS } from './verticalsData.js';
import { IVY_PRICE } from '../../lib/pricing.js';
import { usePageMeta, siteUrl, breadcrumbs } from '../../lib/pageMeta.js';

const SYMBOL = { y: '✓', n: '-', l: '~' };
const SYMBOL_TITLE = { y: 'Included', n: 'Not available', l: 'Limited or paid add-on' };

const PAGE_CSS = `
/* PAINS */
.site-root .lp-card.vs-pain .n{font-family:var(--head);font-size:30px;font-weight:600;color:var(--lime);line-height:1}
/* MATRIX */
.site-root .vs-tbl{max-width:880px;margin:40px auto 0;border:1px solid var(--border2);border-radius:16px;overflow:hidden;background:var(--bg)}
.site-root .vs-tbl table{width:100%;border-collapse:collapse;font-size:14.5px}
.site-root .vs-tbl th,.site-root .vs-tbl td{padding:13px 20px;border-bottom:1px solid var(--border);text-align:left}
.site-root .vs-tbl tr:last-child td{border-bottom:none}
.site-root .vs-tbl th{font-family:var(--head);font-weight:600;font-size:14.5px;background:var(--panel2)}
.site-root .vs-tbl th:first-child{font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.site-root .vs-tbl td:first-child{color:var(--text)}
.site-root .vs-tbl .c{text-align:center;width:170px}
.site-root .vs-tbl .ivy{background:var(--tint);border-left:1px solid rgba(76,186,127,.3);border-right:1px solid rgba(76,186,127,.3)}
.site-root .vs-tbl th.ivy{color:var(--lime)}
.site-root .vs-tbl .sym{font-weight:700;font-size:16px}
.site-root .vs-tbl .sym-y{color:var(--lime)}
.site-root .vs-tbl .sym-n{color:var(--dim)}
.site-root .vs-tbl .sym-l{color:#fcd34d}
.site-root .vs-tbl tr.price td{background:var(--panel2);font-family:var(--head);font-weight:600;font-size:15.5px;border-top:1px solid var(--border2)}
.site-root .vs-tbl tr.price td.ivy{background:var(--tint);color:var(--lime)}
.site-root .vs-note{max-width:880px;margin:14px auto 0;font-size:12.5px;color:var(--dim);text-align:center}
/* MIGRATION */
.site-root .vs-move{max-width:960px;margin:0 auto;display:grid;grid-template-columns:1fr auto;gap:40px;align-items:center;background:var(--tint);border:1px solid rgba(76,186,127,.3);border-radius:20px;padding:44px 48px}
.site-root .vs-move h2{color:var(--lime);margin-bottom:12px}
.site-root .vs-move p{font-size:16px;color:var(--muted);max-width:560px}
/* LINKS */
.site-root .vs-links{display:grid;grid-template-columns:1fr 1fr;gap:48px}
.site-root .vs-links h2{font-size:clamp(22px,2.4vw,28px);margin-bottom:20px}
@media(max-width:900px){
 .site-root .vs-move{grid-template-columns:1fr;gap:24px;padding:36px 32px}
 .site-root .vs-links{grid-template-columns:1fr;gap:44px}
}
@media(max-width:560px){
 .site-root .vs-tbl{border-radius:12px;margin-top:32px}
 .site-root .vs-tbl table{font-size:13.5px}
 .site-root .vs-tbl th,.site-root .vs-tbl td{padding:11px 10px}
 .site-root .vs-tbl th:first-child,.site-root .vs-tbl td:first-child{padding-left:14px}
 .site-root .vs-tbl .c{width:72px;padding-left:6px;padding-right:6px}
 .site-root .vs-tbl th.c{font-size:13px}
 .site-root .vs-tbl tr.price td{font-size:13.5px}
 .site-root .vs-move{padding:28px 22px}
 .site-root .vs-move .btn{width:100%;justify-content:center}
}
`;

export default function ComparePage() {
  const { slug } = useParams();
  const c = COMPETITORS[slug];
  useSiteFonts();

  const meta = useMemo(() => (c ? {
    title: `Ivy vs ${c.name} - switching guide`,
    description: `Switching from ${c.name} to Ivy? Side-by-side comparison, why solo owners switch, and a free data import. From $${IVY_PRICE}/week, AI included.`,
    canonical: siteUrl(`/vs/${slug}`),
    jsonLd: breadcrumbs([['Home', '/'], ['Compare', '/compare'], [`Ivy vs ${c.name}`, `/vs/${slug}`]]),
  } : null), [c, slug]);
  usePageMeta(meta);

  if (!c) return <Navigate to="/pricing" replace/>;

  const related = (c.related || []).filter((s) => VERTICALS[s]);
  const others = COMPETITOR_LIST.filter((x) => x.slug !== slug);

  return (
    <div className="site-root">
      <style>{BASE_CSS + LANDING_CSS + PAGE_CSS}</style>
      <SiteNav active="/compare"/>

      <Hero
        crumbs={[['Home', '/'], ['Compare', '/compare']]}
        eyebrow={`Ivy vs ${c.name}`}
        title={c.headline}
        sub={c.sub}
        secondary={['/pricing', 'See pricing']}
      />

      <section className="alt">
        <div className="container">
          <div className="lp-head center">
            <span className="eyebrow">Why solo owners switch</span>
            <h2>Why switch from {c.name}?</h2>
          </div>
          <div className={`lp-grid n${c.pains.length}`}>
            {c.pains.map((p, i) => (
              <div className="lp-card num vs-pain" key={i}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <p>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="lp-head center">
            <span className="eyebrow">Side by side</span>
            <h2>Feature-by-feature comparison</h2>
          </div>
          <div className="vs-tbl">
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th className="c ivy">Ivy</th>
                  <th className="c">{c.name}</th>
                </tr>
              </thead>
              <tbody>
                {FEATURE_ROWS.map((row) => {
                  const theirs = c.matrix[row.key] || 'n';
                  return (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td className="c ivy"><span className="sym sym-y" title={SYMBOL_TITLE.y} aria-label={SYMBOL_TITLE.y}>{SYMBOL.y}</span></td>
                      <td className="c"><span className={`sym sym-${theirs}`} title={SYMBOL_TITLE[theirs]} aria-label={SYMBOL_TITLE[theirs]}>{SYMBOL[theirs]}</span></td>
                    </tr>
                  );
                })}
                <tr className="price">
                  <td>Price</td>
                  <td className="c ivy">${IVY_PRICE}/week</td>
                  <td className="c">{c.theirPrice}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="vs-note">
            ~ = limited or paid add-on. Comparison reflects publicly listed
            feature parity as of {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}.
          </p>
        </div>
      </section>

      <section className="alt">
        <div className="container">
          <div className="vs-move">
            <div>
              <h2>We'll move your data over - free.</h2>
              <p>
                Export your client list, booking history, and invoices from {c.name} (or share read-only access),
                and our team will import everything into your new Ivy workspace within a business day. No charge,
                no catch.
              </p>
            </div>
            <a href={`mailto:hello@joinivy.ai?subject=${encodeURIComponent(`Switching from ${c.name}`)}`} className="btn btn-primary">
              Get migration help
            </a>
          </div>
        </div>
      </section>

      <section>
        <div className="container vs-links">
          <div>
            <span className="eyebrow">More comparisons</span>
            <h2>Considering other tools?</h2>
            <div className="lp-tiles two compact">
              {others.map((x) => <LinkTile key={x.slug} href={`/vs/${x.slug}`}>Ivy vs {x.name}</LinkTile>)}
              <LinkTile href="/compare">All comparisons</LinkTile>
            </div>
          </div>
          {related.length > 0 && (
            <div>
              <span className="eyebrow">Who it's for</span>
              <h2>See Ivy for your kind of business.</h2>
              <div className="lp-tiles two">
                {related.map((s) => <VerticalTile key={s} slug={s}/>)}
              </div>
            </div>
          )}
        </div>
      </section>

      <PricingStrip/>
      <FinalCta/>
      <SiteFooter/>
      <StickyCta/>
    </div>
  );
}

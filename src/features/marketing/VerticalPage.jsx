// /for/:slug - vertical-specific landing pages, one per profession, on the
// marketing site's design system (site/Chrome.jsx + site/LandingKit.jsx):
// same nav, footer, type scale, cards and buttons as the home page.
// Major SEO win for queries like "booking software for massage therapists"
// or "CRM for personal trainers".
//
// All the words on the page come from verticalsData.js (headline, sub,
// bullets, use) or are short section labels; keep the data's copy word for
// word. Adding a vertical: drop a row in verticalsData.js.
import React, { useMemo } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SiteNav, SiteFooter, StickyCta, useSiteFonts, BASE_CSS, SignupCta } from './site/Chrome.jsx';
import {
  LANDING_CSS, Hero, PricingStrip, FinalCta, VerticalTile, VerticalGroups, TRIAL_CTA,
} from './site/LandingKit.jsx';
import { VERTICALS, POPULAR_VERTICALS } from './verticalsData.js';
import { usePageMeta, siteUrl, breadcrumbs } from '../../lib/pageMeta.js';

// Meta description from the page's own copy: headline + sub when that
// fits a search snippet, otherwise the sub alone, otherwise the headline.
export function verticalDescription(v) {
  const full = `${v.headline} ${v.sub}`;
  if (full.length <= 160) return full;
  return v.sub.length <= 160 ? v.sub : v.headline;
}

// A setup step as shown: the data keeps the sentence's own commas so the
// steps join back into it word for word; a step card drops the trailing one
// (CSS capitalises the first letter).
const stepText = (s) => s.replace(/,$/, '');

export default function VerticalPage() {
  const { slug } = useParams();
  const v = VERTICALS[slug];
  useSiteFonts();

  const meta = useMemo(() => (v ? {
    title: `Ivy - ${capFirst(v.angle)} run their business in one place`,
    description: verticalDescription(v),
    canonical: siteUrl(`/for/${slug}`),
    jsonLd: breadcrumbs([['Home', '/'], [`Ivy for ${v.angle}`, `/for/${slug}`]]),
  } : null), [v, slug]);
  usePageMeta(meta);

  // Bad slug → bounce to the home page rather than 404; better UX,
  // and the visitor still lands on something useful.
  if (!v) return <Navigate to="/" replace/>;

  const steps = Array.isArray(v.use) ? v.use : [v.use];
  const popular = POPULAR_VERTICALS.filter((s) => s !== slug).slice(0, 8);

  return (
    <div className="site-root">
      <style>{BASE_CSS + LANDING_CSS}</style>
      <SiteNav active="/features"/>

      <Hero
        crumbs={[['Home', '/'], ["Who it's for", '/features#who']]}
        eyebrow={`Ivy for ${v.angle}`}
        title={v.headline}
        sub={v.sub}
        secondary={['/features', 'See everything Ivy does']}
      />

      <section className="alt">
        <div className="container">
          <div className="lp-head center">
            <span className="eyebrow">What you get</span>
            <h2>Made for {v.angle}.</h2>
          </div>
          <div className={`lp-grid n${v.bullets.length}`}>
            {v.bullets.map((b) => (
              <div className="lp-card" key={b.title}>
                <span className="ic"><Icons.Check size={20} sw={2.2}/></span>
                <div>
                  <h3>{b.title}</h3>
                  <p>{b.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="container lp-setup">
          <div className="head">
            <span className="eyebrow">How to get started</span>
            <h2>Get up in three minutes.</h2>
            <p className="section-sub">Day-one setup, step by step.</p>
          </div>
          <ol className="lp-steps">
            {steps.map((s, i) => (
              <li className="lp-step" key={i}>
                <span className="n" aria-hidden="true">{i + 1}</span>
                <p>{stepText(s)}</p>
              </li>
            ))}
          </ol>
          <div className="cta"><SignupCta className="btn btn-primary">{TRIAL_CTA}</SignupCta></div>
        </div>
      </section>

      <PricingStrip/>

      <section>
        <div className="container">
          <div className="lp-head center" style={{ marginBottom: 40 }}>
            <span className="eyebrow">Built for more</span>
            <h2>Different business? Ivy fits.</h2>
          </div>
          <div className="lp-tiles cap6">
            {popular.map((s) => <VerticalTile key={s} slug={s}/>)}
          </div>
          <details className="lp-more">
            <summary>
              <span className="more">See all businesses</span>
              <span className="less">Show fewer</span>
              <Icons.ArrowDown size={15} sw={2}/>
            </summary>
            <VerticalGroups current={slug}/>
          </details>
        </div>
      </section>

      <FinalCta/>
      <SiteFooter/>
      <StickyCta/>
    </div>
  );
}

function capFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

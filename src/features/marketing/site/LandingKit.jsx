// Building blocks for the landing pages that sit on the marketing site's
// design system: /for/:slug (VerticalPage) and /vs/:slug (ComparePage), plus
// the "Who it's for" directory on /features. Everything here is styled by
// LANDING_CSS, scoped under .site-root like Chrome.jsx's BASE_CSS, and uses
// the same tokens, type scale, cards and buttons as the home page.
//
// Copy rule: these components only lay out text the pages hand them, apart
// from short section labels. Strings already used elsewhere on the site
// (pricing card, final call to action) are repeated word for word.
import React, { useState } from 'react';
import { SignupCta } from './Chrome.jsx';
import { VIDEO_SRC, VIDEO_SRC_WEBM, VIDEO_POSTER } from './ProductVideo.jsx';
import { Icons } from '../../../components/Icons.jsx';
import { VERTICALS, VERTICAL_GROUPS, verticalLabel } from '../verticalsData.js';
import { IVY_PRICE, IVY_PRICE_ANNUAL, ANNUAL_SAVINGS_PCT, TRIAL_DAYS } from '../../../lib/pricing.js';

export const TRIAL_CTA = `Start your ${TRIAL_DAYS}-day free trial`;

// Link tiles and the grouped directory, also used on /features and /compare
// (which keep their own page type scale, so they take only this part).
export const TILES_CSS = `
/* LINK TILES (other businesses, other comparisons) */
.site-root .lp-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.site-root .lp-tiles.two{grid-template-columns:repeat(2,1fr)}
.site-root .lp-tile{display:flex;align-items:center;gap:12px;min-height:58px;padding:14px 16px;background:var(--panel);border:1px solid var(--border);border-radius:12px;font-size:15px;font-weight:500;line-height:1.3;color:var(--text);transition:border-color .2s,transform .2s,background .2s}
.site-root .lp-tile:hover{border-color:rgba(76,186,127,.45);background:var(--panel2);transform:translateY(-1px)}
.site-root .lp-tile .ic{flex:0 0 auto;color:var(--lime);display:flex}
.site-root .lp-tile .go{margin-left:auto;flex:0 0 auto;color:var(--dim);display:flex;transition:color .2s,transform .2s}
.site-root .lp-tile:hover .go{color:var(--lime);transform:translateX(2px)}
/* DIRECTORY: every /for page, grouped, as tidy columns */
.site-root .lp-groups{columns:4 200px;column-gap:36px;text-align:left}
.site-root .lp-group{break-inside:avoid;margin-bottom:26px}
.site-root .lp-group h3{font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
.site-root .lp-group a{display:block;padding:6px 0;font-size:15px;color:var(--muted);transition:color .2s}
.site-root .lp-group a:hover{color:var(--lime)}
.site-root .lp-group a[aria-current]{color:var(--lime)}
@media(max-width:900px){.site-root .lp-tiles{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){
 .site-root .lp-tiles,.site-root .lp-tiles.two{grid-template-columns:1fr;gap:10px}
 .site-root .lp-tile{min-height:52px}
 .site-root .lp-tiles.compact{grid-template-columns:1fr 1fr}
 .site-root .lp-tiles.compact .go{display:none}
 .site-root .lp-tiles.cap6 .lp-tile:nth-child(n+7){display:none}
 .site-root .lp-groups{columns:2;column-gap:20px}
 .site-root .lp-group a{padding:9px 0;font-size:14.5px}
}
`;

export const LANDING_CSS = `
.site-root h1{font-size:clamp(34px,4.6vw,54px);letter-spacing:-.025em;line-height:1.08;margin-bottom:20px}
.site-root h2{font-size:clamp(28px,3.4vw,40px);letter-spacing:-.02em;line-height:1.15;margin-bottom:14px}
.site-root section{padding:88px 0}
.site-root .lp-head{max-width:720px}
.site-root .lp-head.center{margin:0 auto;text-align:center}
.site-root .lp-head .section-sub{margin-top:4px}
/* HERO */
.site-root .lp-hero{padding:136px 0 84px;position:relative}
.site-root .lp-hero::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;max-width:100%;height:600px;background:radial-gradient(ellipse,rgba(76,186,127,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lp-hero-inner{display:grid;grid-template-columns:1.05fr .95fr;gap:60px;align-items:center;position:relative}
.site-root .lp-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--dim);margin:-10px 0 12px}
.site-root .lp-crumbs a{color:var(--muted);transition:color .2s;padding:10px 0}
.site-root .lp-crumbs a:hover{color:var(--lime)}
.site-root .lp-crumbs .sep{opacity:.6}
.site-root .lp-hero .eyebrow{max-width:100%;line-height:1.5}
.site-root .lp-sub{font-size:18px;color:var(--muted);max-width:540px;margin-bottom:32px}
.site-root .lp-ctas{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.site-root .lp-ctas .btn svg{flex-shrink:0}
/* PRODUCT VISUAL (the product video's poster, plays in place) */
.site-root .lp-visual{position:relative;border-radius:18px;overflow:hidden;border:1px solid var(--border2);background:#0B1F1A;aspect-ratio:6/5;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.site-root .lp-visual img{display:block;width:100%;height:100%;object-fit:cover;object-position:100% 50%}
.site-root .lp-visual.playing{aspect-ratio:16/9}
.site-root .lp-visual video{display:block;width:100%;height:100%;object-fit:contain;background:#0B1F1A}
.site-root .lp-visual::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(5,14,11,.55),rgba(5,14,11,0) 38%);pointer-events:none}
.site-root .lp-visual.playing::after{display:none}
.site-root .lp-play{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:1;white-space:nowrap;display:inline-flex;align-items:center;gap:10px;padding:6px 16px 6px 6px;border-radius:999px;background:rgba(15,35,30,.86);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(8px);color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:transform .15s,background .15s}
.site-root .lp-play:hover,.site-root .lp-play:focus-visible{transform:translateX(-50%) scale(1.03);background:rgba(15,35,30,.97)}
.site-root .lp-play:focus-visible{outline:2px solid var(--lime);outline-offset:2px}
.site-root .lp-play i{display:inline-flex;width:28px;height:28px;border-radius:50%;background:var(--lime);color:var(--ink);align-items:center;justify-content:center;font-style:normal;font-size:11px;padding-left:2px}
/* CARD GRID: 2x2 for four, three across for three, never an orphan */
.site-root .lp-grid{display:grid;gap:16px;margin-top:44px}
.site-root .lp-grid.n2,.site-root .lp-grid.n4{grid-template-columns:repeat(2,1fr)}
.site-root .lp-grid.n3{grid-template-columns:repeat(3,1fr)}
.site-root .lp-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:28px;display:flex;gap:18px;transition:border-color .25s,background .25s}
.site-root .lp-card:hover{border-color:rgba(76,186,127,.4);background:var(--panel2)}
.site-root .lp-card .ic{flex:0 0 42px;height:42px;border-radius:10px;background:var(--tint);border:1px solid rgba(76,186,127,.25);display:flex;align-items:center;justify-content:center;color:var(--lime)}
.site-root .lp-card h3{font-size:17px;font-weight:600;line-height:1.35;margin-bottom:6px}
.site-root .lp-card p{font-size:14.5px;color:var(--muted)}
.site-root .lp-card.num{flex-direction:column;gap:14px}
.site-root .lp-card.num .n{font-family:var(--head);font-size:13px;letter-spacing:.08em;color:var(--lime)}
.site-root .lp-card.num p{font-size:15.5px;color:var(--text);line-height:1.55}
/* SETUP STEPS */
.site-root .lp-setup{display:grid;grid-template-columns:.85fr 1.15fr;grid-template-areas:'head steps' 'cta steps';column-gap:64px;row-gap:0;align-items:center}
.site-root .lp-setup .head{grid-area:head;align-self:end}
.site-root .lp-setup .lp-steps{grid-area:steps}
.site-root .lp-setup .cta{grid-area:cta;align-self:start;margin-top:28px}
.site-root .lp-steps{list-style:none;background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:34px 34px 8px}
.site-root .lp-step{display:grid;grid-template-columns:44px 1fr;gap:20px;padding-bottom:28px;position:relative}
.site-root .lp-step:not(:last-child)::before{content:'';position:absolute;left:21.5px;top:48px;bottom:4px;width:1px;background:var(--border2)}
.site-root .lp-step .n{width:44px;height:44px;border-radius:12px;background:var(--tint);border:1px solid rgba(76,186,127,.3);color:var(--lime);font-family:var(--head);font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:center}
.site-root .lp-step p{font-size:17px;line-height:1.5;color:var(--text);padding-top:9px}
.site-root .lp-step p::first-letter{text-transform:uppercase}
/* PRICING STRIP (same card as /pricing and the home page, laid out wide) */
.site-root .lp-price{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center;max-width:960px;margin:44px auto 0;background:var(--lime);color:var(--ink);border-radius:20px;padding:44px 48px;text-align:left}
.site-root .lp-price .plan{font-family:var(--head);font-size:22px;font-weight:600}
.site-root .lp-price .plan-sub{font-size:14px;color:rgba(11,12,8,.7);margin-bottom:16px}
.site-root .lp-price .amount{font-family:var(--head);font-size:52px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.site-root .lp-price .terms{font-size:13.5px;color:rgba(11,12,8,.78);margin:10px 0 4px}
.site-root .lp-price .annual{font-size:13.5px;color:rgba(11,12,8,.78)}
.site-root .lp-price .annual b{color:var(--ink)}
.site-root .lp-price ul{list-style:none;display:grid;gap:10px;margin-bottom:24px}
.site-root .lp-price li{font-size:14.5px;color:rgba(11,12,8,.88);display:flex;gap:10px}
.site-root .lp-price li::before{content:'✓';font-weight:700;flex-shrink:0}
.site-root .lp-price .btn{background:var(--ink);color:var(--lime);width:100%;justify-content:center}
.site-root .lp-price .btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(1,43,36,.35)}
.site-root .lp-price .fine{font-size:12.5px;color:rgba(11,12,8,.65);margin-top:12px;text-align:center}
.site-root .lp-more{margin-top:28px;text-align:center}
.site-root .lp-more summary{list-style:none;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;border:1px solid var(--border2);color:var(--text);transition:border-color .2s,color .2s}
.site-root .lp-more summary::-webkit-details-marker{display:none}
.site-root .lp-more summary:hover{border-color:var(--lime);color:var(--lime)}
.site-root .lp-more summary svg{transition:transform .2s}
.site-root .lp-more[open] summary svg{transform:rotate(180deg)}
.site-root .lp-more .less,.site-root .lp-more[open] .more{display:none}
.site-root .lp-more[open] .less{display:inline}
.site-root .lp-more .lp-groups{margin-top:36px}
/* FINAL CTA (as on the home page) */
.site-root .lp-cta{text-align:center;position:relative;overflow:hidden}
.site-root .lp-cta::before{content:'';position:absolute;bottom:-100px;left:50%;transform:translateX(-50%);width:800px;max-width:100%;height:400px;background:radial-gradient(ellipse,rgba(76,186,127,.08) 0%,transparent 65%);pointer-events:none}
.site-root .lp-cta .container{position:relative}
@media(max-width:900px){
 .site-root section{padding:72px 0}
 .site-root .lp-hero{padding:112px 0 64px}
 .site-root .lp-hero-inner{grid-template-columns:1fr;gap:44px}
 .site-root .lp-setup{grid-template-columns:1fr;grid-template-areas:'head' 'steps' 'cta'}
 .site-root .lp-setup .lp-steps{margin-top:32px}
 .site-root .lp-grid.n3{grid-template-columns:1fr}
 .site-root .lp-price{grid-template-columns:1fr;gap:28px;padding:36px 32px}
}
@media(max-width:560px){
 .site-root section{padding:60px 0}
 .site-root .lp-hero{padding:100px 0 56px}
 .site-root .lp-sub{font-size:17px;margin-bottom:26px}
 .site-root .lp-hero .eyebrow{font-size:11px;letter-spacing:.1em;border-radius:12px}
 .site-root .lp-ctas .btn{width:100%;justify-content:center}
 .site-root .lp-grid{margin-top:32px;gap:12px}
 .site-root .lp-grid.n2,.site-root .lp-grid.n4{grid-template-columns:1fr}
 .site-root .lp-card{padding:22px;gap:16px}
 .site-root .lp-steps{padding:26px 22px 4px}
 .site-root .lp-step{grid-template-columns:40px 1fr;gap:16px;padding-bottom:24px}
 .site-root .lp-step:not(:last-child)::before{left:19.5px;top:44px}
 .site-root .lp-step .n{width:40px;height:40px}
 .site-root .lp-step p{font-size:16px;padding-top:8px}
 .site-root .lp-price{padding:30px 22px;margin-top:32px}
 .site-root .lp-price .amount{font-size:42px}
 .site-root .lp-more summary{width:100%;justify-content:center}
}
` + TILES_CSS;

export function Crumbs({ items }) {
  return (
    <nav className="lp-crumbs" aria-label="Breadcrumb">
      {items.map(([label, href], i) => (
        <React.Fragment key={href}>
          {i > 0 && <span className="sep" aria-hidden="true">/</span>}
          <a href={href}>{label}</a>
        </React.Fragment>
      ))}
    </nav>
  );
}

// The 30-second product video's poster, cropped to the automation card it
// shows. "Watch with sound" swaps in the video itself, in place.
export function HeroVisual() {
  const [playing, setPlaying] = useState(false);
  return (
    <div className={`lp-visual${playing ? ' playing' : ''}`}>
      {playing ? (
        <video poster={VIDEO_POSTER} controls autoPlay playsInline aria-label="Ivy product video, 30 seconds">
          <source src={VIDEO_SRC} type="video/mp4"/>
          <source src={VIDEO_SRC_WEBM} type="video/webm"/>
        </video>
      ) : (
        <>
          <img src={VIDEO_POSTER} alt="Ivy product video, 30 seconds" width="1280" height="720"/>
          <button type="button" className="lp-play" onClick={() => setPlaying(true)} aria-label="Watch the video with sound">
            <i aria-hidden="true">▶</i> Watch with sound · 0:30
          </button>
        </>
      )}
    </div>
  );
}

export function Hero({ crumbs, eyebrow, title, sub, secondary }) {
  return (
    <header className="lp-hero">
      <div className="container lp-hero-inner">
        <div>
          <Crumbs items={crumbs}/>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p className="lp-sub">{sub}</p>
          <div className="lp-ctas">
            <SignupCta className="btn btn-primary">{TRIAL_CTA}</SignupCta>
            <a href={secondary[0]} className="btn btn-ghost">{secondary[1]}</a>
          </div>
          <p className="trust">$0 today · Cancel anytime</p>
        </div>
        <HeroVisual/>
      </div>
    </header>
  );
}

// Same plan, terms and list as the pricing card on the home page.
export function PricingStrip() {
  return (
    <section className="alt">
      <div className="container">
        <div className="lp-head center">
          <span className="eyebrow">Simple pricing</span>
          <h2>One plan, no per-seat math.</h2>
        </div>
        <div className="lp-price">
          <div>
            <div className="plan">Ivy</div>
            <div className="plan-sub">Everything to run your business, in one place.</div>
            <div className="amount">{TRIAL_DAYS} days free</div>
            <p className="terms">then ${IVY_PRICE} / week once you subscribe. No per-seat math, no add-ons.</p>
            <p className="annual">Or save with annual - <b>${IVY_PRICE_ANNUAL}/yr</b> (save about {ANNUAL_SAVINGS_PCT}%).</p>
          </div>
          <div>
            <ul>
              <li>Unlimited clients + pipeline</li>
              <li>Ivy AI assistant: 600 messages a month, chat + actions</li>
              <li>Stripe payments, settled in your own account</li>
              <li>Free client portal - forever</li>
            </ul>
            <SignupCta className="btn">{TRIAL_CTA}</SignupCta>
            <p className="fine">$0 today · Cancel anytime</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// The home page's closing call to action, word for word.
export function FinalCta() {
  return (
    <section className="lp-cta">
      <div className="container">
        <span className="eyebrow">Try it</span>
        <h2>Bring one client in.<br/>See if it feels <span className="lime">different</span>.</h2>
        <p className="section-sub" style={{ margin: '0 auto 34px' }}>14 days free, $0 today, just a few minutes to set up - at joinivy.ai.</p>
        <SignupCta className="btn btn-primary">{TRIAL_CTA}</SignupCta>
        <p className="trust" style={{ marginTop: 14 }}>$0 today · Cancel anytime</p>
      </div>
    </section>
  );
}

export function LinkTile({ href, icon, children }) {
  const Icon = (icon && Icons[icon]) || null;
  return (
    <a href={href} className="lp-tile">
      {Icon && <span className="ic"><Icon size={18} sw={1.8}/></span>}
      <span>{children}</span>
      <span className="go" aria-hidden="true"><Icons.Arrow size={15} sw={2}/></span>
    </a>
  );
}

export function VerticalTile({ slug }) {
  return <LinkTile href={`/for/${slug}`} icon={VERTICALS[slug].icon}>{verticalLabel(slug)}</LinkTile>;
}

// Every /for page, grouped. `current` is marked rather than dropped so the
// columns stay the same on every page.
export function VerticalGroups({ current }) {
  return (
    <div className="lp-groups">
      {VERTICAL_GROUPS.map(([label, slugs]) => (
        <div className="lp-group" key={label}>
          <h3>{label}</h3>
          {slugs.map((s) => (
            <a key={s} href={`/for/${s}`} aria-current={s === current ? 'page' : undefined}>{verticalLabel(s)}</a>
          ))}
        </div>
      ))}
    </div>
  );
}

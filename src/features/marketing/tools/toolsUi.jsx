// Shared pieces for the free tools at /tools: the page frame (homepage
// chrome from site/Chrome.jsx), form controls styled for the dark site,
// Copy / Download buttons, the soft Ivy note and the "more tools" row.
// Everything here runs in the visitor's browser only; nothing they type is
// sent anywhere.
import React, { useEffect, useRef, useState } from 'react';
import { SiteNav, SiteFooter, StickyCta, useSiteFonts, BASE_CSS, SignupCta } from '../site/Chrome.jsx';
import { siteUrl, breadcrumbs } from '../../../lib/pageMeta.js';
import { TOOLS, NO_SHOW_CALCULATOR } from './toolsData.js';

export const TOOLS_CSS = `
.site-root h1{font-size:clamp(34px,4.6vw,54px);letter-spacing:-.025em;line-height:1.1;margin-bottom:18px}
.site-root h2{font-size:clamp(26px,3.2vw,36px);letter-spacing:-.02em;line-height:1.15;margin-bottom:14px}
.site-root h3{font-size:18px;font-weight:600;line-height:1.3}
.site-root section{padding:64px 0}
.site-root .page-head{padding:132px 0 36px;position:relative;text-align:center}
.site-root .page-head::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;max-width:100vw;height:550px;background:radial-gradient(ellipse,rgba(76,186,127,.09) 0%,transparent 65%);pointer-events:none}
.site-root .lede{font-size:18px;color:var(--muted);max-width:640px;margin:0 auto}
.site-root .crumbs{font-size:13px;color:var(--dim);margin-bottom:22px;display:flex;justify-content:center;flex-wrap:wrap;gap:6px}
.site-root .crumbs a{color:var(--muted)}
.site-root .crumbs a:hover{color:var(--lime)}
.site-root .crumbs .sep{color:var(--border2)}
.site-root .k-label{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--lime);margin-bottom:12px}
.site-root .tool-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:28px;align-items:start}
.site-root .panel{background:var(--panel2);border:1px solid var(--border2);border-radius:18px;padding:28px}
.site-root .panel-title{font-family:var(--head);font-size:19px;font-weight:600;margin-bottom:4px}
.site-root .panel-sub{font-size:13.5px;color:var(--dim);margin-bottom:22px}
.site-root .sticky-col{position:sticky;top:88px}
.site-root .field{margin-bottom:20px;border:none;min-width:0}
.site-root .field:last-child{margin-bottom:0}
.site-root .field-label,.site-root .field legend{display:block;font-size:14.5px;font-weight:600;color:var(--text);margin-bottom:9px;padding:0}
.site-root .field-label small,.site-root .field legend small{font-weight:400;color:var(--dim);font-size:13px}
.site-root .hint{font-size:12.5px;color:var(--dim);margin-top:7px;line-height:1.5}
.site-root .input{width:100%;font:inherit;font-size:16px;color:var(--text);background:var(--bg);border:1px solid var(--border2);border-radius:10px;padding:12px 14px;min-height:48px;transition:border-color .15s,box-shadow .15s}
.site-root .input::placeholder{color:#6F8780}
.site-root .input:focus{outline:none;border-color:var(--lime);box-shadow:0 0 0 3px rgba(76,186,127,.2)}
.site-root select.input{appearance:none;-webkit-appearance:none;padding-right:40px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 21px) 50%,calc(100% - 16px) 50%;background-size:5px 5px;background-repeat:no-repeat}
.site-root .affix{position:relative}
.site-root .affix.has-pre .input{padding-left:30px}
.site-root .affix.suffix .input{padding-right:34px}
.site-root .affix span{position:absolute;top:50%;transform:translateY(-50%);color:var(--dim);font-size:15px;pointer-events:none}
.site-root .affix span.pre{left:14px}
.site-root .affix span.suf{right:14px}
.site-root .seg{display:flex;flex-wrap:wrap;gap:8px}
.site-root .seg label{position:relative;cursor:pointer}
.site-root .seg input{position:absolute;opacity:0;width:1px;height:1px}
.site-root .seg span{display:inline-flex;align-items:center;min-height:44px;padding:9px 16px;border:1px solid var(--border2);border-radius:999px;font-size:14px;color:var(--muted);background:var(--bg);transition:.15s}
.site-root .seg label:hover span{border-color:rgba(76,186,127,.5);color:var(--text)}
.site-root .seg input:checked+span{background:var(--tint);border-color:var(--lime);color:var(--lime);font-weight:600}
.site-root .seg input:focus-visible+span{outline:2px solid var(--lime);outline-offset:2px}
.site-root .seg input:disabled+span{opacity:.4;cursor:not-allowed}
.site-root .checks-list{display:grid;gap:12px}
.site-root .check{display:flex;gap:12px;align-items:flex-start;font-size:14.5px;color:var(--muted);cursor:pointer;line-height:1.45}
.site-root .check input{width:20px;height:20px;margin-top:1px;accent-color:#4CBA7F;flex-shrink:0;cursor:pointer}
.site-root .check b{color:var(--text);font-weight:600}
.site-root .divider{height:1px;background:var(--border);margin:24px 0}
.site-root .out{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14.5px;line-height:1.65;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:20px 22px;font-family:inherit}
.site-root .sticky-col .out{max-height:calc(100vh - 290px);overflow:auto}
.site-root .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
.site-root .actions .status{font-size:13px;color:var(--lime);min-height:1em}
.site-root .disclaimer{font-size:13px;color:var(--dim);margin-top:14px;line-height:1.55}
.site-root .disclaimer b{color:var(--muted);font-weight:600}
.site-root .ivy-note{margin-top:18px;background:var(--tint);border:1px solid rgba(76,186,127,.3);border-radius:14px;padding:20px 22px}
.site-root .ivy-note p{font-size:14.5px;color:var(--text);line-height:1.6}
.site-root .ivy-note p+p{margin-top:6px}
.site-root .ivy-note .btn{margin-top:14px}
.site-root .ivy-note .fine{font-size:12.5px;color:var(--dim);margin-top:8px}
.site-root .tips{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:36px;text-align:left}
.site-root .tip{background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:24px}
.site-root .tip h3{font-size:16px;margin-bottom:8px}
.site-root .tip p{font-size:14px;color:var(--muted)}
.site-root .tool-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;text-align:left}
.site-root .tool-cards.three{grid-template-columns:repeat(3,1fr)}
.site-root .tool-card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:28px;transition:.25s;color:var(--text)}
.site-root .tool-card:hover{border-color:rgba(76,186,127,.4);background:var(--panel2)}
.site-root .tool-card .icon{width:44px;height:44px;border-radius:11px;background:var(--tint);border:1px solid rgba(76,186,127,.25);display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:18px}
.site-root .tool-card .kind{font-size:11.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.site-root .tool-card h3{margin-bottom:8px}
.site-root .tool-card p{font-size:14.5px;color:var(--muted);flex:1}
.site-root .tool-card .go{margin-top:18px;font-size:14.5px;font-weight:600;color:var(--lime)}
.site-root .cta-final{text-align:center;padding:88px 0}
@media(max-width:900px){
 .site-root .tool-grid{grid-template-columns:1fr}
 .site-root .sticky-col{position:static}
 .site-root .sticky-col .out{max-height:none}
 .site-root .tips,.site-root .tool-cards.three{grid-template-columns:1fr 1fr}
}
@media(max-width:640px){
 .site-root .page-head{padding:112px 0 20px}
 .site-root .lede{font-size:16.5px}
 .site-root section{padding:44px 0}
 .site-root .panel{padding:20px 16px;border-radius:16px}
 .site-root .out{padding:16px;font-size:14px}
 .site-root .tips,.site-root .tool-cards,.site-root .tool-cards.three{grid-template-columns:1fr}
 .site-root .actions .btn{flex:1 1 140px;justify-content:center}
 .site-root .cta-final{padding:64px 0 96px}
}
`;

// Page frame shared by every /tools page.
export function ToolFrame({ css = '', children }) {
  useSiteFonts();
  return (
    <div className="site-root">
      <style>{BASE_CSS + TOOLS_CSS + css}</style>
      <SiteNav active="/tools"/>
      {children}
      <SiteFooter/>
      <StickyCta/>
    </div>
  );
}

export function ToolHead({ name, h1, lede, eyebrow = 'Free tool' }) {
  return (
    <header className="page-head">
      <div className="container">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/">Home</a><span className="sep" aria-hidden="true">/</span>
          {name ? <><a href="/tools">Free tools</a><span className="sep" aria-hidden="true">/</span><span aria-current="page">{name}</span></>
            : <span aria-current="page">Free tools</span>}
        </nav>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{h1}</h1>
        <p className="lede">{lede}</p>
      </div>
    </header>
  );
}

// JSON-LD for a tool page: what it is plus where it sits.
export function toolJsonLd(tool, main) {
  const crumbs = breadcrumbs([['Home', '/'], ['Free tools', '/tools'], [tool.name, tool.path]]);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { ...main, url: siteUrl(tool.path), publisher: { '@type': 'Organization', name: 'Ivy', url: siteUrl('/') } },
      { '@type': crumbs['@type'], itemListElement: crumbs.itemListElement },
    ],
  };
}

export const FREE_APP = {
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Any (runs in your web browser)',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

// Copy to clipboard, with a fallback for browsers that block the API.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Copy + Download (.txt) buttons for a block of text.
export function CopyDownload({ text, filename, what = 'text' }) {
  const [status, setStatus] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = (msg) => {
    setStatus(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(''), 2500);
  };
  return (
    <div className="actions">
      <button type="button" className="btn btn-primary"
        onClick={async () => flash((await copyText(text)) ? 'Copied. Paste it wherever you need it.' : 'Your browser blocked copying. Select the text and copy it instead.')}>
        Copy {what}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => { downloadText(text, filename); flash('Downloaded.'); }}>
        Download .txt
      </button>
      <span className="status" role="status" aria-live="polite">{status}</span>
    </div>
  );
}

// The soft "Ivy can do this for you" note under a tool's result.
export function IvyNote({ children, cta = 'Try Ivy free for 14 days' }) {
  return (
    <div className="ivy-note">
      {children}
      <SignupCta className="btn btn-primary btn-sm">{cta}</SignupCta>
      <p className="fine">$0 today · Cancel anytime</p>
    </div>
  );
}

const ICONS = {
  'cancellation-policy-generator': '📝',
  'deposit-calculator': '💵',
  'intake-form-templates': '📋',
  'no-show': '📅',
};

export function ToolCard({ href, icon, kind, name, card, go = 'Open the tool' }) {
  return (
    <a className="tool-card" href={href}>
      <span className="icon" aria-hidden="true">{icon}</span>
      <span className="kind">{kind}</span>
      <h3>{name}</h3>
      <p>{card}</p>
      <span className="go">{go} →</span>
    </a>
  );
}

// Every tool, for the hub and the "more free tools" row.
export function allToolCards() {
  return [
    ...TOOLS.map((t) => ({ href: t.path, icon: ICONS[t.slug], kind: t.kind, name: t.name, card: t.card, key: t.slug })),
    { href: NO_SHOW_CALCULATOR.path, icon: ICONS['no-show'], kind: NO_SHOW_CALCULATOR.kind, name: NO_SHOW_CALCULATOR.name, card: NO_SHOW_CALCULATOR.card, key: 'no-show' },
  ];
}

export function MoreTools({ current }) {
  const cards = allToolCards().filter((c) => c.key !== current);
  return (
    <section className="alt">
      <div className="container">
        <div className="center">
          <span className="eyebrow">More free tools</span>
          <h2>Keep going.</h2>
          <p className="section-sub" style={{ marginBottom: 36 }}>Free, no signup, and nothing you type leaves your browser.</p>
        </div>
        <div className="tool-cards three">
          {cards.map(({ key, ...c }) => <ToolCard key={key} {...c}/>)}
        </div>
      </div>
    </section>
  );
}

export function FinalCta({ title, sub }) {
  return (
    <section className="cta-final">
      <div className="container">
        <h2>{title}</h2>
        <p className="section-sub" style={{ margin: '0 auto 30px' }}>{sub}</p>
        <SignupCta className="btn btn-primary">Start your 14-day free trial</SignupCta>
        <p className="trust" style={{ marginTop: 14 }}>$0 today · Cancel anytime</p>
      </div>
    </section>
  );
}

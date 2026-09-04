// Shared chrome for the new marketing site (ported from the ivy-site-handoff
// prototype). Every marketing page renders <SiteNav active=".."/> + content +
// <SiteFooter/> + <StickyCta/>, and calls usePageMeta for title/meta/JSON-LD.
// Design tokens + base styles live in BASE_CSS, injected once per page via a
// <style> tag so the pages stay pixel-faithful to the prototype.
import React, { useEffect, useState } from 'react';

// Nav items: internal SPA routes. Blog is a static page (public/blog.html,
// served at /blog via Vercel cleanUrls) so it's a plain full-page link, as are
// the blog posts. Everything else stays client-side.
const NAV = [
  ['/', 'Home'], ['/tour', 'Tour'], ['/features', 'Features'],
  ['/pricing', 'Pricing'], ['/compare', 'Compare'], ['/blog', 'Blog'], ['/about', 'About'],
];

// Sets document head per page: title, description, canonical, og/twitter, and
// optional JSON-LD. CSR-only is fine for the core pages (Google renders JS);
// the blog posts are fully static files with real head tags.
export function usePageMeta({ title, description, canonical, ogType = 'website', jsonLd }) {
  useEffect(() => {
    document.title = title;
    const ensure = (sel, make) => {
      let el = document.head.querySelector(sel);
      if (!el) { el = make(); document.head.appendChild(el); }
      return el;
    };
    const meta = (attr, name, content) => {
      const el = ensure(`meta[${attr}="${name}"]`, () => {
        const m = document.createElement('meta'); m.setAttribute(attr, name); return m;
      });
      el.setAttribute('content', content);
      el.dataset.siteMeta = '1';
    };
    meta('name', 'description', description);
    meta('property', 'og:type', ogType);
    meta('property', 'og:site_name', 'Ivy');
    meta('property', 'og:title', title);
    meta('property', 'og:description', description);
    if (canonical) meta('property', 'og:url', canonical);
    meta('name', 'twitter:card', 'summary_large_image');
    meta('name', 'twitter:title', title);
    meta('name', 'twitter:description', description);
    let link = null;
    if (canonical) {
      link = ensure('link[rel="canonical"]', () => {
        const l = document.createElement('link'); l.setAttribute('rel', 'canonical'); return l;
      });
      link.setAttribute('href', canonical);
    }
    let ld = null;
    if (jsonLd) {
      ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(ld);
    }
    return () => { if (ld) ld.remove(); };
  }, [title, description, canonical, ogType, jsonLd]);
}

export function SiteNav({ active }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <nav className="site-nav">
        <div className="container nav-inner">
          <a href="/" className="logo"><span className="logo-mark">✓</span>Ivy</a>
          <div className="nav-links">
            {NAV.map(([to, label]) => (
              <a key={to} href={to} className={active === to ? 'active' : undefined}>{label}</a>
            ))}
          </div>
          <div className="nav-cta">
            <a href="/signin" className="login">Sign in</a>
            <a href="/signup" className="btn btn-primary btn-sm">Get started</a>
            <button className="menu-btn" aria-label="Menu" onClick={() => setOpen((v) => !v)}>☰</button>
          </div>
        </div>
      </nav>
      <div className={`mobile-menu${open ? ' open' : ''}`}>
        {NAV.map(([to, label]) => <a key={to} href={to}>{label}</a>)}
        <a href="/signin">Sign in</a>
      </div>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="container foot-inner">
        <div className="foot-brand">
          <a href="/" className="logo"><span className="logo-mark">✓</span>Ivy</a>
          <p>The all-in-one business platform for solopreneurs, with an AI assistant that does your busywork.</p>
        </div>
        <div className="foot-cols">
          <div className="foot-col"><h5>Product</h5><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/compare">Compare</a><a href="/blog">Blog</a><a href="/security">Security</a><a href="/integrations">Integrations</a><a href="/mobile">Mobile</a></div>
          <div className="foot-col"><h5>Company</h5><a href="/about">About</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/do-not-sell">Do Not Sell My Info</a></div>
          <div className="foot-col"><h5>Account</h5><a href="/signin">Sign in</a><a href="/signup">Get started</a><a href="/me">Client portal</a></div>
        </div>
      </div>
      <div className="container foot-bottom">
        <span>© 2026 Ivy.</span>
        <span>joinivy.ai</span>
      </div>
    </footer>
  );
}

export function StickyCta() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div className={`sticky-cta${show ? ' show' : ''}`}>
      <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
      <div className="note">$0 today · Cancel anytime</div>
    </div>
  );
}

// Base CSS shared by every prototype page (tokens, nav, footer, buttons,
// mobile menu, sticky CTA). Page-specific CSS is appended by each page.
// Scoped inside .site-root so the app's global.css and these styles can't
// fight each other.
export const BASE_CSS = `
.site-root{--bg:#0D0E0C;--panel:#16181A;--panel2:#1D2022;--border:#262A2D;--border2:#383D41;--text:#F3F3EE;--muted:#C9CAC3;--dim:#8A8D85;--lime:#CFFF50;--ink:#0B0C08;--tint:#1F2912;--head:'Space Grotesk',Inter,sans-serif;font-family:Inter,-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden;min-height:100vh}
.site-root *{margin:0;padding:0;box-sizing:border-box}
.site-root a{color:inherit;text-decoration:none}
.site-root .container{max-width:1120px;margin:0 auto;padding:0 24px}
.site-root .lime{color:var(--lime)}
.site-root .btn{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:15px;padding:13px 26px;border-radius:8px;transition:.2s;cursor:pointer;border:none;font-family:Inter,sans-serif}
.site-root .btn-primary{background:var(--lime);color:var(--ink)}
.site-root .btn-primary:hover{transform:translateY(-1px);box-shadow:0 8px 30px rgba(207,255,80,.3)}
.site-root .btn-ghost{border:1px solid var(--border2);color:var(--text);background:transparent}
.site-root .btn-ghost:hover{border-color:var(--lime);color:var(--lime)}
.site-root .site-nav{position:fixed;top:0;left:0;right:0;z-index:100;backdrop-filter:blur(16px);background:rgba(13,14,12,.92);border-bottom:1px solid var(--border)}
.site-root .nav-inner{display:flex;align-items:center;justify-content:space-between;height:64px}
.site-root .logo{display:flex;align-items:center;gap:10px;font-weight:600;font-size:19px;font-family:var(--head)}
.site-root .logo-mark{width:28px;height:28px;border-radius:8px;background:var(--lime);display:flex;align-items:center;justify-content:center;color:var(--ink);font-size:15px;font-weight:700}
.site-root .nav-links{display:flex;gap:30px;font-size:14.5px;color:var(--muted);font-weight:500}
.site-root .nav-links a:hover{color:var(--text)}
.site-root .nav-links a.active{color:var(--lime)}
.site-root .nav-cta{display:flex;gap:14px;align-items:center}
.site-root .nav-cta .login{font-size:14.5px;color:var(--muted);font-weight:500;text-decoration:underline;text-underline-offset:3px}
.site-root .btn-sm{padding:8px 18px;font-size:14px}
.site-root h1,.site-root h2,.site-root h3,.site-root h4{font-family:var(--head);font-weight:500}
.site-root .eyebrow{display:inline-block;font-family:Inter,sans-serif;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--lime);background:var(--tint);border:1px solid rgba(207,255,80,.25);padding:6px 14px;border-radius:999px;margin-bottom:20px}
.site-root .trust{font-size:13.5px;color:var(--dim)}
.site-root .alt{background:var(--panel);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.site-root .center{text-align:center}
.site-root .center .section-sub{margin:0 auto}
.site-root .section-sub{font-size:17px;color:var(--muted);max-width:620px}
.site-root .menu-btn{display:none;background:none;border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:6px 12px;font-size:18px;cursor:pointer;line-height:1.2}
.site-root .mobile-menu{display:none;position:fixed;top:64px;left:0;right:0;background:rgba(13,14,12,.98);border-bottom:1px solid var(--border);z-index:99;padding:8px 24px 18px}
.site-root .mobile-menu a{display:block;padding:13px 0;font-size:16px;color:var(--muted);border-bottom:1px solid var(--border)}
.site-root .mobile-menu a:last-child{border-bottom:none}
.site-root .mobile-menu.open{display:block}
.site-root .sticky-cta{position:fixed;bottom:0;left:0;right:0;z-index:98;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:rgba(13,14,12,.96);backdrop-filter:blur(12px);border-top:1px solid var(--border);display:none;transform:translateY(110%);transition:.3s}
.site-root .sticky-cta.show{transform:none}
.site-root .sticky-cta .btn{width:100%;justify-content:center}
.site-root .sticky-cta .note{text-align:center;font-size:11.5px;color:var(--dim);margin-top:5px}
.site-root .site-foot{border-top:1px solid var(--border);padding:56px 0 40px;background:var(--panel)}
.site-root .foot-inner{display:flex;justify-content:space-between;gap:40px;flex-wrap:wrap}
.site-root .foot-brand{max-width:280px}
.site-root .foot-brand p{font-size:13.5px;color:var(--dim);margin-top:12px}
.site-root .foot-cols{display:flex;gap:64px;flex-wrap:wrap}
.site-root .foot-col h5{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:14px}
.site-root .foot-col a{display:block;font-size:14px;color:var(--muted);margin-bottom:9px}
.site-root .foot-col a:hover{color:var(--lime)}
.site-root .foot-bottom{margin-top:44px;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px;color:var(--dim);flex-wrap:wrap;gap:12px}
@media(max-width:900px){.site-root .nav-links{display:none}.site-root .menu-btn{display:block}.site-root .sticky-cta{display:block}}
`;

// Loads the Google Fonts the prototype uses, once.
export function useSiteFonts() {
  useEffect(() => {
    if (document.getElementById('site-fonts')) return;
    const l = document.createElement('link');
    l.id = 'site-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap';
    document.head.appendChild(l);
  }, []);
}

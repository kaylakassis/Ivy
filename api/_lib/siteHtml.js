// Server-side HTML renderer for published Ivy OS sites.
//
// What this gets us:
//   1. <title> + <meta name="description"> + OG tags appear in the
//      initial response, so Facebook/Twitter/Slack/LinkedIn previews
//      work (these crawlers do NOT execute JS).
//   2. Google's crawler — which does run JS but prefers pre-rendered
//      HTML — gets a fully populated <h1>, headings, body copy, and a
//      JSON-LD LocalBusiness block on the first paint. Indexes faster
//      and ranks better than the SPA-only equivalent.
//   3. The Vite-built bundle still mounts on top, so once JS runs the
//      site is fully interactive (booking widget, IG embeds, custom
//      nav transitions, etc.). React's createRoot replaces the static
//      content under #root with the live tree — no hydration mismatch
//      because we're using render(), not hydrate().
//
// Strategy: read dist/index.html once at module load. That file already
// has the right script/style/font tags with hashed paths from the Vite
// build. We splice in our <head> additions and replace <div id="root">
// with a div containing the static, crawler-friendly section markup.

import fs from 'node:fs';
import path from 'node:path';
// Pulled from the same source the client renderer uses so the server
// HTML's palette + font CSS variables match the client's once it hydrates.
// Both modules are pure JS (no JSX/React imports), so they're safe to
// pull into a Vercel function bundle.
import { TEMPLATES } from '../../src/features/website/templates.js';
import { FONT_PAIRS } from '../../src/features/website/sections.js';

// ----- Shell loading ------------------------------------------------

let cachedShell = null;
function loadShell() {
  if (cachedShell) return cachedShell;
  // Vercel functions cwd is the project root. dist/ ships with the
  // bundle via vercel.json `includeFiles`.
  const candidates = [
    path.join(process.cwd(), 'dist', 'index.html'),
    path.join(process.cwd(), '..', 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    try {
      cachedShell = fs.readFileSync(p, 'utf8');
      return cachedShell;
    } catch (_) {
      // try next
    }
  }
  // Fallback shell — minimal but valid. Hit when dist/ isn't bundled
  // (e.g. local `vercel dev` without a build). Crawlers still get the
  // SEO bits; JS-enabled users get a "Loading…" until they navigate.
  cachedShell = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div></body></html>`;
  return cachedShell;
}

// ----- HTML safety --------------------------------------------------

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => htmlEscapes[c]);
}
// For attribute values (quotes matter).
function attr(s) { return esc(s); }
// For style values; strip newlines + angle brackets but keep `:`, `;`, etc.
function styleVal(s) {
  if (s == null) return '';
  return String(s).replace(/[<>"']/g, '');
}

// ----- Section renderers -------------------------------------------
//
// Each returns an HTML string. We intentionally render a simpler
// representation than the React component — we want semantic, crawler-
// friendly markup (h1/h2/p/ul/li/img with alt text). Once React
// hydrates, the visually richer version takes over.

function renderHero(s) {
  const d = s.data || {};
  const cta = d.cta
    ? `<p class="ivy-cta"><a href="${attr(d.ctaLink || '#book')}">${esc(d.cta)} →</a></p>`
    : '';
  const img = d.imgUrl
    ? `<img src="${attr(d.imgUrl)}" alt="${attr(d.headline || '')}" loading="lazy"/>`
    : '';
  return `<section class="ivy-hero">
    <h1>${esc(d.headline || '')}</h1>
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${cta}
    ${img}
  </section>`;
}

function renderServices(s) {
  const d = s.data || {};
  const items = (d.items || []).map((it) => `
    <li>
      <h3>${esc(it.name || '')}</h3>
      ${it.desc ? `<p>${esc(it.desc)}</p>` : ''}
      ${it.price ? `<p class="ivy-price">${esc(it.price)}${it.duration ? ` · ${esc(it.duration)}` : ''}</p>` : ''}
    </li>`).join('');
  return `<section class="ivy-services">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <ul>${items}</ul>
  </section>`;
}

function renderAbout(s) {
  const d = s.data || {};
  return `<section class="ivy-about">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.body ? `<p>${esc(d.body)}</p>` : ''}
    ${d.imgUrl ? `<img src="${attr(d.imgUrl)}" alt="${attr(d.headline || '')}" loading="lazy"/>` : ''}
  </section>`;
}

function renderBooking(s, handle) {
  const d = s.data || {};
  return `<section class="ivy-booking">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <p><a href="/book/${attr(d.handle || handle || '')}">Open booking calendar</a></p>
  </section>`;
}

function renderTestimonials(s) {
  const d = s.data || {};
  const items = (d.items || []).map((t) => `
    <blockquote>
      <p>${esc(t.text || '')}</p>
      <footer>${esc(t.name || '')}${t.role ? ` — ${esc(t.role)}` : ''}</footer>
    </blockquote>`).join('');
  return `<section class="ivy-testimonials">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${items}
  </section>`;
}

function renderFAQ(s) {
  const d = s.data || {};
  const items = (d.items || []).map((q) => `
    <div class="ivy-faq-item">
      <h3>${esc(q.q || '')}</h3>
      <p>${esc(q.a || '')}</p>
    </div>`).join('');
  return `<section class="ivy-faq">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${items}
  </section>`;
}

function renderGallery(s) {
  const d = s.data || {};
  const photos = (d.photos || []).map((p) => {
    const url = typeof p === 'string' ? p : (p && p.url) || '';
    if (!url) return '';
    return `<img src="${attr(url)}" alt="${attr(d.headline || 'Gallery image')}" loading="lazy"/>`;
  }).join('');
  return `<section class="ivy-gallery">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${photos}
  </section>`;
}

function renderContact(s) {
  const d = s.data || {};
  return `<section class="ivy-contact">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${d.email ? `<p>Email: <a href="mailto:${attr(d.email)}">${esc(d.email)}</a></p>` : ''}
    ${d.phone ? `<p>Phone: <a href="tel:${attr(d.phone)}">${esc(d.phone)}</a></p>` : ''}
  </section>`;
}

function renderFooter(s) {
  const d = s.data || {};
  return `<footer class="ivy-footer">
    <p>© ${esc(d.year || new Date().getFullYear())} ${esc(d.businessName || '')}${d.tagline ? ` · ${esc(d.tagline)}` : ''}</p>
  </footer>`;
}

function renderStats(s) {
  const d = s.data || {};
  const items = (d.items || []).map((it) => `
    <li><strong>${esc(it.value || '')}</strong> <span>${esc(it.label || '')}</span></li>`).join('');
  return `<section class="ivy-stats">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <ul>${items}</ul>
  </section>`;
}

function renderCtaBanner(s) {
  const d = s.data || {};
  return `<section class="ivy-cta-banner">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${d.cta ? `<p><a href="${attr(d.ctaLink || '#')}">${esc(d.cta)} →</a></p>` : ''}
  </section>`;
}

function renderTeam(s) {
  const d = s.data || {};
  const members = (d.members || []).map((m) => `
    <li>
      ${m.imgUrl ? `<img src="${attr(m.imgUrl)}" alt="${attr(m.name || '')}" loading="lazy"/>` : ''}
      <h3>${esc(m.name || '')}</h3>
      ${m.role ? `<p class="ivy-role">${esc(m.role)}</p>` : ''}
      ${m.bio ? `<p>${esc(m.bio)}</p>` : ''}
    </li>`).join('');
  return `<section class="ivy-team">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    <ul>${members}</ul>
  </section>`;
}

function renderPricing(s) {
  const d = s.data || {};
  const tiers = (d.tiers || []).map((t) => `
    <li>
      <h3>${esc(t.name || '')}</h3>
      ${t.price ? `<p class="ivy-price">${esc(t.price)}</p>` : ''}
      ${t.description ? `<p>${esc(t.description)}</p>` : ''}
      <ul>${(t.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      ${t.ctaText ? `<p><a href="${attr(t.ctaLink || '#')}">${esc(t.ctaText)} →</a></p>` : ''}
    </li>`).join('');
  return `<section class="ivy-pricing">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <ul>${tiers}</ul>
  </section>`;
}

function renderNewsletter(s) {
  const d = s.data || {};
  return `<section class="ivy-newsletter">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
  </section>`;
}

function renderVideo(s) {
  const d = s.data || {};
  return `<section class="ivy-video">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${d.videoUrl ? `<p><a href="${attr(d.videoUrl)}">Watch video</a></p>` : ''}
  </section>`;
}

function renderLogos(s) {
  const d = s.data || {};
  const logos = (d.logos || []).map((l) => `<li>${esc(l.name || '')}</li>`).join('');
  return `<section class="ivy-logos">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    <ul>${logos}</ul>
  </section>`;
}

function renderPricingTable(s) {
  const d = s.data || {};
  const head = `<tr><th></th>${(d.tiers || []).map((t) => `<th>${esc(t)}</th>`).join('')}</tr>`;
  const body = (d.rows || []).map((r) => `
    <tr><th scope="row">${esc(r.label || '')}</th>${(r.values || []).map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
  return `<section class="ivy-pricing-table">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <table><thead>${head}</thead><tbody>${body}</tbody></table>
  </section>`;
}

function renderBlog(s) {
  const d = s.data || {};
  const posts = (d.posts || []).map((p) => `
    <article>
      <h3><a href="${attr(p.url || '#')}">${esc(p.title || '')}</a></h3>
      ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ''}
      ${p.date ? `<p class="ivy-date">${esc(p.date)}</p>` : ''}
    </article>`).join('');
  return `<section class="ivy-blog">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${posts}
  </section>`;
}

function renderInstagram(s) {
  const d = s.data || {};
  return `<section class="ivy-instagram">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${d.url ? `<p><a href="${attr(d.url)}">View on Instagram</a></p>` : ''}
  </section>`;
}

function renderCode(s) {
  const d = s.data || {};
  return `<section class="ivy-code">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    <pre><code>${esc(d.code || '')}</code></pre>
  </section>`;
}

function renderCountdown(s) {
  const d = s.data || {};
  // We don't run a JS clock server-side; emit the target date as text +
  // a data attribute so the SPA's countdown can hydrate over it.
  const end = d.endDate ? new Date(d.endDate).toUTCString() : '';
  return `<section class="ivy-countdown" data-end="${attr(end)}">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <p>${end ? `Ends ${esc(end)}` : ''}</p>
    ${d.cta ? `<p><a href="${attr(d.ctaLink || '#')}">${esc(d.cta)} →</a></p>` : ''}
  </section>`;
}

function renderHours(s) {
  const d = s.data || {};
  const rows = (d.days || []).map((r) => `<tr><th scope="row">${esc(r.label || '')}</th><td>${esc(r.hours || '')}</td></tr>`).join('');
  return `<section class="ivy-hours">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.timezone ? `<p>${esc(d.timezone)}</p>` : ''}
    <table><tbody>${rows}</tbody></table>
  </section>`;
}

function renderMap(s) {
  const d = s.data || {};
  return `<section class="ivy-map">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.address ? `<p>${esc(d.address)}</p>` : ''}
  </section>`;
}

function renderAccordion(s) {
  const d = s.data || {};
  const items = (d.items || []).map((q) => `
    <details>
      <summary>${esc(q.q || '')}</summary>
      <p>${esc(q.a || '')}</p>
    </details>`).join('');
  return `<section class="ivy-accordion">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${items}
  </section>`;
}

function renderProcess(s) {
  const d = s.data || {};
  const steps = (d.steps || []).map((st) => `
    <li>
      <strong>${esc(st.number || '')}</strong>
      <h3>${esc(st.title || '')}</h3>
      ${st.desc ? `<p>${esc(st.desc)}</p>` : ''}
    </li>`).join('');
  return `<section class="ivy-process">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <ol>${steps}</ol>
  </section>`;
}

function renderBeforeAfter(s) {
  const d = s.data || {};
  return `<section class="ivy-before-after">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    <figure>
      ${d.beforeUrl ? `<img src="${attr(d.beforeUrl)}" alt="${attr(d.beforeLabel || 'Before')}" loading="lazy"/>` : ''}
      <figcaption>${esc(d.beforeLabel || 'Before')}</figcaption>
    </figure>
    <figure>
      ${d.afterUrl ? `<img src="${attr(d.afterUrl)}" alt="${attr(d.afterLabel || 'After')}" loading="lazy"/>` : ''}
      <figcaption>${esc(d.afterLabel || 'After')}</figcaption>
    </figure>
  </section>`;
}

function renderSocialFeed(s) {
  const d = s.data || {};
  return `<section class="ivy-social-feed">
    ${d.headline ? `<h2>${esc(d.headline)}</h2>` : ''}
    ${d.sub ? `<p>${esc(d.sub)}</p>` : ''}
    ${d.url ? `<p><a href="${attr(d.url)}">View on ${esc(d.platform || 'social')}</a></p>` : ''}
  </section>`;
}

function renderCustomHtml(s) {
  const d = s.data || {};
  // Sandboxed iframe via srcdoc — crawlers see the iframe element but
  // can't follow into its content. Owner-supplied HTML is escaped into
  // an attribute so the sandbox=""'s rules apply.
  const safe = String(d.html || '').replace(/"/g, '&quot;');
  const height = Math.max(80, Math.min(2000, Number(d.height) || 280));
  return `<section class="ivy-custom-html"><iframe srcdoc="<!doctype html><html><body style='margin:0'>${safe}</body></html>" sandbox="" style="width:100%;height:${height}px;border:0;display:block" title="Custom embed"></iframe></section>`;
}

const RENDERERS = {
  hero:           renderHero,
  services:       renderServices,
  about:          renderAbout,
  booking:        renderBooking,
  testimonials:   renderTestimonials,
  faq:            renderFAQ,
  gallery:        renderGallery,
  contact:        renderContact,
  footer:         renderFooter,
  stats:          renderStats,
  cta_banner:     renderCtaBanner,
  team:           renderTeam,
  pricing:        renderPricing,
  newsletter:     renderNewsletter,
  video:          renderVideo,
  logos:          renderLogos,
  pricing_table:  renderPricingTable,
  blog:           renderBlog,
  instagram:      renderInstagram,
  code_snippet:   renderCode,
  countdown:      renderCountdown,
  hours:          renderHours,
  map:            renderMap,
  accordion:      renderAccordion,
  process:        renderProcess,
  before_after:   renderBeforeAfter,
  social_feed:    renderSocialFeed,
  custom_html:    renderCustomHtml,
};

function renderSection(section, handle) {
  if (!section || !section.visible) return '';
  const fn = RENDERERS[section.type];
  if (!fn) return '';
  const inner = fn(section, handle);
  const style = section.style || {};
  const hideMobile  = !!style.hideOnMobile;
  const hideDesktop = !!style.hideOnDesktop;
  const grad        = style.headlineGradient ? styleVal(style.headlineGradient) : '';
  if (!hideMobile && !hideDesktop && !grad) return inner;
  const sid = section.id;
  const css = [
    hideMobile  ? `@media (max-width: 720px)  { [data-section-id="${sid}"] { display: none !important; } }` : '',
    hideDesktop ? `@media (min-width: 721px)  { [data-section-id="${sid}"] { display: none !important; } }` : '',
    grad ? `[data-section-id="${sid}"] h1, [data-section-id="${sid}"] h2 { background: ${grad}; -webkit-background-clip: text; background-clip: text; color: transparent; }` : '',
  ].filter(Boolean).join(' ');
  return `<style>${css}</style><div data-section-id="${esc(sid)}">${inner}</div>`;
}

// ----- Inline styles for the static (pre-hydration) markup --------
//
// React replaces this once mounted. The styles here just need to make
// the crawler view (and the first paint before JS) presentable.

function renderBaseCss(vars) {
  const cssVars = Object.entries(vars)
    .map(([k, v]) => `${k}:${styleVal(v)}`)
    .join(';');
  return `
    .ivy-root { ${cssVars}; background: var(--site-bg); color: var(--site-fg); font-family: var(--site-font-body, system-ui, sans-serif); min-height: 100vh; }
    .ivy-root section, .ivy-root footer { padding: 64px 32px; max-width: 1200px; margin: 0 auto; }
    .ivy-root h1, .ivy-root h2, .ivy-root h3 { font-family: var(--site-font-display, serif); letter-spacing: -0.02em; }
    .ivy-root h1 { font-size: clamp(36px, 5vw, 56px); margin: 0 0 16px; }
    .ivy-root h2 { font-size: clamp(26px, 3vw, 36px); margin: 0 0 12px; }
    .ivy-root h3 { font-size: clamp(18px, 2vw, 22px); margin: 0 0 8px; }
    .ivy-root p { color: var(--site-fg-2, inherit); line-height: 1.6; margin: 0 0 12px; }
    .ivy-root a { color: var(--site-accent, inherit); text-decoration: none; }
    .ivy-root ul { list-style: none; padding: 0; }
    .ivy-cta a { display: inline-block; padding: 12px 22px; background: var(--site-accent); color: var(--site-accent-ink); border-radius: var(--site-radius, 10px); margin-top: 16px; font-weight: 550; }
    .ivy-nav { padding: 14px 32px; display: flex; gap: 18px; align-items: center; border-bottom: 1px solid var(--site-border); }
    .ivy-nav a { color: var(--site-fg-2); font-weight: 500; }
    .ivy-nav a.active { color: var(--site-accent); }
    .ivy-nav .ivy-brand { font-family: var(--site-font-display); font-size: 18px; color: var(--site-fg); font-weight: 600; flex: 1; }
  `.replace(/\s+/g, ' ').trim();
}

// ----- Nav --------------------------------------------------------

function renderNav({ handle, nav, currentSlug, businessName }) {
  if (!nav || nav.length < 2) return '';
  const links = nav.map((p) => {
    const href = p.slug ? `/site/${handle}/${p.slug}` : `/site/${handle}`;
    const active = (p.slug || '') === (currentSlug || '') ? ' active' : '';
    return `<a class="${active.trim()}" href="${attr(href)}">${esc(p.title || (p.slug ? p.slug : 'Home'))}</a>`;
  }).join('');
  return `<nav class="ivy-nav">
    <a class="ivy-brand" href="/site/${attr(handle)}">${esc(businessName || handle)}</a>
    ${links}
  </nav>`;
}

// ----- JSON-LD ----------------------------------------------------

function renderJsonLd({ businessName, description, image, url, sections }) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: businessName || undefined,
    description: description || undefined,
    image: image || undefined,
    url: url || undefined,
  };
  // If a testimonials section has items, surface as aggregateRating.
  const tSection = (sections || []).find((s) => s && s.type === 'testimonials' && s.visible);
  if (tSection && Array.isArray(tSection.data?.items) && tSection.data.items.length > 0) {
    const ratings = tSection.data.items.map((i) => Number(i.rating) || 5);
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    ld.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: avg.toFixed(1),
      reviewCount: ratings.length,
    };
  }
  // Pull contact details out of the first contact section if present.
  const cSection = (sections || []).find((s) => s && s.type === 'contact' && s.visible);
  if (cSection) {
    if (cSection.data?.email) ld.email = cSection.data.email;
    if (cSection.data?.phone) ld.telephone = cSection.data.phone;
  }
  // Strip undefined entries for cleanliness.
  for (const k of Object.keys(ld)) if (ld[k] === undefined) delete ld[k];
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

// ----- Sticky CTA + exit-intent popup --------------------------

function renderStickyCta(cfg) {
  if (!cfg || !cfg.enabled || !cfg.text) return '';
  const pos = cfg.position === 'top' ? 'top:0' : 'bottom:0';
  return `<a href="${attr(cfg.link || '#')}" style="position:fixed;${pos};left:0;right:0;z-index:9000;padding:14px 24px;background:var(--site-accent);color:var(--site-accent-ink);text-align:center;font-weight:600;text-decoration:none;font-family:var(--site-font-body)">${esc(cfg.text)} →</a>`;
}

function renderExitIntent(cfg) {
  if (!cfg || !cfg.enabled || !cfg.headline) return '';
  // Hidden by default; the inline script attaches a single mouseleave
  // handler to the document and reveals on first exit. Stored in
  // sessionStorage so we don't re-pop on every internal nav.
  return `
    <div id="ivy-exit-intent" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;padding:24px;font-family:var(--site-font-body)">
      <div style="max-width:480px;background:var(--site-bg);color:var(--site-fg);padding:32px;border-radius:var(--site-radius);border:1px solid var(--site-border);position:relative">
        <button onclick="document.getElementById('ivy-exit-intent').style.display='none'" style="position:absolute;top:10px;right:14px;background:transparent;border:0;font-size:20px;color:var(--site-muted);cursor:pointer">×</button>
        <h3 style="margin:0;font-family:var(--site-font-display);font-size:24px">${esc(cfg.headline)}</h3>
        ${cfg.sub ? `<p style="margin:10px 0 0;color:var(--site-fg-2);line-height:1.55">${esc(cfg.sub)}</p>` : ''}
        ${cfg.cta ? `<p style="margin:20px 0 0"><a href="${attr(cfg.ctaLink || '#')}" style="display:inline-block;padding:12px 22px;background:var(--site-accent);color:var(--site-accent-ink);border-radius:var(--site-radius);text-decoration:none;font-weight:600">${esc(cfg.cta)} →</a></p>` : ''}
      </div>
    </div>
    <script>(function(){try{var el=document.getElementById('ivy-exit-intent');if(!el)return;if(sessionStorage.getItem('ivy-exit-shown'))return;document.addEventListener('mouseleave',function(e){if(e.clientY<10){el.style.display='flex';sessionStorage.setItem('ivy-exit-shown','1')}})}catch(_){}})();</script>
  `;
}

// ----- Main entry -------------------------------------------------

// Render the full HTML page for a public site.
// Inputs: { site, page, nav, handle, currentSlug, host }
// Returns: HTML string ready to be sent with content-type: text/html.
export function renderSiteHtml({ site, page, nav, handle, currentSlug, host }) {
  const tpl = TEMPLATES[site.template] || TEMPLATES.clean;
  const vars = { ...tpl.vars };
  if (site.fontPair && FONT_PAIRS[site.fontPair]) {
    vars['--site-font-display'] = FONT_PAIRS[site.fontPair].display;
    vars['--site-font-body']    = FONT_PAIRS[site.fontPair].body;
  }

  const sections = page.sections || [];
  const visible = sections.filter((s) => s.visible !== false);

  // SEO resolution: page-level wins, site-level fallback, business name
  // is the ultimate fallback.
  const pageMetaTitle = page.metaTitle || null;
  const baseTitle = site.seoTitle || site.businessName || handle;
  const title = pageMetaTitle
    || (page.title && page.title !== 'Home' ? `${page.title} · ${baseTitle}` : baseTitle);
  // Description: page meta → site default → first hero/about copy → null.
  let description = page.metaDescription || site.seoDescription;
  if (!description) {
    const heroSec = visible.find((s) => s.type === 'hero');
    if (heroSec?.data?.sub) description = heroSec.data.sub;
    else {
      const aboutSec = visible.find((s) => s.type === 'about');
      if (aboutSec?.data?.body) description = String(aboutSec.data.body).slice(0, 240);
    }
  }
  const ogImage = page.ogImage || site.seoOgImage || null;
  const canonical = host
    ? `https://${host}/site/${handle}${currentSlug ? `/${currentSlug}` : ''}`
    : null;
  const favicon = site.faviconUrl || null;

  const headExtras = [
    `<title>${esc(title)}</title>`,
    description ? `<meta name="description" content="${attr(description)}"/>` : '',
    canonical ? `<link rel="canonical" href="${attr(canonical)}"/>` : '',
    favicon ? `<link rel="icon" href="${attr(favicon)}"/>` : '',
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:title" content="${attr(title)}"/>`,
    description ? `<meta property="og:description" content="${attr(description)}"/>` : '',
    ogImage ? `<meta property="og:image" content="${attr(ogImage)}"/>` : '',
    canonical ? `<meta property="og:url" content="${attr(canonical)}"/>` : '',
    `<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}"/>`,
    `<meta name="twitter:title" content="${attr(title)}"/>`,
    description ? `<meta name="twitter:description" content="${attr(description)}"/>` : '',
    ogImage ? `<meta name="twitter:image" content="${attr(ogImage)}"/>` : '',
    `<style>${renderBaseCss(vars)}</style>`,
    site.customCss ? `<style>${String(site.customCss).replace(/<\/style/gi, '<\\/style')}</style>` : '',
    renderJsonLd({
      businessName: site.businessName,
      description,
      image: ogImage,
      url: canonical,
      sections: visible,
    }),
  ].filter(Boolean).join('\n');

  const navHtml = renderNav({ handle, nav, currentSlug, businessName: site.businessName });
  const sectionsHtml = visible.map((s) => renderSection(s, handle)).join('\n');
  // Pageview ping — fires once on initial paint. Crawlers don't run JS
  // so we naturally exclude them; the UA classifier on the API side
  // also tags bots so any that DO run JS get bucketed away.
  const pvScript = `<script>(function(){try{navigator.sendBeacon&&navigator.sendBeacon('/site/${esc(handle)}/pv',new Blob([JSON.stringify({slug:${JSON.stringify(currentSlug || '')},referrer:document.referrer.slice(0,300)})],{type:'application/json'}))||fetch('/site/${esc(handle)}/pv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:${JSON.stringify(currentSlug || '')},referrer:document.referrer.slice(0,300)}),keepalive:true})}catch(e){}})();</script>`;
  // Exit-intent popup + sticky CTA injected once at the root level so
  // they survive page transitions inside the SPA.
  const popupHtml   = renderExitIntent(site.exitIntentPopup);
  const stickyHtml  = renderStickyCta(site.stickyCta);
  const bodyContent = `<div class="ivy-root">${navHtml}${sectionsHtml}${stickyHtml}${popupHtml}</div>${pvScript}`;

  // Splice into the SPA shell.
  let shell = loadShell();
  // 1. Replace <title>...
  shell = shell.replace(/<title>[\s\S]*?<\/title>/i, '');
  // 2. Remove the existing app-level <meta name="description">.
  shell = shell.replace(/<meta\s+name="description"[^>]*>/i, '');
  // 3. Insert head extras before </head>.
  shell = shell.replace(/<\/head>/i, `${headExtras}\n</head>`);
  // 4. Inject body content into <div id="root">...</div>.
  shell = shell.replace(
    /<div\s+id="root"[^>]*>[\s\S]*?<\/div>/i,
    `<div id="root">${bodyContent}</div>`,
  );

  return shell;
}

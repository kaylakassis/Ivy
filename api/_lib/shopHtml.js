// Server-rendered HTML for a public shop page (/shop/:slug).
//
// Same idea as api/_lib/siteHtml.js: crawlers and link previews get the
// title, description, canonical, Open Graph tags, a LocalBusiness JSON-LD
// block (with every member as a Person that makesOffer its services, and a
// BreadcrumbList) plus readable markup for the hero, the team, the services
// and the reviews. The React page (src/features/shops/PublicShop.jsx)
// mounts on top and adds the live parts: next available times, first
// available across the shop, the booking hand-off.
import { TEMPLATES } from '../../src/features/website/templates.js';
import { esc, jsonForScript, renderIntoShell } from './siteHtml.js';
import { SHOP_AMENITY_LABELS, normalizeShopSettings } from './shops.js';
import { openStatus, hoursLines, groupServices, fmtPrice } from '../../src/features/shops/shopHelpers.js';

const attr = (s) => esc(s);
const styleVal = (s) => String(s ?? '').replace(/[<>"']/g, '');
const DAY_SCHEMA = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function baseCss(vars) {
  const cssVars = Object.entries(vars).map(([k, v]) => `${k}:${styleVal(v)}`).join(';');
  return `
    .sh-ssr { ${cssVars}; background: var(--site-bg); color: var(--site-fg); font-family: var(--site-font-body, system-ui, sans-serif); min-height: 100vh; }
    .sh-ssr section { padding: 40px 20px; max-width: 980px; margin: 0 auto; }
    .sh-ssr h1, .sh-ssr h2, .sh-ssr h3 { font-family: var(--site-font-display, serif); letter-spacing: -0.02em; margin: 0 0 10px; }
    .sh-ssr h1 { font-size: clamp(30px, 5vw, 48px); }
    .sh-ssr h2 { font-size: clamp(22px, 3vw, 30px); }
    .sh-ssr p { color: var(--site-fg-2, inherit); line-height: 1.6; margin: 0 0 10px; }
    .sh-ssr a { color: var(--site-accent, inherit); }
    .sh-ssr ul { padding-left: 18px; }
    .sh-ssr .sh-cta { display: inline-block; padding: 12px 22px; background: var(--site-accent); color: var(--site-accent-ink); border-radius: var(--site-radius, 10px); text-decoration: none; font-weight: 600; margin-top: 10px; }
    .sh-ssr .sh-team { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; list-style: none; padding: 0; }
    .sh-ssr .sh-team li { border: 1px solid var(--site-border); border-radius: var(--site-radius, 12px); padding: 16px; }
    .sh-ssr img { max-width: 100%; border-radius: var(--site-radius, 12px); }
  `.replace(/\s+/g, ' ').trim();
}

function jsonLd({ shop, members, rating, canonical, services, origin }) {
  const hours = shop.hours || {};
  const openingHours = [];
  for (let d = 0; d <= 6; d++) {
    for (const w of (hours[String(d)] || [])) {
      openingHours.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_SCHEMA[d], opens: hhmm(w.start), closes: hhmm(w.end) });
    }
  }
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': canonical ? `${canonical}#shop` : undefined,
    name: shop.name,
    description: shop.tagline || shop.description || undefined,
    url: canonical || undefined,
    image: shop.photos?.length ? shop.photos.slice(0, 6) : undefined,
    telephone: shop.phone || undefined,
    address: shop.addressLabel ? {
      '@type': 'PostalAddress',
      streetAddress: shop.addressLabel,
      addressLocality: shop.city || undefined,
      addressRegion: shop.region || undefined,
      addressCountry: shop.country || undefined,
    } : undefined,
    geo: (shop.lat != null && shop.lng != null) ? { '@type': 'GeoCoordinates', latitude: shop.lat, longitude: shop.lng } : undefined,
    openingHoursSpecification: openingHours.length ? openingHours : undefined,
    amenityFeature: (shop.amenities || []).map((a) => ({ '@type': 'LocationFeatureSpecification', name: SHOP_AMENITY_LABELS[a] || a, value: true })),
    aggregateRating: rating?.count > 0 && rating?.avg ? { '@type': 'AggregateRating', ratingValue: Number(rating.avg).toFixed(1), reviewCount: rating.count } : undefined,
    employee: members.map((m) => ({
      '@type': 'Person',
      name: m.proName || m.businessName,
      jobTitle: m.title || undefined,
      description: m.bio || undefined,
      image: m.photoUrl || undefined,
      url: origin ? `${origin}${m.bookUrl}` : m.bookUrl,
      worksFor: { '@type': 'Organization', name: m.businessName, url: origin ? `${origin}${m.bookUrl}` : m.bookUrl },
      makesOffer: (m.services || []).slice(0, 20).map((s) => ({
        '@type': 'Offer',
        itemOffered: { '@type': 'Service', name: s.name, description: s.description || undefined },
        ...(s.hidePrice || !(s.price > 0) ? {} : { price: Number(s.price).toFixed(2), priceCurrency: 'USD' }),
        url: origin ? `${origin}${m.bookUrl}?service=${encodeURIComponent(s.id)}` : undefined,
      })),
      aggregateRating: m.reviews?.count > 0 && m.reviews?.avg ? { '@type': 'AggregateRating', ratingValue: Number(m.reviews.avg).toFixed(1), reviewCount: m.reviews.count } : undefined,
    })),
    hasOfferCatalog: services.length ? {
      '@type': 'OfferCatalog', name: `Services at ${shop.name}`,
      itemListElement: services.slice(0, 40).map((g) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: g.name }, ...(g.fromPrice > 0 ? { price: Number(g.fromPrice).toFixed(2), priceCurrency: 'USD' } : {}) })),
    } : undefined,
  };
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) { if (o[k] === undefined) delete o[k]; else o[k] = clean(o[k]); }
    }
    return o;
  };
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Ivy', item: origin || 'https://www.joinivy.ai' },
      { '@type': 'ListItem', position: 2, name: 'Shops', item: origin ? `${origin}/me/discover` : 'https://www.joinivy.ai/me/discover' },
      { '@type': 'ListItem', position: 3, name: shop.name, item: canonical || undefined },
    ],
  };
  return `<script type="application/ld+json">${jsonForScript(clean(ld))}</script>\n<script type="application/ld+json">${jsonForScript(clean(crumbs))}</script>`;
}

// payload: the result of publicShopPayload (not archived).
export function renderShopHtml({ payload, host }) {
  const { shop, members, rating } = payload;
  const settings = normalizeShopSettings(shop.settings);
  const tpl = TEMPLATES[settings.theme] || TEMPLATES.clean;
  const origin = host ? `https://${host}` : '';
  const canonical = origin ? `${origin}/shop/${shop.slug}` : null;
  const city = shop.city || '';
  const groups = groupServices(members);
  const serviceNames = groups.slice(0, 4).map((g) => g.name).join(', ');
  const title = city ? `${shop.name} · ${city}` : shop.name;
  const description = (shop.tagline || shop.description || (
    `${shop.name}${city ? ` in ${city}` : ''}: ${members.length} ${members.length === 1 ? 'pro' : 'pros'} you can book online${serviceNames ? `. ${serviceNames}` : ''}.`
  )).slice(0, 300);
  const ogImage = shop.photos?.[0] || members.find((m) => m.photoUrl)?.photoUrl || `${origin || 'https://www.joinivy.ai'}/og-image.png`;
  const status = openStatus(shop.hours, shop.timezone);

  const headExtras = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${attr(description)}"/>`,
    canonical ? `<link rel="canonical" href="${attr(canonical)}"/>` : '',
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:title" content="${attr(title)}"/>`,
    `<meta property="og:description" content="${attr(description)}"/>`,
    `<meta property="og:image" content="${attr(ogImage)}"/>`,
    canonical ? `<meta property="og:url" content="${attr(canonical)}"/>` : '',
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${attr(title)}"/>`,
    `<meta name="twitter:description" content="${attr(description)}"/>`,
    `<meta name="twitter:image" content="${attr(ogImage)}"/>`,
    `<style>${baseCss(tpl.vars)}</style>`,
    jsonLd({ shop, members, rating, canonical, services: groups, origin }),
  ].filter(Boolean).join('\n');

  const photos = (shop.photos || []).slice(0, 4).map((u) => `<img src="${attr(u)}" alt="${attr(shop.name)}" loading="lazy" width="480" height="320"/>`).join('');
  const amenities = (shop.amenities || []).map((a) => `<li>${esc(SHOP_AMENITY_LABELS[a] || a)}</li>`).join('');
  const hours = hoursLines(shop.hours).map((l) => `<li>${esc(l.day)}: ${esc(l.text)}</li>`).join('');
  const team = members.map((m) => {
    const r = m.reviews?.count > 0 && m.reviews?.avg ? `<p>Rated ${Number(m.reviews.avg).toFixed(1)} from ${m.reviews.count} review${m.reviews.count === 1 ? '' : 's'}</p>` : '';
    const svc = (m.services || []).slice(0, 6).map((s) => `<li>${esc(s.name)}${!s.hidePrice && s.price > 0 ? ` · ${esc(fmtPrice(s.price))}` : ''}</li>`).join('');
    return `<li>
      ${m.photoUrl ? `<img src="${attr(m.photoUrl)}" alt="${attr(m.proName || m.businessName)}" width="72" height="72" loading="lazy"/>` : ''}
      <h3>${esc(m.proName || m.businessName)}</h3>
      ${m.title ? `<p><strong>${esc(m.title)}</strong></p>` : ''}
      ${m.businessName && m.businessName !== m.proName ? `<p>${esc(m.businessName)}</p>` : ''}
      ${m.bio ? `<p>${esc(m.bio)}</p>` : ''}
      ${r}
      ${svc ? `<ul>${svc}</ul>` : ''}
      <a class="sh-cta" href="${attr(m.bookUrl)}?shop=${attr(shop.slug)}">Book with ${esc(m.firstName || m.businessName)}</a>
    </li>`;
  }).join('');
  const services = groups.map((g) => `<li>${esc(g.name)}${g.fromPrice > 0 ? ` · from ${esc(fmtPrice(g.fromPrice))}` : ''} · ${g.members.length === 1 ? esc(g.members[0].firstName) : `${g.members.length} pros`}</li>`).join('');
  const reviews = members.flatMap((m) => (m.reviews?.recent || []).slice(0, 2).map((r) => ({ ...r, who: m.firstName || m.businessName })))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8)
    .map((r) => `<li><strong>${esc(r.reviewerName)}</strong> on ${esc(r.who)} · ${r.rating}/5${r.text ? `<p>${esc(r.text)}</p>` : ''}</li>`).join('');

  const bodyContent = `<div class="sh-ssr">
    <section>
      <h1>${esc(shop.name)}</h1>
      ${shop.tagline ? `<p>${esc(shop.tagline)}</p>` : ''}
      ${shop.addressLabel ? `<p>${esc(shop.addressLabel)}</p>` : ''}
      ${status.label ? `<p>${esc(status.label)}</p>` : ''}
      ${shop.phone ? `<p><a href="tel:${attr(shop.phone.replace(/[^\d+]/g, ''))}">${esc(shop.phone)}</a></p>` : ''}
      ${photos}
      <a class="sh-cta" href="#book">Book now</a>
    </section>
    ${amenities ? `<section><h2>Good to know</h2><ul>${amenities}</ul></section>` : ''}
    ${hours ? `<section><h2>Hours</h2><ul>${hours}</ul></section>` : ''}
    <section><h2>The team</h2><ul class="sh-team">${team}</ul></section>
    ${services ? `<section id="book"><h2>Book a service</h2><ul>${services}</ul>${settings.bookingRulesNote ? `<p>${esc(settings.bookingRulesNote)}</p>` : ''}</section>` : ''}
    ${shop.description ? `<section><h2>About ${esc(shop.name)}</h2><p>${esc(shop.description)}</p></section>` : ''}
    ${reviews ? `<section><h2>Reviews</h2>${rating?.count ? `<p>${Number(rating.avg).toFixed(1)} from ${rating.count} review${rating.count === 1 ? '' : 's'}. Reviews come from clients of each pro.</p>` : ''}<ul>${reviews}</ul></section>` : ''}
  </div>`;

  return renderIntoShell({ headExtras, bodyContent });
}

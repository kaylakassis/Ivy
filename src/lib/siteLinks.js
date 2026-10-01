// Anchors and link targets for published sites. Shared by the server
// renderer (api/_lib/siteHtml.js, via a copy in api/_lib/siteLinks.js) and
// the in-app renderer. Keep the two copies identical.
//
// Every visible section gets a stable, human anchor from its type
// ("gallery", "contact", "about"), or its own `anchor` field when the
// owner set one; duplicates get -2, -3. A button link that starts with
// "#" is then resolved against the page:
//   #gallery     → that section on this page
//   #portfolio   → the Portfolio page, when the site has one
//   #portfolio   → the first gallery on this page, via an alias, otherwise
//   #home / #top → the site's home page
// Unknown targets are left alone.

const ALIASES = {
  portfolio: ['gallery', 'before_after', 'instagram', 'social_feed'],
  work: ['gallery', 'before_after'],
  photos: ['gallery', 'instagram'],
  writing: ['blog'], posts: ['blog'], articles: ['blog'],
  book: ['booking'], booking: ['booking'], schedule: ['booking'], appointments: ['booking'],
  contact: ['contact', 'map'], reach: ['contact'],
  about: ['about', 'team'], story: ['about'],
  services: ['services', 'pricing', 'pricing_table'], menu: ['services'],
  pricing: ['pricing', 'pricing_table'], prices: ['pricing', 'pricing_table'], plans: ['pricing_table', 'pricing'], packages: ['pricing', 'pricing_table'],
  faq: ['faq', 'accordion'], questions: ['faq', 'accordion'],
  reviews: ['testimonials'], testimonials: ['testimonials'],
  team: ['team'], shop: ['shop'], store: ['shop'], products: ['shop'],
  hours: ['hours'], map: ['map'], location: ['map', 'hours'], directions: ['map'],
  video: ['video'], newsletter: ['newsletter'], subscribe: ['newsletter'],
  stats: ['stats'], process: ['process'], countdown: ['countdown'], logos: ['logos'],
};

const slugify = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

// { [section.id]: anchor } for the visible sections of one page.
export function sectionAnchors(sections) {
  const used = new Set();
  const out = {};
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!s || s.visible === false) continue;
    const base = slugify(s.anchor) || slugify(s.type) || 'section';
    let a = base; let n = 2;
    while (used.has(a)) a = `${base}-${n++}`;
    used.add(a);
    if (s.id) out[s.id] = a;
  }
  return out;
}

export function resolveSiteLink(href, ctx = {}) {
  if (href == null) return href;
  const h = String(href).trim();
  if (!h.startsWith('#')) return h;
  const key = slugify(h.slice(1));
  if (!key) return h;
  const { anchors = {}, pages = [], linkBase = '', sections = [], bookingHref = '' } = ctx;
  const present = new Set(Object.values(anchors));
  if (present.has(key)) return `#${key}`;
  if (key === 'home' || key === 'top') return linkBase ? `${linkBase}` : '/';
  if (pages.some((p) => (p.slug || '') === key)) return `${linkBase}/${key}`;
  for (const type of ALIASES[key] || []) {
    const s = sections.find((x) => x && x.visible !== false && x.type === type && anchors[x.id]);
    if (s) return `#${anchors[s.id]}`;
  }
  // "Book" with no booking section on this page: the public booking page.
  if (bookingHref && ['book', 'booking', 'schedule', 'appointments', 'book-now'].includes(key)) return bookingHref;
  return h;
}

// Section catalog - the library of blocks users can add to their site.
// Each section has a `type`, default data, and a human-friendly label/description.

// Category pills that show above the catalog in the section library.
// Sections opt into one of these via the `category` field; "all" is
// implied (no filter applied).
export const SECTION_CATEGORIES = {
  header:       { label: 'Header & hero' },
  social_proof: { label: 'Social proof' },
  content:      { label: 'Content' },
  cta:          { label: 'Calls to action' },
  commerce:     { label: 'Pricing & commerce' },
  embed:        { label: 'Media & social' },
};

// Section types that were added by pasting code. They are no longer in the
// library (owners never see or type code in Ivy), Ivy's tools refuse to add
// or edit them, and the server refuses new ones. Sites that already have
// one keep rendering exactly as before; the editor shows a plain panel with
// Remove / Open section library.
export const LEGACY_CODE_TYPES = new Set(['code_snippet', 'custom_html']);
export const isLegacyCodeType = (type) => LEGACY_CODE_TYPES.has(type);

export const SECTION_TYPES = {
  hero: {
    label: 'Hero',
    icon: 'Home',
    desc: 'Big headline and a button',
    category: 'header',
    variants: [
      { id: 'center',      label: 'Centered' },
      { id: 'left',        label: 'Left aligned' },
      { id: 'split_image', label: 'Split with image' },
      { id: 'image_bg',    label: 'Image background' },
      { id: 'video_bg',    label: 'Video background' },
      { id: 'centered_image_below', label: 'Centered with image below' },
    ],
    default: (biz) => ({
      headline: biz ? `Welcome to ${biz}` : 'Your headline here',
      sub: 'A short line that tells visitors what you do and who you do it for.',
      cta: 'Book a session',
      ctaLink: '',
      align: 'center',
      imgUrl: '',     // split_image, image_bg, centered_image_below
      videoUrl: '',   // video_bg variant - looping muted MP4 background
    }),
  },
  // Product storefront. Renders live from /api/site/:handle/products
  // (active products only) - owners manage the catalog in
  // Finance → Products; the section itself only has a heading, an intro
  // and a sold-out toggle. Add-to-cart + checkout are wired in
  // SectionRenderer's Shop renderer.
  shop: {
    label: 'Shop',
    icon: 'Gift',
    desc: 'Sell your products, with a cart and checkout',
    category: 'commerce',
    default: () => ({
      headline: 'Shop',
      sub: '',
      showOutOfStock: false,
    }),
  },
  services: {
    label: 'Services',
    icon: 'Dollar',
    desc: 'What you offer, with prices',
    category: 'commerce',
    variants: [
      { id: 'grid', label: 'Grid (3-up)' },
      { id: 'list', label: 'List (stacked)' },
      { id: 'cards_image', label: 'Cards with image' },
      { id: 'featured_one', label: 'Featured (1 large + 2 small)' },
    ],
    default: () => ({
      headline: 'What I Offer',
      sub: '',
      items: [
        { id: 'i1', name: 'Intro session',    desc: 'A short call to see if we are a good fit.',        price: '$45',  duration: '30 min', imgUrl: '' },
        { id: 'i2', name: 'Standard session', desc: 'The core offering - one hour of focused work.',    price: '$85',  duration: '60 min', imgUrl: '' },
        { id: 'i3', name: 'Full assessment',  desc: 'Deep-dive session with a written summary after.',  price: '$140', duration: '90 min', imgUrl: '' },
      ],
    }),
  },
  about: {
    label: 'About',
    icon: 'Users',
    desc: 'Your story and a photo',
    category: 'content',
    default: () => ({
      headline: 'About Me',
      body: 'Write your story here. Share what makes you unique, what drives you, and what clients can expect when they work with you.',
      imgUrl: '',
    }),
  },
  booking: {
    label: 'Booking',
    icon: 'Calendar',
    desc: 'Live booking widget from your calendar',
    category: 'cta',
    default: () => ({
      headline: 'Book a Session',
      sub: 'Choose a time that works for you.',
      handle: '',
    }),
  },
  testimonials: {
    label: 'Reviews',
    icon: 'Heart',
    desc: 'Client testimonials',
    category: 'social_proof',
    variants: [
      { id: 'grid',         label: 'Grid (2–3 cards)' },
      { id: 'single_large', label: 'Single large quote' },
      { id: 'wall',         label: 'Wall (4+)' },
    ],
    default: () => ({
      headline: 'What Clients Say',
      items: [
        { id: 't1', name: 'Alex R.',  role: 'Client since 2023', text: 'Working with them was an amazing experience. Highly recommend.', rating: 5 },
        { id: 't2', name: 'Maya K.',  role: 'Client since 2024', text: 'I saw real progress within the first few sessions.',              rating: 5 },
      ],
    }),
  },
  // Shows the owner's cancellation policy, always the latest saved
  // version (written in Finance > Services). Only the heading is stored
  // in the section; the text is read live, never copied in.
  cancellation_policy: {
    label: 'Cancellation policy',
    icon: 'Lock',
    desc: 'Your cancellation policy, always up to date',
    category: 'content',
    default: () => ({
      headline: 'Cancellation policy',
      sub: '',
    }),
  },
  faq: {
    label: 'FAQ',
    icon: 'Chat',
    desc: 'Frequently asked questions',
    category: 'content',
    default: () => ({
      headline: 'Frequently Asked Questions',
      items: [
        { id: 'f1', q: 'How do I get started?', a: 'Click "Book a session" to pick a time that works for you.' },
        { id: 'f2', q: 'Do you offer refunds?', a: 'Yes, within 24 hours of your first session if it is not the right fit.' },
      ],
    }),
  },
  gallery: {
    label: 'Gallery',
    icon: 'Image',
    desc: 'Photo grid',
    category: 'embed',
    variants: [
      { id: 'grid',     label: 'Grid (uniform)' },
      { id: 'masonry',  label: 'Masonry (variable heights)' },
      { id: 'carousel', label: 'Carousel (swipe)' },
    ],
    default: () => ({
      headline: 'Gallery',
      photos: [],
    }),
  },
  contact: {
    label: 'Contact',
    icon: 'Mail',
    desc: 'A contact form and your details',
    category: 'cta',
    default: () => ({
      headline: 'Get in Touch',
      sub: "I'd love to hear from you.",
      email: '',
      phone: '',
      showForm: true,
    }),
  },
  footer: {
    label: 'Footer',
    icon: 'Globe',
    desc: 'Your business name at the bottom of the page',
    category: 'content',
    default: (biz) => ({
      businessName: biz || 'My Business',
      tagline: '',
      year: new Date().getFullYear(),
    }),
  },
  stats: {
    label: 'Stats',
    icon: 'Trending',
    desc: 'Big numbers: clients served, years in business, and so on',
    category: 'social_proof',
    default: () => ({
      headline: '',
      sub: '',
      items: [
        { id: 's1', value: '500+', label: 'Sessions delivered' },
        { id: 's2', value: '8 yrs', label: 'In practice' },
        { id: 's3', value: '4.9★', label: 'Average rating' },
      ],
    }),
  },
  cta_banner: {
    label: 'Call to action',
    icon: 'Spark',
    desc: 'A bold line with a button, edge to edge',
    category: 'cta',
    default: () => ({
      headline: 'Ready to start?',
      sub: "Book a 20-minute intro call - no commitment.",
      cta: 'Book now',
      ctaLink: '',
    }),
  },
  team: {
    label: 'Team',
    icon: 'Users',
    desc: 'Photos, names and short bios of your team',
    category: 'content',
    default: () => ({
      headline: 'Meet the team',
      members: [
        { id: 'm1', name: 'Sam Johnson', role: 'Lead practitioner', bio: 'Short bio - what they do, what makes them great.', imgUrl: '', link: '' },
        { id: 'm2', name: 'Alex Rivera', role: 'Associate',         bio: 'Short bio - what they do, what makes them great.', imgUrl: '', link: '' },
      ],
    }),
  },
  pricing: {
    label: 'Pricing tiers',
    icon: 'Dollar',
    desc: 'Plans side by side, each with a button',
    category: 'commerce',
    default: () => ({
      headline: 'Pricing',
      sub: 'Pick what fits.',
      tiers: [
        { id: 'p1', name: 'Starter',  price: '$99/mo',  description: 'For trying things out', features: ['One session/mo', 'Email support', 'Cancel anytime'], featured: false, ctaText: 'Start', ctaLink: '' },
        { id: 'p2', name: 'Standard', price: '$199/mo', description: 'For regular work',     features: ['Three sessions/mo', 'SMS + email support', 'Priority booking'], featured: true,  ctaText: 'Choose plan', ctaLink: '' },
        { id: 'p3', name: 'Premium',  price: '$399/mo', description: 'All-in',                features: ['Unlimited sessions', '24/7 support', 'Custom plan'], featured: false, ctaText: 'Get premium', ctaLink: '' },
      ],
    }),
  },
  newsletter: {
    label: 'Newsletter',
    icon: 'Mail',
    desc: 'Let visitors leave their email address',
    category: 'cta',
    default: () => ({
      headline: 'Stay in touch',
      sub: 'Occasional emails about what I am working on - no spam.',
      buttonText: 'Subscribe',
      placeholder: 'you@example.com',
      successMessage: "You're subscribed - thanks!",
    }),
  },
  video: {
    label: 'Video',
    icon: 'Image',
    desc: 'A video from YouTube, Vimeo or Loom',
    category: 'embed',
    default: () => ({
      headline: '',
      sub: '',
      videoUrl: '',  // the normal watch / share link; the renderer converts it
    }),
  },
  logos: {
    label: 'Featured in',
    icon: 'Globe',
    desc: 'A row of logos: press, partners, "as seen in"',
    category: 'social_proof',
    default: () => ({
      headline: 'Featured in',
      logos: [
        { id: 'l1', name: 'Vogue',    imgUrl: '', link: '' },
        { id: 'l2', name: 'NYT',      imgUrl: '', link: '' },
        { id: 'l3', name: 'Forbes',   imgUrl: '', link: '' },
        { id: 'l4', name: 'WSJ',      imgUrl: '', link: '' },
      ],
    }),
  },
  pricing_table: {
    label: 'Pricing comparison',
    icon: 'Dollar',
    desc: 'A table comparing your plans feature by feature',
    category: 'commerce',
    default: () => ({
      headline: 'Compare plans',
      sub: '',
      tiers: ['Starter', 'Standard', 'Premium'],
      rows: [
        { id: 'r1', label: 'Sessions per month', values: ['1', '3', 'Unlimited'] },
        { id: 'r2', label: 'Email support',      values: ['✓', '✓', '✓'] },
        { id: 'r3', label: 'SMS support',        values: ['',  '✓', '✓'] },
        { id: 'r4', label: '24/7 access',        values: ['',  '',  '✓'] },
        { id: 'r5', label: 'Price',              values: ['$99', '$199', '$399'] },
      ],
    }),
  },
  blog: {
    label: 'Blog / posts',
    icon: 'Doc',
    desc: 'Your latest articles: title, short preview and a link',
    category: 'content',
    default: () => ({
      headline: 'Latest writing',
      sub: '',
      posts: [
        { id: 'p1', title: 'How I think about pricing', excerpt: 'A short preview of the post.', url: '#',        date: '2026-04-12' },
        { id: 'p2', title: 'The 3 questions I ask',     excerpt: 'A short preview of the post.', url: '#',        date: '2026-03-28' },
        { id: 'p3', title: 'My intake process, refined', excerpt: 'A short preview of the post.', url: '#',       date: '2026-03-01' },
      ],
    }),
  },
  instagram: {
    label: 'Instagram',
    icon: 'Image',
    desc: 'Show an Instagram post, or a button to your profile',
    category: 'embed',
    default: () => ({
      headline: 'Follow along',
      sub: '',
      url: '',  // a post / reel link shows the post; a profile link or username shows a button
    }),
  },
  // Legacy: no longer in the library (see LEGACY_CODE_TYPES).
  code_snippet: {
    label: 'Code block',
    icon: 'Doc',
    desc: 'Added with code (no longer offered)',
    category: 'embed',
    legacy: true,
    default: () => ({
      headline: '',
      language: 'plain',
      code: '// paste code here',
    }),
  },
  countdown: {
    label: 'Countdown',
    icon: 'Calendar',
    desc: 'A live countdown to a launch, event or deadline',
    category: 'cta',
    default: () => ({
      headline: 'Launching soon',
      sub: '',
      // Default: 14 days out from now. Owner overrides in the inspector.
      endDate: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
      cta: 'Get notified',
      ctaLink: '',
    }),
  },
  hours: {
    label: 'Hours of operation',
    icon: 'Calendar',
    desc: 'Your opening hours, day by day',
    category: 'content',
    // Each day keeps `open` / `close` (24h "HH:MM") and `closed`; the
    // editor writes the visitor-facing `hours` text from them, which is
    // what the renderers show (older sites only have `hours`).
    default: () => ({
      headline: 'Hours',
      timezone: '',
      days: [
        { id: 'd1', label: 'Monday',    open: '09:00', close: '17:00', closed: false, hours: '9:00 AM to 5:00 PM' },
        { id: 'd2', label: 'Tuesday',   open: '09:00', close: '17:00', closed: false, hours: '9:00 AM to 5:00 PM' },
        { id: 'd3', label: 'Wednesday', open: '09:00', close: '17:00', closed: false, hours: '9:00 AM to 5:00 PM' },
        { id: 'd4', label: 'Thursday',  open: '09:00', close: '17:00', closed: false, hours: '9:00 AM to 5:00 PM' },
        { id: 'd5', label: 'Friday',    open: '09:00', close: '17:00', closed: false, hours: '9:00 AM to 5:00 PM' },
        { id: 'd6', label: 'Saturday',  open: '',      close: '',      closed: true,  hours: 'Closed' },
        { id: 'd7', label: 'Sunday',    open: '',      close: '',      closed: true,  hours: 'Closed' },
      ],
    }),
  },
  map: {
    label: 'Map',
    icon: 'Globe',
    desc: 'A map of your location, from your address',
    category: 'content',
    // The owner types an address; the editor looks it up (api/geocode)
    // and stores the pin. No map shows until a pin exists.
    default: () => ({
      headline: 'Find us',
      address: '',
      lat: null, lng: null, zoom: 14,
      showMap: true,
    }),
  },
  accordion: {
    label: 'Accordion',
    icon: 'Chat',
    desc: 'Questions that open and close, good for long lists',
    category: 'content',
    default: () => ({
      headline: 'Frequently asked',
      items: [
        { id: 'a1', q: 'How long is a typical engagement?', a: '8–12 weeks. We start with a 1-week scoping sprint then settle into a weekly cadence.' },
        { id: 'a2', q: 'Do you offer payment plans?',       a: 'Yes - split into two or three payments at no extra cost.' },
        { id: 'a3', q: 'What if I need to pause?',          a: 'You can pause anytime with 1 week notice; we hold your slot for up to 60 days.' },
      ],
    }),
  },
  process: {
    label: 'Process / How it works',
    icon: 'Trending',
    desc: 'Numbered steps that explain how you work',
    category: 'content',
    default: () => ({
      headline: 'How it works',
      sub: '',
      steps: [
        { id: 'p1', number: '01', title: 'Discovery call', desc: 'A free 20-minute call to see if we are a good fit.' },
        { id: 'p2', number: '02', title: 'Plan + proposal', desc: 'I send a written plan with timeline + pricing.' },
        { id: 'p3', number: '03', title: 'We work together', desc: 'Weekly sessions + async support over Slack or email.' },
      ],
    }),
  },
  before_after: {
    label: 'Before / after',
    icon: 'Image',
    desc: 'Two photos side by side',
    category: 'social_proof',
    default: () => ({
      headline: 'Before & after',
      sub: '',
      beforeUrl: '',
      afterUrl: '',
      beforeLabel: 'Before',
      afterLabel: 'After',
    }),
  },
  social_feed: {
    label: 'Social feed',
    icon: 'Globe',
    desc: 'A button to your TikTok, X, LinkedIn, Facebook or YouTube',
    category: 'embed',
    default: () => ({
      headline: 'Latest',
      sub: '',
      platform: 'tiktok',
      url: '',
    }),
  },
  // Legacy: no longer in the library (see LEGACY_CODE_TYPES).
  custom_html: {
    label: 'Custom code',
    icon: 'Doc',
    desc: 'Added with code (no longer offered)',
    category: 'embed',
    legacy: true,
    default: () => ({
      html: '<div style="padding:48px;text-align:center;font-family:sans-serif">Paste any HTML here. Renders inside a sandboxed iframe.</div>',
      height: 280,
    }),
  },
};

export const SECTION_LIST = Object.entries(SECTION_TYPES).map(([type, cfg]) => ({ type, ...cfg }));
// What the section library offers (and what Ivy can add): everything that
// is not a legacy code type.
export const LIBRARY_SECTIONS = SECTION_LIST.filter((s) => !s.legacy && !LEGACY_CODE_TYPES.has(s.type));

let counter = 0;
export function mkSection(type, businessName = '') {
  counter += 1;
  const cfg = SECTION_TYPES[type];
  return {
    id: `s_${Date.now().toString(36)}_${counter}`,
    type,
    visible: true,
    // Optional fields the editor sets to customize this instance:
    //   variant - which layout to use (one of cfg.variants[].id)
    //   style   - { background?, padding?, textAlign? } per-section overrides
    //   animate - entry animation key (one of ANIMATIONS) or null
    variant: cfg.variants?.[0]?.id || null,
    style: {},
    animate: null,
    data: cfg.default(businessName),
  };
}

// Available section entry animations. The renderer attaches a CSS class
// + a sentinel that the IntersectionObserver upgrades when the section
// scrolls into view.
export const ANIMATIONS = {
  fade:        { label: 'Fade in' },
  rise:        { label: 'Fade up' },
  slide_left:  { label: 'Slide from left' },
  slide_right: { label: 'Slide from right' },
  zoom:        { label: 'Subtle zoom' },
};

// Font-pair presets - owners can override the template's defaults.
// Each preset names the display + body fonts; the renderer maps them
// into the --site-font-display / --site-font-body CSS variables.
// All presets pull from Google Fonts; the public renderer injects the
// CSS @import for the chosen pair (added via siteHtml.js).
export const FONT_PAIRS = {
  fraunces_inter:     { label: 'Fraunces + Inter (classic serif + clean sans)',  display: "'Fraunces', Georgia, serif",        body: "'Inter', -apple-system, sans-serif" },
  space_inter:        { label: 'Space Grotesk + Inter (modern editorial)',       display: "'Space Grotesk', 'Inter', sans-serif", body: "'Inter', sans-serif" },
  fraunces_fraunces:  { label: 'Fraunces only (all-serif magazine)',             display: "'Fraunces', Georgia, serif",        body: "'Fraunces', Georgia, serif" },
  inter_inter:        { label: 'Inter only (utilitarian)',                       display: "'Inter', sans-serif",               body: "'Inter', sans-serif" },
  playfair_lato:      { label: 'Playfair Display + Lato (luxury feel)',          display: "'Playfair Display', Georgia, serif", body: "'Lato', -apple-system, sans-serif" },
  dm_serif_dm_sans:   { label: 'DM Serif + DM Sans (matched display + sans)',    display: "'DM Serif Display', Georgia, serif", body: "'DM Sans', -apple-system, sans-serif" },
  bodoni_montserrat:  { label: 'Bodoni Moda + Montserrat (high-fashion)',        display: "'Bodoni Moda', Georgia, serif",      body: "'Montserrat', -apple-system, sans-serif" },
  cormorant_open:     { label: 'Cormorant Garamond + Open Sans (refined)',       display: "'Cormorant Garamond', Georgia, serif", body: "'Open Sans', -apple-system, sans-serif" },
  archivo_archivo:    { label: 'Archivo Black + Archivo (modern brutalist)',     display: "'Archivo Black', Helvetica, sans-serif", body: "'Archivo', -apple-system, sans-serif" },
  abril_lato:         { label: 'Abril Fatface + Lato (editorial display)',       display: "'Abril Fatface', Georgia, serif",    body: "'Lato', -apple-system, sans-serif" },
  ibm_ibm:            { label: 'IBM Plex Mono + IBM Plex Sans (technical)',      display: "'IBM Plex Mono', ui-monospace, monospace", body: "'IBM Plex Sans', -apple-system, sans-serif" },
  oswald_lora:        { label: 'Oswald + Lora (bold poster + warm read)',        display: "'Oswald', Impact, sans-serif",       body: "'Lora', Georgia, serif" },
  spectral_jost:      { label: 'Spectral + Jost (modern editorial v2)',          display: "'Spectral', Georgia, serif",         body: "'Jost', -apple-system, sans-serif" },
  marcellus_nunito:   { label: 'Marcellus + Nunito (boutique gallery)',          display: "'Marcellus', Georgia, serif",        body: "'Nunito', -apple-system, sans-serif" },
  bebas_inter:        { label: 'Bebas Neue + Inter (sportswear poster)',         display: "'Bebas Neue', Impact, sans-serif",   body: "'Inter', -apple-system, sans-serif" },
};

// Style densities for the per-section padding control. Editor exposes
// these as a 3-way pill picker.
export const PADDING_DENSITIES = {
  compact:  '40px 24px',
  normal:   '80px 64px',
  spacious: '140px 80px',
};

// Starter pages for first-time users - applied by the wizard.
// Kept for backward compat with any direct callers (the new Wizard
// uses STARTER_PACKS below).
export function starterSections(businessName) {
  return ['hero', 'services', 'about', 'booking', 'footer'].map((t) => mkSection(t, businessName));
}

// Helper that builds a section then patches its variant + a data
// override on top in one call. Used by the pack definitions so they
// can express things like "a hero with the split_image variant +
// these specific copy strings" succinctly.
function mk(type, businessName, { variant, animate, style, data } = {}) {
  const sec = mkSection(type, businessName);
  if (variant)        sec.variant = variant;
  if (animate)        sec.animate = animate;
  if (style)          sec.style = { ...sec.style, ...style };
  if (data)           sec.data = { ...sec.data, ...data };
  return sec;
}

// Build a page object compatible with state.js's mkPage shape.
// Imported lazily to avoid a circular dependency.
function buildPage({ slug = '', title = 'Home', sections = [], inNav = true } = {}) {
  return {
    id: `pg_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999)}`,
    slug, title, sections, inNav,
  };
}

// STARTER_PACKS - opinionated starting points the Wizard offers up
// front. Each pack defines:
//   id, label, desc            - for the picker UI
//   template, fontPair         - site-wide style hints (Wizard still
//                                lets the owner override these later)
//   icon                       - Icons key for the pack chip
//   build(businessName)        - function returning a `pages` array
//                                ready to drop into state.js's site.pages
//
// Packs lean into the newer section types (stats, cta_banner, team,
// pricing, newsletter, video, logos, pricing_table, blog, instagram) +
// the variants we shipped (hero split_image / image_bg, services list /
// cards_image) + per-section style + entry animations. Never a legacy
// code type.
export const STARTER_PACKS = {
  service_pro: {
    id: 'service_pro',
    label: 'Service business',
    desc: 'Single-page site - hero, services, testimonials, booking. The default for most owners.',
    icon: 'Dollar',
    template: 'clean',
    fontPair: 'fraunces_inter',
    build: (biz) => [
      buildPage({
        slug: '', title: 'Home', sections: [
          mk('hero',         biz, { variant: 'center', animate: 'rise',
                                    data: { sub: 'Book a session, send a message, or learn more about what I do.' } }),
          mk('services',     biz, { variant: 'grid',   animate: 'rise' }),
          mk('testimonials', biz, { animate: 'rise' }),
          mk('booking',      biz, { animate: 'rise' }),
          mk('contact',      biz, { animate: 'fade' }),
          mk('footer',       biz),
        ],
      }),
    ],
  },

  creative_studio: {
    id: 'creative_studio',
    label: 'Photographer / Creative',
    desc: 'Image-first layout with gallery, about, and a press-logo strip. Multi-page: Home + Portfolio + Contact.',
    icon: 'Image',
    template: 'studio',
    fontPair: 'fraunces_inter',
    build: (biz) => [
      buildPage({
        slug: '', title: 'Home', sections: [
          mk('hero',     biz, { variant: 'image_bg', animate: 'fade',
                                data: { headline: biz || 'Your work, in focus.', sub: 'Selected work + how to book a session.', cta: 'View portfolio', ctaLink: '#portfolio' } }),
          mk('logos',    biz, { animate: 'fade' }),
          mk('about',    biz, { animate: 'rise' }),
          mk('cta_banner', biz, { animate: 'zoom',
                                  data: { headline: 'Ready to start?', sub: "Tell me about your project - I'll get back within 24 hours.", cta: 'Book a consultation' } }),
          mk('footer',   biz),
        ],
      }),
      buildPage({
        slug: 'portfolio', title: 'Portfolio', sections: [
          mk('hero',    biz, { variant: 'left', data: { headline: 'Portfolio', sub: 'A small selection of recent work.', cta: '' } }),
          mk('gallery', biz, { animate: 'rise' }),
          mk('footer',  biz),
        ],
      }),
      buildPage({
        slug: 'contact', title: 'Contact', sections: [
          mk('hero',    biz, { variant: 'left', data: { headline: 'Get in touch', sub: '', cta: '' } }),
          mk('contact', biz, { animate: 'fade' }),
          mk('newsletter', biz, { animate: 'fade' }),
          mk('footer',  biz),
        ],
      }),
    ],
  },

  coach_consultant: {
    id: 'coach_consultant',
    label: 'Coach / Consultant',
    desc: 'Pricing-forward - stats, testimonials, three-tier pricing, newsletter. Multi-page: Home + Pricing + Compare.',
    icon: 'Users',
    template: 'editorial',
    fontPair: 'playfair_lato',
    build: (biz) => [
      buildPage({
        slug: '', title: 'Home', sections: [
          mk('hero',         biz, { variant: 'split_image', animate: 'rise',
                                    data: { headline: 'A clearer path, on your terms.', sub: "I help busy professionals stop spinning and start moving.", cta: 'Book a free intro' } }),
          mk('stats',        biz, { animate: 'rise' }),
          mk('about',        biz, { animate: 'rise' }),
          mk('testimonials', biz, { animate: 'rise' }),
          mk('cta_banner',   biz, { animate: 'zoom',
                                    data: { headline: 'See if we fit.', sub: '20-minute intro - no commitment.', cta: 'Schedule it' } }),
          mk('newsletter',   biz, { animate: 'fade' }),
          mk('footer',       biz),
        ],
      }),
      buildPage({
        slug: 'pricing', title: 'Pricing', sections: [
          mk('hero',    biz, { variant: 'center', data: { headline: 'Simple pricing.', sub: 'Pick what fits where you are.', cta: '' } }),
          mk('pricing', biz, { animate: 'rise' }),
          mk('faq',     biz, { animate: 'fade' }),
          mk('footer',  biz),
        ],
      }),
      buildPage({
        slug: 'compare', title: 'Compare plans', sections: [
          mk('hero',          biz, { variant: 'center', data: { headline: 'Compare', sub: 'Feature by feature.', cta: '' } }),
          mk('pricing_table', biz, { animate: 'rise' }),
          mk('footer',        biz),
        ],
      }),
    ],
  },

  studio_team: {
    id: 'studio_team',
    label: 'Studio / Team',
    desc: 'Team-led - meet-the-team page, services, gallery, contact. Best for shops with 2+ practitioners.',
    icon: 'Users',
    template: 'wellness',
    fontPair: 'fraunces_inter',
    build: (biz) => [
      buildPage({
        slug: '', title: 'Home', sections: [
          mk('hero',     biz, { variant: 'left', animate: 'rise',
                                data: { headline: biz || 'A studio built for you.', sub: 'Modern care, traditional roots.', cta: 'Book now' } }),
          mk('services', biz, { variant: 'cards_image', animate: 'rise' }),
          mk('team',     biz, { animate: 'rise' }),
          mk('testimonials', biz, { animate: 'fade' }),
          mk('footer',   biz),
        ],
      }),
      buildPage({
        slug: 'about', title: 'About', sections: [
          mk('hero',   biz, { variant: 'split_image', data: { headline: 'About us', sub: '', cta: '' } }),
          mk('about',  biz, { animate: 'rise' }),
          mk('team',   biz, { animate: 'rise' }),
          mk('footer', biz),
        ],
      }),
      buildPage({
        slug: 'contact', title: 'Contact', sections: [
          mk('hero',    biz, { variant: 'left', data: { headline: 'Visit', sub: '', cta: '' } }),
          mk('contact', biz, { animate: 'fade' }),
          mk('footer',  biz),
        ],
      }),
    ],
  },

  premium_minimal: {
    id: 'premium_minimal',
    label: 'Premium / Minimalist',
    desc: 'Quiet, confident - left-aligned hero, list services, single testimonial, generous whitespace.',
    icon: 'Edit',
    template: 'mono',
    fontPair: 'space_inter',
    build: (biz) => [
      buildPage({
        slug: '', title: 'Home', sections: [
          mk('hero',         biz, { variant: 'left',  animate: 'rise',
                                    style: { padding: 'spacious' },
                                    data: { headline: biz || 'Considered work, on principle.', sub: 'Selected practice. Quiet results.', cta: 'Inquire' } }),
          mk('services',     biz, { variant: 'list',  animate: 'rise',
                                    style: { padding: 'spacious' } }),
          mk('testimonials', biz, { animate: 'fade',
                                    style: { padding: 'spacious' } }),
          mk('cta_banner',   biz, { animate: 'zoom',
                                    data: { headline: 'Inquire.', sub: 'Tell me about the work.', cta: 'Start a conversation' } }),
          mk('footer',       biz),
        ],
      }),
    ],
  },

  writer_speaker: {
    id: 'writer_speaker',
    label: 'Writer / Speaker',
    desc: 'Editorial - blog strip, about, video, newsletter. Built for thought leaders.',
    icon: 'Doc',
    template: 'editorial',
    fontPair: 'fraunces_fraunces',
    build: (biz) => [
      buildPage({
        slug: '', title: 'Home', sections: [
          mk('hero',       biz, { variant: 'center', animate: 'rise',
                                  data: { headline: biz || 'Words that move readers.', sub: 'A weekly note on craft, business, and the in-between.', cta: 'Read latest', ctaLink: '#writing' } }),
          mk('newsletter', biz, { animate: 'fade' }),
          mk('blog',       biz, { animate: 'rise' }),
          mk('video',      biz, { animate: 'rise' }),
          mk('logos',      biz, { animate: 'fade' }),
          mk('footer',     biz),
        ],
      }),
      buildPage({
        slug: 'writing', title: 'Writing', sections: [
          mk('hero',   biz, { variant: 'left', data: { headline: 'Writing', sub: 'All essays - newest first.', cta: '' } }),
          mk('blog',   biz, { animate: 'rise' }),
          mk('footer', biz),
        ],
      }),
      buildPage({
        slug: 'speaking', title: 'Speaking', sections: [
          mk('hero',     biz, { variant: 'split_image', data: { headline: 'Speaking', sub: 'Topics, audiences, and how to book.', cta: 'Inquire' } }),
          mk('logos',    biz, { animate: 'fade' }),
          mk('contact',  biz, { animate: 'fade' }),
          mk('footer',   biz),
        ],
      }),
    ],
  },
};

export const STARTER_PACK_LIST = Object.values(STARTER_PACKS);


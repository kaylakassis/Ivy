// Section catalog — the library of blocks users can add to their site.
// Each section has a `type`, default data, and a human-friendly label/description.

export const SECTION_TYPES = {
  hero: {
    label: 'Hero',
    icon: 'Home',
    desc: 'Big headline + call to action',
    variants: [
      { id: 'center',      label: 'Centered' },
      { id: 'left',        label: 'Left aligned' },
      { id: 'split_image', label: 'Split with image' },
      { id: 'image_bg',    label: 'Image background' },
    ],
    default: (biz) => ({
      headline: biz ? `Welcome to ${biz}` : 'Your headline here',
      sub: 'A short line that tells visitors what you do and who you do it for.',
      cta: 'Book a session',
      ctaLink: '',
      align: 'center',
      imgUrl: '',  // used by split_image + image_bg variants
    }),
  },
  services: {
    label: 'Services',
    icon: 'Dollar',
    desc: 'What you offer + pricing',
    variants: [
      { id: 'grid', label: 'Grid (3-up)' },
      { id: 'list', label: 'List (stacked)' },
      { id: 'cards_image', label: 'Cards with image' },
    ],
    default: () => ({
      headline: 'What I Offer',
      sub: '',
      items: [
        { id: 'i1', name: 'Intro session',    desc: 'A short call to see if we are a good fit.',        price: '$45',  duration: '30 min', imgUrl: '' },
        { id: 'i2', name: 'Standard session', desc: 'The core offering — one hour of focused work.',    price: '$85',  duration: '60 min', imgUrl: '' },
        { id: 'i3', name: 'Full assessment',  desc: 'Deep-dive session with a written summary after.',  price: '$140', duration: '90 min', imgUrl: '' },
      ],
    }),
  },
  about: {
    label: 'About',
    icon: 'Users',
    desc: 'Your story + photo',
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
    default: () => ({
      headline: 'What Clients Say',
      items: [
        { id: 't1', name: 'Alex R.',  role: 'Client since 2023', text: 'Working with them was an amazing experience. Highly recommend.', rating: 5 },
        { id: 't2', name: 'Maya K.',  role: 'Client since 2024', text: 'I saw real progress within the first few sessions.',              rating: 5 },
      ],
    }),
  },
  faq: {
    label: 'FAQ',
    icon: 'Chat',
    desc: 'Frequently asked questions',
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
    default: () => ({
      headline: 'Gallery',
      photos: [],
    }),
  },
  contact: {
    label: 'Contact',
    icon: 'Mail',
    desc: 'Contact form + info',
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
    desc: 'Copyright + links',
    default: (biz) => ({
      businessName: biz || 'My Business',
      tagline: '',
      year: new Date().getFullYear(),
    }),
  },
  stats: {
    label: 'Stats',
    icon: 'Trending',
    desc: 'Counters — clients served, years in business, etc.',
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
    label: 'CTA banner',
    icon: 'Spark',
    desc: 'Full-width pull quote with a button',
    default: () => ({
      headline: 'Ready to start?',
      sub: "Book a 20-minute intro call — no commitment.",
      cta: 'Book now',
      ctaLink: '',
    }),
  },
  team: {
    label: 'Team',
    icon: 'Users',
    desc: 'Bios + photos for multi-person practices',
    default: () => ({
      headline: 'Meet the team',
      members: [
        { id: 'm1', name: 'Sam Johnson', role: 'Lead practitioner', bio: 'Short bio — what they do, what makes them great.', imgUrl: '' },
        { id: 'm2', name: 'Alex Rivera', role: 'Associate',         bio: 'Short bio — what they do, what makes them great.', imgUrl: '' },
      ],
    }),
  },
  pricing: {
    label: 'Pricing tiers',
    icon: 'Dollar',
    desc: 'Side-by-side package comparison',
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
    desc: 'Email-capture form',
    default: () => ({
      headline: 'Stay in touch',
      sub: 'Occasional emails about what I am working on — no spam.',
      buttonText: 'Subscribe',
      placeholder: 'you@example.com',
    }),
  },
  video: {
    label: 'Video',
    icon: 'Image',
    desc: 'Embedded video (YouTube/Vimeo URL)',
    default: () => ({
      headline: '',
      sub: '',
      videoUrl: '',  // e.g. https://www.youtube.com/watch?v=...
    }),
  },
  logos: {
    label: 'Featured in',
    icon: 'Globe',
    desc: 'Logos / press strip — "as seen in"',
    default: () => ({
      headline: 'Featured in',
      logos: [
        { id: 'l1', name: 'Vogue',    imgUrl: '' },
        { id: 'l2', name: 'NYT',      imgUrl: '' },
        { id: 'l3', name: 'Forbes',   imgUrl: '' },
        { id: 'l4', name: 'WSJ',      imgUrl: '' },
      ],
    }),
  },
};

export const SECTION_LIST = Object.entries(SECTION_TYPES).map(([type, cfg]) => ({ type, ...cfg }));

let counter = 0;
export function mkSection(type, businessName = '') {
  counter += 1;
  const cfg = SECTION_TYPES[type];
  return {
    id: `s_${Date.now().toString(36)}_${counter}`,
    type,
    visible: true,
    // Optional fields the editor sets to customize this instance:
    //   variant — which layout to use (one of cfg.variants[].id)
    //   style   — { background?, padding?, textAlign? } per-section overrides
    variant: cfg.variants?.[0]?.id || null,
    style: {},
    data: cfg.default(businessName),
  };
}

// Style densities for the per-section padding control. Editor exposes
// these as a 3-way pill picker.
export const PADDING_DENSITIES = {
  compact:  '40px 24px',
  normal:   '80px 64px',
  spacious: '140px 80px',
};

// Starter pages for first-time users — applied by the wizard.
export function starterSections(businessName) {
  return ['hero', 'services', 'about', 'booking', 'footer'].map((t) => mkSection(t, businessName));
}

// Section catalog — the library of blocks users can add to their site.
// Each section has a `type`, default data, and a human-friendly label/description.

export const SECTION_TYPES = {
  hero: {
    label: 'Hero',
    icon: 'Home',
    desc: 'Big headline + call to action',
    default: (biz) => ({
      headline: biz ? `Welcome to ${biz}` : 'Your headline here',
      sub: 'A short line that tells visitors what you do and who you do it for.',
      cta: 'Book a session',
      ctaLink: '',
      align: 'center',
    }),
  },
  services: {
    label: 'Services',
    icon: 'Dollar',
    desc: 'What you offer + pricing',
    default: () => ({
      headline: 'What I Offer',
      sub: '',
      items: [
        { id: 'i1', name: 'Intro session',    desc: 'A short call to see if we are a good fit.',        price: '$45',  duration: '30 min' },
        { id: 'i2', name: 'Standard session', desc: 'The core offering — one hour of focused work.',    price: '$85',  duration: '60 min' },
        { id: 'i3', name: 'Full assessment',  desc: 'Deep-dive session with a written summary after.',  price: '$140', duration: '90 min' },
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
    data: cfg.default(businessName),
  };
}

// Starter pages for first-time users — applied by the wizard.
export function starterSections(businessName) {
  return ['hero', 'services', 'about', 'booking', 'footer'].map((t) => mkSection(t, businessName));
}

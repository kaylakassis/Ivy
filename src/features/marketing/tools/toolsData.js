// The free tools at /tools: one list shared by the hub page, the route
// table (scripts/_lib/marketing-routes.mjs, which pre-renders them and
// lists them in the sitemap) and the SEO check (tests/prerender.test.mjs
// asserts each page's <h1> against `h1` here). Plain data, no JSX, so the
// Node build scripts can import it.

export const TOOLS_HUB = {
  path: '/tools',
  title: 'Free Tools for Solo Service Businesses | Ivy',
  description: 'Free tools for solo service businesses: a cancellation policy generator, a booking deposit calculator, client intake form templates and a no-show calculator.',
  h1: 'Free tools for your business of one.',
};

export const TOOLS = [
  {
    slug: 'cancellation-policy-generator',
    path: '/tools/cancellation-policy-generator',
    name: 'Cancellation policy generator',
    kind: 'Generator',
    title: 'Free Cancellation Policy Generator for Appointments | Ivy',
    description: 'Write a clear cancellation and no-show policy in a minute. Pick your notice window, fees and tone, then copy it or download it. Free, no signup.',
    h1: 'Cancellation policy generator',
    card: 'Pick your notice window, what happens on a late cancel or no-show, and a tone. Get a clear policy in plain language you can copy or download.',
  },
  {
    slug: 'deposit-calculator',
    path: '/tools/deposit-calculator',
    name: 'Booking deposit calculator',
    kind: 'Calculator',
    title: 'Booking Deposit Calculator: What No-Shows Cost You | Ivy',
    description: 'See what no-shows and late cancels cost you each month and year, and how much a booking deposit would keep. Your numbers, every step shown. Free.',
    h1: 'Booking deposit calculator',
    card: 'Enter your price, your weekly bookings and your own no-show estimate. See what missed slots cost you and what a deposit would keep, with the math shown.',
  },
  {
    slug: 'intake-form-templates',
    path: '/tools/intake-form-templates',
    name: 'Client intake form templates',
    kind: 'Templates',
    title: 'Free Client Intake Form Templates for 8 Professions | Ivy',
    description: 'Ready-to-copy client intake form questions for massage therapists, stylists, trainers, coaches, photographers, tutors, estheticians and cleaners.',
    h1: 'Client intake form templates',
    card: 'Ready-to-copy intake questions for eight kinds of service businesses, from massage therapists to cleaners. Copy one, tweak it, send it.',
  },
];

// The existing static calculator post, listed on the hub as the fourth tool.
export const NO_SHOW_CALCULATOR = {
  path: '/blog/no-show-cost-calculator',
  name: 'No-show cost calculator',
  kind: 'Calculator',
  card: 'Move three sliders to see roughly what empty slots cost you in a year. A quick companion to the deposit calculator.',
};

export const TOOL_BY_SLUG = Object.fromEntries(TOOLS.map((t) => [t.slug, t]));

// Every pre-rendered /tools page with its expected <h1>.
export const TOOL_PAGES = [TOOLS_HUB, ...TOOLS];

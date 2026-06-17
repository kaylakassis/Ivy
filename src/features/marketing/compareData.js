// Per-competitor comparison data. Used by ComparePage at /vs/:slug.
//
// Each entry has:
//   • headline + subheadline tuned to "I'm leaving competitor X"
//   • three pain-points the switcher typically has
//   • a feature matrix - same row order across competitors so the page
//     stays visually rhythmic; per-competitor "yes/no/limited"
//   • migration help offer (free CSV import)
//   • pricing-delta callout
//
// Update prices as competitors change them; we deliberately undercut
// rather than overstate so the page ages well.

export const FEATURE_ROWS = [
  { key: 'crm',           label: 'Client CRM + pipeline' },
  { key: 'booking',       label: 'Online booking + reminders' },
  { key: 'invoicing',     label: 'Branded invoicing + recurring billing' },
  { key: 'cardonfile',    label: 'Card on file + auto-charge no-shows' },
  { key: 'inperson',      label: 'In-person sales (Tap to Pay)' },
  { key: 'memberships',   label: 'Memberships + packages' },
  { key: 'documents',     label: 'Documents + e-signature (multi-signer)' },
  { key: 'messaging',     label: 'Two-way client messaging' },
  { key: 'clientportal',  label: 'Free client portal' },
  { key: 'website',       label: 'Website builder + custom domain' },
  { key: 'workflows',     label: 'Automated workflows' },
  { key: 'reviews',       label: 'Review capture + display' },
  { key: 'rewards',       label: 'Loyalty + referral rewards' },
  { key: 'ai',            label: 'Native AI coach (takes actions)' },
  { key: 'export',        label: 'Full data export, any time' },
  { key: 'noTxnFee',      label: 'No transaction fees (Stripe direct)' },
];

// "y" = yes, "n" = no, "l" = limited / paid add-on.
export const COMPETITORS = {
  honeybook: {
    name: 'HoneyBook',
    angle: 'Built for creative freelancers; expensive, no native AI.',
    headline: 'Leaving HoneyBook? Here\'s why solo owners switch to Ivy OS.',
    sub: 'HoneyBook is great at proposals + contracts, but the all-in cost runs $39-$79/mo and there\'s no native AI. Ivy OS matches the workflow at $49/mo with Ivy built in.',
    theirPrice: '$39 - $79 / mo',
    pains: [
      'Pricing climbs once you cross 6 active projects.',
      "No native AI - you're left running ChatGPT side-by-side.",
      'Booking and calendar feel bolted-on; we built ours into the same record as the contract.',
    ],
    matrix: {
      crm: 'y', booking: 'l', invoicing: 'y', cardonfile: 'l',
      memberships: 'n', documents: 'y', messaging: 'y', clientportal: 'l',
      website: 'l', workflows: 'l', reviews: 'l', rewards: 'n',
      ai: 'n', export: 'y', noTxnFee: 'l',
    },
  },
  dubsado: {
    name: 'Dubsado',
    angle: 'Powerful but steep learning curve; charges per workflow.',
    headline: 'Switching from Dubsado? Ivy OS keeps the power, drops the friction.',
    sub: 'Dubsado is feature-rich but the setup curve is famous, and pricing-per-workflow surprises people. Ivy OS ships with the same automation power, native AI, and predictable flat pricing.',
    theirPrice: '$20 - $40 / mo',
    pains: [
      'The setup is famously steep - you need a "Dubsado specialist" on Upwork to feel productive.',
      'Workflow add-ons cost extra. Our automations are included.',
      'No native AI. Ivy is a category leap, not an add-on.',
    ],
    matrix: {
      crm: 'y', booking: 'y', invoicing: 'y', cardonfile: 'l',
      memberships: 'n', documents: 'y', messaging: 'l', clientportal: 'y',
      website: 'n', workflows: 'y', reviews: 'l', rewards: 'n',
      ai: 'n', export: 'y', noTxnFee: 'y',
    },
  },
  vagaro: {
    name: 'Vagaro',
    angle: 'Beauty + wellness focused; bloated, expensive add-ons.',
    headline: 'Why beauty + wellness pros switch from Vagaro to Ivy OS.',
    sub: 'Vagaro dominates legacy salon software but charges extra for everything (text marketing, forms, online listing, multi-location). Ivy OS ships everything in $49/mo with no add-on tax.',
    theirPrice: '$25 - $85 / mo (add-ons extra)',
    pains: [
      "Text marketing? Forms? Online listing? Multi-staff? Each is a separate add-on.",
      'No native AI - Ivy spots quiet clients and drafts rebook nudges in seconds.',
      'Calendar UX hasn\'t modernized in years. Ours is built for 2026.',
    ],
    matrix: {
      crm: 'y', booking: 'y', invoicing: 'y', cardonfile: 'y',
      memberships: 'y', documents: 'l', messaging: 'l', clientportal: 'y',
      website: 'l', workflows: 'l', reviews: 'l', rewards: 'l',
      ai: 'n', export: 'l', noTxnFee: 'n',
    },
  },
  mindbody: {
    name: 'Mindbody',
    angle: 'Enterprise fitness/wellness; built for chains, painful for solos.',
    headline: 'Leaving Mindbody? You\'re not the only solo who outgrew its enterprise UX.',
    sub: 'Mindbody is built for chains. Solo owners pay enterprise prices for software designed for someone else. Ivy OS matches the workflow at a fraction of the cost.',
    theirPrice: '$139 - $349 / mo',
    pains: [
      'Enterprise pricing for what most solos actually need.',
      'Setup is heavy; live chat is paywalled to higher tiers.',
      'No native AI. Ivy takes actions; their AI just summarizes.',
    ],
    matrix: {
      crm: 'y', booking: 'y', invoicing: 'y', cardonfile: 'y',
      memberships: 'y', documents: 'l', messaging: 'l', clientportal: 'y',
      website: 'l', workflows: 'y', reviews: 'l', rewards: 'l',
      ai: 'n', export: 'l', noTxnFee: 'n',
    },
  },
  acuity: {
    name: 'Acuity',
    angle: 'Great booking; nothing else built in.',
    headline: 'Acuity is just booking. Ivy OS is the whole business.',
    sub: "Acuity has a clean booking page but stops there - you still need a CRM, an invoicer, a contract tool, and AI. Ivy OS matches Acuity's top tier at $49/mo and gives you the whole stack instead of just scheduling.",
    theirPrice: '$16 - $49 / mo',
    pains: [
      "Acuity is just booking - you still pay separately for invoicing, contracts, CRM.",
      "No client portal. We give your clients one for free.",
      'No native AI - Ivy is a force multiplier, not a chat widget.',
    ],
    matrix: {
      crm: 'l', booking: 'y', invoicing: 'n', cardonfile: 'y',
      memberships: 'n', documents: 'l', messaging: 'l', clientportal: 'n',
      website: 'n', workflows: 'l', reviews: 'n', rewards: 'n',
      ai: 'n', export: 'y', noTxnFee: 'l',
    },
  },
  calendly: {
    name: 'Calendly',
    angle: 'Scheduling-only; everyone using it for solo business needs more.',
    headline: 'Calendly is scheduling. Ivy OS schedules - and bills, signs, messages, and runs your AI.',
    sub: "Calendly does scheduling well. But if you're using it to run a business, you're stitching it to 4 other tools. Ivy OS replaces the whole stack at $49/mo.",
    theirPrice: '$10 - $16 / mo',
    pains: [
      "You're already paying for Stripe, QuickBooks, Mailchimp, and a CRM next to it.",
      'No client records. No invoices. No documents. Just a calendar.',
      'No native AI. Ivy is the layer you keep wishing your tools had.',
    ],
    matrix: {
      crm: 'n', booking: 'y', invoicing: 'n', cardonfile: 'n',
      memberships: 'n', documents: 'n', messaging: 'n', clientportal: 'n',
      website: 'n', workflows: 'l', reviews: 'n', rewards: 'n',
      ai: 'n', export: 'y', noTxnFee: 'l',
    },
  },
  practice: {
    name: 'Practice',
    angle: 'Coach-focused; missing financial tools.',
    headline: 'Why coaches who outgrew Practice switch to Ivy OS.',
    sub: 'Practice is decent for coaches but lacks real invoicing/accounting, has a young feature set, and pricing-per-seat scales fast. Ivy OS matches the workflow plus shipping financials + AI included.',
    theirPrice: '$25 - $49 / mo',
    pains: [
      "Invoicing + recurring billing are weak. We're closer to QuickBooks in that respect.",
      'No native AI yet. Ivy is here today.',
      "If you grow past one user, per-seat pricing surprises you.",
    ],
    matrix: {
      crm: 'y', booking: 'y', invoicing: 'l', cardonfile: 'l',
      memberships: 'l', documents: 'y', messaging: 'y', clientportal: 'y',
      website: 'n', workflows: 'l', reviews: 'n', rewards: 'n',
      ai: 'n', export: 'l', noTxnFee: 'l',
    },
  },
  paperbell: {
    name: 'Paperbell',
    angle: 'Coach-focused, simple - missing the deeper stack.',
    headline: 'Outgrowing Paperbell? Ivy OS picks up where it stops.',
    sub: 'Paperbell is a clean coaching tool. Once you need real invoicing, an AI, a website, or memberships, you\'re looking elsewhere. That\'s us.',
    theirPrice: '$57 - $97 / mo',
    pains: [
      "Limited financial tooling - no recurring invoices, weak expense tracking.",
      "Pricing climbs fast once you cross 3 active clients.",
      'No native AI. Ivy is a category leap for coaching specifically.',
    ],
    matrix: {
      crm: 'y', booking: 'y', invoicing: 'l', cardonfile: 'l',
      memberships: 'l', documents: 'y', messaging: 'y', clientportal: 'y',
      website: 'l', workflows: 'l', reviews: 'l', rewards: 'n',
      ai: 'n', export: 'l', noTxnFee: 'l',
    },
  },
};

export const COMPETITOR_LIST = Object.entries(COMPETITORS).map(([slug, c]) => ({ slug, ...c }));

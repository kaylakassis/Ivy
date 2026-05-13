// Blog posts — flat array, evergreen, hand-written. We don't need an
// MDX pipeline for v1; markdown-like text + a few JSX bits is enough.
//
// Each post:
//   slug, title, excerpt, date (ISO), readMinutes, body (paragraphs +
//   headings, kept as simple objects so we can render with consistent
//   styling and no third-party deps).
//
// Posts target top-of-funnel queries: pricing, intake forms, no-shows,
// admin overhead, payment processors, migration anxieties.

export const POSTS = [
  {
    slug: 'how-to-price-sessions',
    title: 'How to price your sessions when you\'re running solo',
    excerpt: 'A simple framework: floor (your minimum hourly), ceiling (what your top 10% would pay), and the math to find your number in between.',
    date: '2026-05-08',
    readMinutes: 7,
    body: [
      { type: 'p', text: "Pricing as a solo service business is one of the hardest decisions you make — and one of the few you can change every six months without breaking anything." },
      { type: 'h', text: 'Start from your floor, not the market average' },
      { type: 'p', text: "Add up everything that must come out of every billable hour: taxes (~30%), software, supplies, insurance, time off, and the unbilled admin hours behind each booking. That's your floor. Below it, you lose money on every booking." },
      { type: 'h', text: 'Find your ceiling by asking your best clients' },
      { type: 'p', text: "Your top 10% of clients — the ones who refer, rebook on time, and never haggle — will tell you the truth. \"At what price would you stop coming?\" The answer is usually 30–50% above what you currently charge." },
      { type: 'h', text: 'Land in the upper third of the band' },
      { type: 'p', text: "Don't price at your ceiling — leave room for raises. Pricing in the upper third of your floor-to-ceiling range gives you space to raise prices yearly without losing your best clients. THRYVE makes the math easy: open Finance → Reports → average session value and you've got your current number." },
      { type: 'h', text: 'Raise prices the right way' },
      { type: 'p', text: "Once a year, ideally on Jan 1 or your business anniversary. Announce 60 days ahead. Honor old pricing for active package balances. Existing clients on month-to-month get one month of legacy pricing. Done well, you lose 0–5% of clients and gain 20–35% revenue." },
    ],
  },
  {
    slug: 'free-intake-form-templates',
    title: 'Free intake form templates (and how to make them actually useful)',
    excerpt: 'Three intake templates you can copy: general client, wellness/therapy, photography. Plus the 3 questions that make every intake more useful.',
    date: '2026-05-04',
    readMinutes: 6,
    body: [
      { type: 'p', text: "Most intake forms are useless because they ask for everything. The good ones ask for what changes how you'll work that day." },
      { type: 'h', text: 'The three questions every intake should ask' },
      { type: 'p', text: "1. \"What's the outcome you want from this session?\" — Avoids the trap of doing what they SAY they want vs what they NEED." },
      { type: 'p', text: "2. \"What's the one thing I should know before we meet?\" — Catches allergies, anxieties, accommodations, etc., without you having to ask 12 separate questions." },
      { type: 'p', text: "3. \"How did you find me?\" — Long-term marketing signal. Worth its weight." },
      { type: 'h', text: 'Get the templates' },
      { type: 'p', text: 'In THRYVE: Documents → New from template. Three intakes are pre-loaded. Customize, attach to your service, and the form auto-sends on every booking.' },
    ],
  },
  {
    slug: 'late-cancel-fees',
    title: 'How to charge late-cancel fees without losing clients',
    excerpt: 'The card-on-file approach. The grace policy. The script that makes it stick. And how to do it without sounding like a corporation.',
    date: '2026-04-26',
    readMinutes: 8,
    body: [
      { type: 'p', text: "No-shows and late cancels are the second-biggest revenue leak in a solo service business (the first is undervaluing your time). The fix is unromantic but works: card on file + a clear policy + zero exceptions." },
      { type: 'h', text: 'Step 1: card on file is non-negotiable' },
      { type: 'p', text: "Every booking confirms with a saved card. The card is only charged in two cases: late cancel inside your policy window, or no-show. Both are spelled out in the booking page." },
      { type: 'h', text: 'Step 2: pick a policy that\'s neither punitive nor pushover' },
      { type: 'p', text: "Industry-typical: 50% charge for cancels under 24h, 100% charge for no-shows. First offense gets a one-time forgiveness; second doesn't. Saying this on the booking page sets expectations." },
      { type: 'h', text: 'Step 3: communicate it once, hold it forever' },
      { type: 'p', text: "When a client cancels under 24h, the charge auto-fires. They get an email explaining what happened with a kind, scripted note. Don't apologize for charging it. Don't waive it without a real reason." },
    ],
  },
  {
    slug: 'admin-tax-where-hours-go',
    title: "The solo founder's admin tax: where your hours actually go",
    excerpt: 'We tracked 12 solo service businesses for a week. The results: 38% of their working hours weren\'t billable. Here\'s where the time went.',
    date: '2026-04-15',
    readMinutes: 9,
    body: [
      { type: 'p', text: "We asked twelve solo owners — coaches, photographers, trainers, therapists — to track every minute of a working week. The 38% of working hours that weren't billable broke down like this:" },
      { type: 'p', text: "11% scheduling (\"can we move 4pm to 5?\"), 9% invoicing (drafting, chasing, reconciling), 6% client follow-ups (\"just checking in\"), 5% intake/onboarding, 4% bookkeeping/expenses, 3% website + content." },
      { type: 'h', text: 'Where THRYVE recovers each one' },
      { type: 'p', text: "Scheduling → public booking page. Invoicing → recurring + auto-send + Stripe direct-pay. Follow-ups → Ivy spots quiet clients and drafts the message. Intake → auto-attach forms to services. Bookkeeping → live P&L. Website → builder + custom domain." },
      { type: 'h', text: 'The compounding part' },
      { type: 'p', text: "The 38% admin tax isn't just lost revenue. It's the reason solo founders burn out. Get it to 20% and you'll have evenings again." },
    ],
  },
  {
    slug: 'stripe-square-toast-comparison',
    title: 'Stripe vs Square vs Toast: which payment processor for solo service businesses',
    excerpt: 'A buyer\'s guide for solo service owners deciding how to take payments. The processing fees, the gotchas, the integrations.',
    date: '2026-03-31',
    readMinutes: 11,
    body: [
      { type: 'p', text: "If you're running a solo service business, the payment processor you choose determines what software you can use, what reporting you get, and how much of every dollar you keep." },
      { type: 'h', text: 'Stripe: the default for service businesses' },
      { type: 'p', text: "Standard rate ~2.9%+30¢. Money lands in your bank in 2 business days. Integrates with everything (THRYVE included). No physical card reader hardware — but you can use Stripe Terminal for that. Best for: any solo who books online." },
      { type: 'h', text: 'Square: best for cash-and-card retail/walk-in' },
      { type: 'p', text: "Same processing fee. Their advantage is the free physical reader + integrated POS. Their disadvantage is their software ecosystem assumes retail; service-business integrations are weaker." },
      { type: 'h', text: 'Toast: restaurant-only. Skip.' },
      { type: 'p', text: "Toast is for restaurants. If you're a solo service business, ignore." },
      { type: 'h', text: 'Recommendation' },
      { type: 'p', text: "If you're 100% in-person walk-in: Square. Everyone else: Stripe. THRYVE connects to your existing Stripe — we never take a cut of your sales." },
    ],
  },
  {
    slug: 'switching-software-checklist',
    title: 'Switching software without losing your data — a 7-step checklist',
    excerpt: 'You\'ve decided to switch tools. Don\'t lose your booking history, client notes, or in-progress invoices. The migration order that works.',
    date: '2026-03-19',
    readMinutes: 7,
    body: [
      { type: 'p', text: "Switching tools is scarier than it should be because every owner has horror stories of lost data. Here's the order that avoids them:" },
      { type: 'p', text: "1. Export everything from your current tool BEFORE signing up for the new one. Clients, bookings, invoices, documents — every CSV they offer." },
      { type: 'p', text: "2. Run both tools in parallel for one billing cycle. Take new bookings in the new tool; let in-flight bookings finish in the old." },
      { type: 'p', text: "3. Set your clients' expectations once: \"You'll see a new email address for invoices starting <date>.\"" },
      { type: 'p', text: "4. Import historical clients first. Test that a client lookup works." },
      { type: 'p', text: "5. Import historical bookings second. Spot-check 10 random bookings." },
      { type: 'p', text: "6. Import open invoices last. These are the ones that affect money flow — get them right." },
      { type: 'p', text: "7. Keep the old tool for 60 days, read-only, just in case. Then cancel." },
      { type: 'h', text: 'THRYVE handles all of this for free' },
      { type: 'p', text: "We'll take your CSV exports or read-only access to your current tool and import everything inside one business day. No charge. Email hello@getthryve.ai or sign up and our team reaches out." },
    ],
  },
];

export const POST_MAP = Object.fromEntries(POSTS.map((p) => [p.slug, p]));

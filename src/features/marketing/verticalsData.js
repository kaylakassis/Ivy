// Per-vertical content shared between MarketingHome (small cards
// linking to /for/:slug) and VerticalPage (the full page itself).
// Pure data — no React imports — so MarketingHome can pull this
// without dragging the VerticalPage component into the index chunk.
//
// Adding a vertical: drop a row here, link from anywhere; everything
// else (route, SEO meta, cross-links) is already wired.
export const VERTICALS = {
  'massage-therapists': {
    icon: 'Spark',
    angle: 'massage therapists',
    homeLine: 'Intake forms auto-send before sessions. Reminders cut no-shows.',
    headline: 'Bookings, intake forms, and reminders in one place.',
    sub: "Stop juggling MassageBook, Acuity, and a separate intake-form tool. One workspace for booking, intake, payments, and the client portal.",
    bullets: [
      { title: 'Auto-send intake forms', body: 'Attach a SOAP-note intake form to each service. THRYVE sends it the moment a client books — no more "did you fill out the form?" texts.' },
      { title: 'No-show reduction', body: 'Email + SMS reminders ship 24h and 2h before the session. Clients can confirm or reschedule from the link without calling.' },
      { title: 'Built-in deposits', body: 'Charge a deposit on booking via your own Stripe. Walk-outs become non-issues.' },
      { title: 'Client portal', body: 'Past sessions, signed waivers, invoices, package balances — all in their pocket. Free for clients, forever.' },
    ],
    use: "Add your sessions (60-min massage, 90-min, deep-tissue), set Mon–Fri 9–5 availability, share /book/your-name, and you're live.",
  },
  'hair-stylists': {
    icon: 'Gift',
    angle: 'hair stylists & barbers',
    homeLine: 'Deposits on booking, packages for repeat clients, rebooking nudges.',
    headline: 'Booking, deposits, packages, and rebooking — all native.',
    sub: "Booksy and Square take a cut. THRYVE doesn't. One subscription replaces all three of: booking, payment processing, and the client CRM.",
    bullets: [
      { title: 'Deposits on every booking', body: "Set a deposit per service. Stripe collects on confirm; the rest at the chair." },
      { title: 'Service packages', body: '5-pack of cut-and-color, 10-pack of trims. Sell the bundle; THRYVE consumes a credit per booking automatically.' },
      { title: 'Rebooking nudges', body: "Ivy spots clients who haven't rebooked since their last cut and drafts a check-in you can send in one tap." },
      { title: 'Reviews where it matters', body: 'Auto-prompt for a review after the appointment. Highlights show up on your /book/your-name page.' },
    ],
    use: 'Add cut, color, mani, etc. with prices. Set deposits where it matters. Tag returning clients as "active" and Ivy quietly tracks their cadence.',
  },
  'personal-trainers': {
    icon: 'Trending',
    angle: 'personal trainers & fitness coaches',
    homeLine: 'Group classes with capacity, recurring sessions, payment-on-booking.',
    headline: 'Group classes, recurring sessions, and packages — without TrainerRoad-grade overhead.',
    sub: 'Schedule 1-on-1s and group classes. Sell session packs. Collect on booking. Let your AI coach (Ivy) help you spot at-risk clients before they ghost.',
    bullets: [
      { title: 'Group classes with capacity', body: 'Set a service to "capacity 12". Clients book individual seats; the slot fills up like a real class roster.' },
      { title: 'Recurring sessions', body: 'Tuesday + Thursday 6 AM, every week, until canceled. THRYVE creates the booking series and reminders fire for each.' },
      { title: 'Session packs', body: '10-pack of training, $850. THRYVE bills upfront and consumes one credit per session — refunds the credit if you cancel.' },
      { title: 'Quiet-client alerts', body: "Ivy lists who hasn't booked in 3+ weeks and drafts personalized check-ins. Two-tap to send." },
    ],
    use: 'Set up your services (1-on-1, group HIIT, nutrition consult) with capacities, build packages, share the booking link, and Ivy starts watching.',
  },
  'coaches': {
    icon: 'Doc',
    angle: 'coaches & consultants',
    homeLine: 'Discovery calls, retainers, signed agreements — same thread.',
    headline: 'Discovery calls, retainers, signed agreements — same thread.',
    sub: "You don't need Calendly + Honeybook + DocuSign. Drop your booking link, attach the agreement to the engagement service, get e-signed automatically.",
    bullets: [
      { title: 'E-signing built in', body: 'Build your own agreement template once. Attach it to your "Strategy engagement" service. THRYVE sends it the moment they book and tracks signatures.' },
      { title: 'Retainer invoices', body: "Recurring monthly invoices via Stripe. Auto-payment if their card's on file; reminders if not." },
      { title: 'Discovery → engagement', body: '15-min discovery → if they convert, the agreement, deposit invoice, and follow-up cadence all chain off the same client record.' },
      { title: 'Ivy as your prep assistant', body: 'Ask "Pull up everything on Sarah before our 3pm call" — Ivy summarizes their notes, last session, and open work.' },
    ],
    use: 'Service: "Discovery call (free)" + "Strategy engagement ($X)". Attach your agreement to the second. Drop the booking link in your bio.',
  },
  'cleaners': {
    icon: 'Check',
    angle: 'cleaners & home-service pros',
    homeLine: 'Recurring jobs, upfront deposits, automatic invoices on completion.',
    headline: 'Recurring jobs, upfront deposits, automatic invoices.',
    sub: 'Field service software is overkill. Spreadsheets are underkill. THRYVE sits in between — one place for recurring bookings, deposits, post-job invoices, and follow-up.',
    bullets: [
      { title: 'Recurring jobs', body: '"Every other Tuesday at 10" — set the recurrence once, THRYVE creates each booking and reminders fire automatically.' },
      { title: 'Deposit on booking', body: 'Charge 50% on confirm via Stripe; balance after the job. Cancellations under 24h forfeit the deposit if you set it that way.' },
      { title: 'Invoice on completion', body: 'Mark the booking complete → THRYVE drafts the invoice with your standard line items. Edit, send, paid in 2 minutes.' },
      { title: 'Client portal for repeat work', body: 'Long-time clients book recurring jobs themselves through their portal. No more "can you come Thursday?" texts.' },
    ],
    use: 'Add services (deep clean, weekly clean, move-out), set deposit %, build a recurring service for your standing customers, share the link.',
  },
};

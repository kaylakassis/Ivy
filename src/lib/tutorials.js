// Per-tab in-depth tutorial content. Keyed by NAV item id (see
// src/lib/nav.js) so the Topbar can look up "what tutorial belongs to
// this page" in one step.
//
// Each tutorial is an array of steps. A step is:
//   {
//     title:   string  (the H2 of the slide - short, action-oriented)
//     body:    string  (the paragraph beneath, plain text or simple
//                       inline HTML - kept short so a step reads in
//                       one breath)
//     bullets: string[] | undefined
//                      (optional bullet list under the body)
//     cta:     { label, to } | undefined
//                      (optional in-tutorial deep-link; the button
//                       closes the modal and routes there)
//   }
//
// Voice: direct, warm, action-oriented. Talks like a coach who knows
// the owner's job, not like a help doc. Light on jargon, heavy on
// "here's how this saves you time."

export const TUTORIALS = {
  dashboard: {
    title: 'Home',
    intro: 'Home is about today: who you are seeing, what came in, and the few things that need you.',
    steps: [
      {
        title: 'Today',
        body: "Your next appointment sits at the top with the buttons you need for it, and the money that came in today and this week is right beside it.",
      },
      {
        title: 'Needs your attention',
        body: "Ivy keeps a short list of what is waiting on you: a message to answer, an invoice to chase, a booking to approve. Each row has one button that opens the exact place to deal with it.",
      },
      {
        title: 'Ask Ivy',
        body: 'Type what you want to do in the box at the top, in your own words. Ivy does it with your approval, or shows you where it is.',
      },
      {
        title: 'Progress',
        body: 'Your numbers, this week with Ivy, and your goals and tasks are one tap away under "See your progress".',
      },
    ],
  },

  clients: {
    title: 'Clients',
    intro: 'Your book of business. Every lead, every active client, every paused account - all searchable, taggable, and one tap from a message or invoice.',
    steps: [
      {
        title: 'Add your first client',
        body: 'Tap "Add client" top-right. You only need a name to start; phone and email come highly recommended so you can text and email them through Ivy later.',
      },
      {
        title: 'Stages tell the story',
        body: 'Every client carries a stage: Lead (interested but not paying), Active (paying / booking), or Paused. Move them through stages as the relationship evolves; reports filter by stage so your numbers stay clean.',
      },
      {
        title: 'Tags are your superpower',
        body: 'Tag clients by anything that matters - "VIP", "weekday-only", "referred-by-Sarah", "intro-pricing". Then filter on those tags to send a targeted message blast or pull a quick list.',
      },
      {
        title: 'The client drawer is the whole picture',
        body: 'Tap any row → the side drawer shows their bookings, invoices, lifetime value, recent messages, attached documents, and notes - all in one scroll. Edit anything inline.',
      },
      {
        title: 'Import from anywhere',
        body: "Got 50 clients in a spreadsheet? Tap Import (top-right) and drop a CSV. Ivy de-duplicates against existing emails so you don't double-add.",
      },
      {
        title: 'Any client can become a folder',
        body: "Tap Make folder on a client's row. Their folder holds everything for them in one place - bookings, invoices, quotes and signed documents - so a year from now you open one folder and see the whole story.",
      },
    ],
  },

  calendar: {
    title: 'Calendar',
    intro: 'Bookings, services, hours, blocks - everything time-related lives here. The public booking link generated from this tab is how new clients book themselves into your schedule.',
    steps: [
      {
        title: 'Set your services first',
        body: 'Services live under Money → Services. Each service is a name + duration + price. You can require a deposit, a full payment, or nothing at booking - your call. Photos there show on your booking page.',
        cta: { label: 'Open Services', to: '/finance?section=services' },
      },
      {
        title: 'Set your weekly hours',
        body: 'Tap Availability. Drag the bars to mark when you take bookings on each day of the week. Anything outside those bars is closed and unbookable on the public page.',
      },
      {
        title: 'Block off time selectively',
        body: "Click any slot on the calendar grid → block it out (lunch, dentist, whatever). Recurring blocks too. Clients can't book during those windows.",
      },
      {
        title: 'Your booking link is the lever',
        body: "Tap Share (top action menu) → copy your /book/{your-handle} URL. Drop it in your Instagram bio, email signature, and on the next text you send. That's how clients self-book without trading messages.",
      },
      {
        title: 'Show up on Discover',
        body: "Toggle 'List on Discover' inside Share. Clients in the Ivy marketplace can find you by service, price, distance, and rating. Free traffic.",
      },
    ],
  },

  finance: {
    title: 'Money',
    intro: 'Invoices, estimates, recurring billing, what you sell, gift cards, memberships and your payment processor: the money side of the business.',
    steps: [
      {
        title: 'Connect a payment processor',
        body: 'The card up top is where you connect Stripe (or Square). Until one is connected, invoices fall back to manual mark-as-paid. Connecting unlocks one-tap pay links and Tap-to-Pay-style flows.',
      },
      {
        title: 'Send your first invoice',
        body: '"New invoice" → pick a client → add line items → Send. The client gets a branded email with a "Pay now" button. You see when they open it, when they pay, and the invoice flips to Paid in real time.',
      },
      {
        title: 'Collect in person',
        body: "Open any unpaid invoice → 'Collect in person'. You'll get a QR code + sharable link the customer scans on their phone. They pay through Apple Pay / Google Pay / card right there.",
      },
      {
        title: 'Recurring invoices',
        body: 'Got a monthly retainer? Set up a recurring invoice once - Ivy auto-generates and sends it every cycle. Includes built-in failure handling and dunning if a card declines.',
      },
      {
        title: 'Memberships and gift cards',
        body: 'Each has its own section; use what fits your business. Memberships are recurring access plans. Gift cards are balances clients buy and spend on your services.',
      },
    ],
  },

  marketing: {
    title: 'Marketing',
    intro: 'What brings clients back, in one tab: Workflows (follow-ups that run on their own) and Rewards (a loyalty program for your clients).',
    steps: [
      {
        title: 'Workflows',
        body: "A trigger plus a few actions: a thank-you when someone signs up, a check-in when a client goes quiet for 60 days, a birthday note. Set it once and it runs while you work.",
      },
      {
        title: 'Rewards',
        body: 'Points, punch cards or referral credits for your clients. Turn it on when you are ready; nothing shows to clients until you launch it.',
      },
    ],
  },
  comms: {
    title: 'Messages',
    intro: "Every conversation with every client in one inbox. Replaces the 'where did I last text Sarah from?' moment.",
    steps: [
      {
        title: 'One thread per client',
        body: 'Pick a client from the conversation list to open the thread. New messages from clients land here AND get pushed via email/SMS so nothing slips through.',
      },
      {
        title: 'Voice memos + dictation',
        body: 'In the composer: tap the bars icon to dictate (your speech becomes text). Tap the mic to record a voice memo. Both work without typing - great when you\'re between clients.',
      },
      {
        title: 'Send invoices and docs without leaving',
        body: 'In a thread → quick-actions → "Send invoice" or "Send a document." Built right into the conversation so there\'s no app-switching mid-thought.',
      },
      {
        title: 'Broadcast / one-way mode',
        body: "Some threads are announcements (a class update, a holiday closure). Toggle a thread to one-way and clients can't reply - keeps your inbox clean for actual conversations.",
      },
    ],
  },

  docs: {
    title: 'Documents',
    intro: 'Contracts, intake forms, waivers, e-signatures - built in. No DocuSign needed.',
    steps: [
      {
        title: 'Build a template once',
        body: "Either upload a PDF you already have, or write one from scratch in our editor. Drop signature, initials, date, and text fields wherever they need to go.",
      },
      {
        title: 'Send for signing',
        body: 'Pick the template → pick the client → send. They get an email with a magic link, sign on any device, and the signed PDF lands back in their client profile + your archive.',
      },
      {
        title: 'Required-before-booking',
        body: 'Attach a document template to a service (e.g. waiver for a personal-training session). Clients have to sign it before they can book the next session - the booking flow handles the gating.',
      },
      {
        title: 'Audit trail by default',
        body: "Every signed document carries a stamped audit page: when it was sent, opened, signed, the IP and device, and a SHA-256 hash. Court-defensible if you ever need it.",
      },
    ],
  },

  website: {
    title: 'Website',
    intro: "A real public-facing mini-site you build in minutes, with your booking page baked in. No domain, no hosting bill, no dev work.",
    steps: [
      {
        title: 'Pick a template',
        body: 'Top toolbar → Template selector. Three starting points (Clean, Warm, Bold). They\'re skeletons - you customize sections + colors after picking.',
      },
      {
        title: 'Build with sections',
        body: 'Left rail = section library. Drag in a Hero, About, Services, Reviews, FAQ, Gallery, Contact, etc. Right rail = inspector for the selected section (text, photos, links).',
      },
      {
        title: 'Pick your handle',
        body: 'Set a handle once (e.g. "kayla") → your site lives at joinivy.ai/site/kayla forever. We reserve it.',
      },
      {
        title: 'Visibility gives you a draft mode',
        body: "Top right has Public / Link only / Only me. Build privately on Only me, share with friends on Link only, then flip to Public when you're ready for traffic.",
      },
      {
        title: 'Publish - and the booking link comes free',
        body: "Hit Publish. Your site is live + indexable. The Book button on every section automatically routes to your booking page. One mini-site, one URL, one place to send everyone.",
      },
    ],
  },

  account: {
    title: 'Account',
    intro: 'Your subscription, branding, team, integrations - everything that\'s about Ivy itself rather than your day-to-day work.',
    steps: [
      {
        title: 'Brand the experience',
        body: 'Upload your logo and pick an accent color. Ivy re-skins every email, invoice, document, and booking page with that branding so clients see your business, not Ivy.',
      },
      {
        title: 'Manage your subscription',
        body: 'See your plan, your next charge, your card on file. Cancel any time - your data stays accessible for 30 days after cancellation in case you change your mind.',
      },
      {
        title: 'Notification preferences',
        body: 'Pick which events email you (new booking, invoice paid, document signed) and which only push. Tune it for the noise level you want.',
      },
      {
        title: 'Replay any tutorial',
        body: 'See the (i) icon next to every page title? Tap it any time to replay that tab\'s walkthrough. The first visit auto-opens; after that the (i) is your refresh-my-memory button.',
      },
    ],
  },
};

export function getTutorial(tabId) {
  return TUTORIALS[tabId] || null;
}

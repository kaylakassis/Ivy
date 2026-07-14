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
    title: 'Your Dashboard',
    intro: 'The home base. Every metric that matters at a glance - plus shortcuts to whatever needs your attention right now.',
    steps: [
      {
        title: 'Read the room in 5 seconds',
        body: "The header band shows the four numbers you check most: revenue this month, active clients, booked sessions, and outstanding invoices. They update in real time as the day unfolds.",
      },
      {
        title: "Today's focus",
        body: "Your appointments for the day are pinned right under the header - name, time, service, and any notes. Tap one to jump straight into that booking.",
      },
      {
        title: 'Quiet clients alert',
        body: "Anyone you haven't messaged in 3+ weeks shows up here as a soft nudge. Tap the row to start a conversation before they go cold.",
      },
      {
        title: 'Your shortcut row',
        body: "The big tiles below today's appointments are one-tap shortcuts to the actions you'll do most: add a client, send an invoice, drop a booking on the calendar, kick off a doc to sign.",
      },
      {
        title: 'Ivy is always one tap away',
        body: 'Tap the "Ivy" bubble in the bottom-right of any page to ask your AI assistant anything - from "how should I price my new service?" to "draft a check-in to my 3 quietest clients."',
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
    ],
  },

  projects: {
    title: 'Projects',
    intro: "An engagement view for service work that spans more than a single session. Group every booking, invoice, quote, and signed document under a named project - perfect for photographers, designers, consultants, or anyone running multi-touchpoint work.",
    steps: [
      {
        title: 'Group work under one roof',
        body: "Create a project for each engagement (e.g. 'Smith wedding shoot' or 'Q1 retainer'). Every artifact you create afterward can be tied to it, so a year from now you can pull up the full picture in one tap.",
      },
      {
        title: 'Track status at a glance',
        body: "Planning → Active → On hold → Completed → Cancelled. Filter the list to just the active set when you're focusing on what's live this week.",
      },
      {
        title: 'Linked everything stays linked',
        body: "Bookings, invoices, quotes, and signed documents tied to a project show up in its drawer - one tap from any of them to open the source.",
      },
    ],
  },

  calendar: {
    title: 'Calendar',
    intro: 'Bookings, services, hours, blocks - everything time-related lives here. The public booking link generated from this tab is how new clients book themselves into your schedule.',
    steps: [
      {
        title: 'Set your services first',
        body: 'Tap Services (top action menu). Each service is a name + duration + price. You can require a deposit, a full payment, or nothing at booking - your call. Photos here show on your booking page.',
        cta: { label: 'Open Services', to: '/calendar' },
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
    title: 'Finance',
    intro: 'Invoices, expenses, recurring billing, time tracking, gift cards, memberships, payment processor - the whole money side of the business.',
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
        title: 'Track expenses for tax season',
        body: 'Expenses tab. Log spend with a category + receipt photo. We surface tax-deductible totals by IRS category at year-end so your accountant has clean numbers.',
      },
      {
        title: 'Memberships, gift cards, time-tracking',
        body: 'Each is its own sub-tab - turn on what fits your business. Memberships = recurring access plans. Gift cards = sellable balances clients can spend on services. Time = bill hourly with one tap.',
      },
    ],
  },

  goals: {
    title: 'Goals',
    intro: "Set the targets that matter and watch progress without spreadsheets. Revenue, bookings, new clients - pick a metric, set a target, see how today's pace stacks up.",
    steps: [
      {
        title: 'Add your first goal',
        body: 'Pick a metric (Monthly revenue, New clients this month, Bookings this week). Set a target. Done.',
      },
      {
        title: 'Pace tells the truth',
        body: "Each goal shows your actual vs. expected pace today. If you should be at 60% by mid-month and you're at 35%, the bar shows red. Course-correct early.",
      },
      {
        title: 'Celebrate wins',
        body: "Hit a goal? You'll get a confetti moment on the dashboard plus a Slack-style celebration in your messages. Nice for momentum.",
      },
    ],
  },

  workflows: {
    title: 'Workflows',
    intro: "Automate the follow-ups you keep meaning to set up. Pick a trigger, stack up the actions, and the platform runs them while you focus on the work itself.",
    steps: [
      {
        title: 'Pick a trigger',
        body: "Four triggers cover most of the real-world cases: new lead from your contact form, any new client, a client who's gone quiet, or a booking that just wrapped. The first two fire instantly; the last two run on a daily check.",
      },
      {
        title: 'Stack the actions',
        body: "Send an email, send an SMS (if the client opted in), create a task in your /goals tab, or send a document for signing. Run them in any sequence - each action is independent, so a failed SMS won't block the email.",
      },
      {
        title: 'Use tokens',
        body: "Drop {{firstName}}, {{clientName}}, {{businessName}}, or {{ownerName}} into the email/SMS body or task title. They're filled in at send time so every message reads custom-written.",
      },
      {
        title: 'Watch it run',
        body: "Each workflow card shows when it last fired and whether the actions succeeded. The toggle on each card turns the whole workflow off without losing the config.",
      },
    ],
  },

  rewards: {
    title: 'Rewards',
    intro: 'Loyalty + referrals on autopilot. Reward repeat clients, incentivize them to bring friends, automate the whole thing.',
    steps: [
      {
        title: 'Pick the rules that fit your business',
        body: '"$5 off for every $100 spent." "Free service after 10 visits." "Referrer + new client both get $20 off." Toggle the rules that match how you already work; Ivy applies them automatically.',
      },
      {
        title: 'Referrals track themselves',
        body: 'Each client gets a unique referral link. When a friend books through that link, both sides get the reward you set. You see the chain - who referred who - in their profile.',
      },
      {
        title: 'Surfaces matter',
        body: "Rewards balances appear in your client's portal, on their invoices, and in their booking confirmations. They notice. That's the point.",
      },
    ],
  },

  comms: {
    title: 'Messages',
    intro: "Every conversation with every client in one inbox. Replaces the 'where did I last text Sarah from?' moment.",
    steps: [
      {
        title: 'One thread per client',
        body: 'Pick a client from the left to open the thread. New messages from clients land here AND get pushed via email/SMS so nothing slips through.',
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

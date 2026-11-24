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
// These open only when the owner taps the (i) next to a screen's title;
// nothing opens by itself. Every owner screen has one. Keep each to three
// or four short steps, name buttons exactly as the screen does, and say
// only what the screen really does (tests/tutorials-on-demand.test.mjs
// checks the button names against the screens).

// Opens the welcome tour (the spotlight walk through the main screens,
// src/features/onboarding/Walkthrough.jsx). It starts by itself once for a
// new owner (AppShell); this is how anyone watches it again: from Home's
// and More's (i), and from Account, Profile.
export const WELCOME_TOUR = '/dashboard?walkthrough=1';

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
        body: "Ivy keeps a short list of what is waiting on you: a message to answer, an invoice to chase, a booking to approve. Each row has one button that opens the exact place to deal with it. For overdue invoices, Chase asks once and then sends the reminders for you.",
      },
      {
        title: 'Ask Ivy, and see your progress',
        body: 'Type what you want to do in the box at the top, in your own words; Ivy does it with your approval, or shows you where it is. Your numbers, goals and tasks are one tap away under "See your progress".',
      },
      {
        title: 'The welcome tour',
        body: 'Want to be shown around the whole app? The welcome tour takes about a minute, and you can watch it as many times as you like.',
        cta: { label: 'Watch the welcome tour', to: WELCOME_TOUR },
      },
    ],
  },

  progress: {
    title: 'Progress',
    intro: 'How the business is doing, away from the day-to-day.',
    steps: [
      {
        title: 'Your numbers',
        body: 'The tiles at the top compare this month with last month, so you can see which way things are heading.',
      },
      {
        title: 'This week with Ivy',
        body: 'What happened in the last 7 days: sessions completed, bookings taken, money collected, and what Ivy handled for you.',
      },
      {
        title: 'Goals and tasks',
        body: 'Set a goal and Ivy tracks it from your real numbers. Tasks are your own to-do list; give one a due date and it shows up on Home when it is due.',
      },
    ],
  },

  clients: {
    title: 'Clients',
    intro: 'Your people: every lead, active client and paused client, with their rewards and the reminders Ivy sends them.',
    steps: [
      {
        title: 'Clients, Rewards, Reminders',
        body: 'Three sections at the top. Clients is your list. Rewards is your loyalty program. Reminders are the messages Ivy sends for you: a birthday note, a check-in when someone goes quiet, a book-again link after a visit, and a request for a review.',
      },
      {
        title: 'Add or import',
        body: 'Tap "Add client"; a name is enough to start. To bring a list over, open the menu next to it and choose "Import clients". Anyone already in your list (same email or phone) is skipped, so nobody is added twice.',
      },
      {
        title: 'Who needs you',
        body: 'The "Needs attention" filter lists clients who owe overdue money, sent a message you have not read, are a new lead with no reply, or have gone quiet. Every row says why.',
      },
      {
        title: 'Open a client',
        body: 'Tap a row to see their notes, stage, tags, visits, packages, folders and documents, with buttons to message, invoice or book them. "Make folder" on a row keeps everything for that client in one place.',
      },
    ],
  },

  calendar: {
    title: 'Calendar',
    intro: 'Your bookings, your hours, and the link clients use to book themselves.',
    steps: [
      {
        title: 'Set your hours',
        body: 'Tap "Availability". Switch each day on or off, set its start and end time, and use "+ Add window" for a split day. Clients can only book inside those hours.',
      },
      {
        title: 'Block time off',
        body: 'Tap an empty slot on the calendar to block it (lunch, an errand, a day off). Choose whether it blocks bookings or is just a reminder for you.',
      },
      {
        title: 'Share your booking link',
        body: 'Tap "Share" to copy your booking link or show its QR code. Put it in your bio, your email signature and your next text, and clients book without the back and forth.',
      },
      {
        title: 'Your services',
        body: 'What clients can book (name, length, price, deposit) lives under Money, in What I sell, Services.',
        cta: { label: 'Open Services', to: '/finance?section=services' },
      },
    ],
  },

  finance: {
    title: 'Money',
    intro: 'Who owes you, what you have been paid, and what you sell.',
    steps: [
      {
        title: 'Owed to you',
        body: 'Money opens on your unpaid invoices, overdue ones first, with the total at the top. Drafts, Paid and All are the tabs beside it.',
      },
      {
        title: 'Send an invoice',
        body: 'Tap "New invoice", pick a client, add what it is for, and send. The client gets an email with a button to view and pay it, and the invoice turns to Paid when they do.',
      },
      {
        title: 'Get paid in person',
        body: 'Open an unpaid invoice and tap "Collect in person" to show a QR code or text a pay link. Card payments need a payment processor connected.',
      },
      {
        title: 'Settings',
        body: 'The "Settings" button at the top is where you connect a payment processor, add other ways to get paid, and change how your invoices look.',
      },
    ],
  },

  ivy: {
    title: 'Ivy',
    intro: 'Your assistant. Ask in your own words; Ivy answers from your real bookings, clients and money.',
    steps: [
      {
        title: 'Ask anything',
        body: 'Ask a question ("who owes me money?") or ask for something to be done ("move Sam to Thursday at 2"). The suggestions on the screen are there if you are not sure where to start.',
      },
      {
        title: 'Nothing happens without you',
        body: 'Looking things up and drafting happen straight away. Anything that sends, charges, or is hard to undo shows a card first, and only goes ahead when you tap "Approve".',
      },
      {
        title: 'Show Ivy a photo',
        body: 'You can attach photos to a message, for example a screenshot of a client list or a schedule, and ask Ivy to work from it.',
      },
      {
        title: 'Chats and limits',
        body: '"New chat" starts fresh and your earlier chats stay in the list. The meter shows how many messages you have used this month.',
      },
    ],
  },

  comms: {
    title: 'Messages',
    intro: 'Every conversation with every client in one inbox.',
    steps: [
      {
        title: 'One thread per client',
        body: 'Pick a client to open their thread. When a client writes to you, you get a notification and an email, so nothing slips through.',
      },
      {
        title: 'Talk instead of typing',
        body: 'In the message box, one button turns your speech into text and the other records a voice message.',
      },
      {
        title: 'Announcements',
        body: 'Switch a thread from "Two-way" to "Broadcast" when you only need to tell a client something. They can read it but cannot reply there.',
      },
    ],
  },

  programs: {
    title: 'Programs',
    intro: 'Courses, plans and paid communities your clients can buy.',
    steps: [
      {
        title: 'Create a program',
        body: 'Tap "New program", name it and set a price (0 makes it free). It can be a one-time purchase or a monthly or yearly subscription.',
      },
      {
        title: 'Add what is inside',
        body: 'Build it from lessons: written, video, audio or files to download. You can release lessons over time instead of all at once.',
      },
      {
        title: 'Publish and share',
        body: 'Nothing is visible to clients until you publish. Then copy the sales page link and share it. "Preview as member" shows you exactly what a buyer sees.',
      },
    ],
  },

  automation: {
    title: 'Automation',
    intro: 'Where the things you do over and over become things that run by themselves.',
    steps: [
      {
        title: 'Ivy noticed',
        body: "Ivy watches for what you do the same way most of the time, like sending an invoice or a document to every new client, or messaging someone after each visit. When it sees a pattern it shows you the evidence and offers to take it over.",
      },
      {
        title: 'Your workflows',
        body: 'A trigger plus a few actions: a thank-you when someone signs up, a check-in when a client goes quiet, a task after a visit. Start from a template or build your own, and switch any of them off whenever you like.',
      },
      {
        title: 'Rewards and reminders are in Clients',
        body: 'The loyalty program and the messages Ivy sends your clients (birthday, a check-in, a book-again link, a review request) live in the Clients tab, under Rewards and Reminders.',
      },
    ],
  },

  reviews: {
    title: 'Reviews',
    intro: 'What your clients say about you, and your replies.',
    steps: [
      {
        title: 'How reviews arrive',
        body: 'A few hours after a visit you mark complete, Ivy emails the client to ask how it went. You can turn that off in Clients, under Reminders.',
      },
      {
        title: 'They publish by themselves',
        body: 'Reviews show on your booking page as soon as they are left. You cannot hide one yourself.',
      },
      {
        title: 'Respond or appeal',
        body: 'Tap "Respond" to reply in public. If a review is unfair or not from a real client, "Appeal for removal" sends it to the Ivy team to look at.',
      },
    ],
  },

  docs: {
    title: 'Documents',
    intro: 'Waivers, agreements and intake forms, signed on any device.',
    steps: [
      {
        title: 'Start a document',
        body: 'Upload a PDF, pick a template, or start blank. Place the fields where they belong: signature, initials, date, text and more.',
      },
      {
        title: 'Send it to be signed',
        body: 'Choose the client and send. They get an email with a link, sign on their phone or computer, and the signed copy is saved to their record.',
      },
      {
        title: 'Send forms automatically',
        body: 'Attach an intake form to a service (Money, What I sell, Services) and it is sent to the client automatically whenever that service is booked.',
      },
      {
        title: 'A record of every signature',
        body: 'Each signed document ends with a certificate page showing when it was sent, opened and signed, and from which device.',
      },
    ],
  },

  website: {
    title: 'Website',
    intro: 'Your own site, with your booking page built in.',
    steps: [
      {
        title: 'Start from a template',
        body: 'Pick a look to begin with. There are several templates to choose from.',
      },
      {
        title: 'Build with sections',
        body: 'Tap "Add section" and choose what you need: about, services, reviews, photos, questions, contact. Tap any section on the page to edit its words and pictures.',
      },
      {
        title: 'Decide who can see it',
        body: '"Only me" while you build, "Link only" to show a few people, "Public" when you are ready.',
      },
      {
        title: 'Publish',
        body: 'Nothing changes for visitors until you tap "Publish". The booking section on your site takes people straight to your booking page.',
      },
    ],
  },

  shops: {
    title: 'Shop',
    intro: 'One page for everyone who works at your location.',
    steps: [
      {
        title: 'Create your shop page',
        body: 'Give it a name and a web address. It starts as a draft that only you can see.',
      },
      {
        title: 'Invite the people you work with',
        body: 'Under Team, use "Invite a pro". Each person keeps their own Ivy account; their clients, money and messages stay private to them.',
      },
      {
        title: 'Publish and share',
        body: 'Publish when it is ready, then use Share to copy the link or show the QR code.',
      },
    ],
  },

  account: {
    title: 'Account',
    intro: 'Everything about your Ivy account, in four pages.',
    steps: [
      {
        title: 'Profile',
        body: 'Your details, your logo and brand color (used on your emails, invoices and booking page), and help when you need it.',
      },
      {
        title: 'Plan',
        body: 'Your subscription and billing.',
      },
      {
        title: 'Preferences',
        body: 'Which notifications and emails you get, how often Ivy checks in, and which items show in your menu.',
      },
      {
        title: 'Security & data',
        body: '2-step verification, a download of all your data, and the people you have blocked or reported.',
      },
    ],
  },

  more: {
    title: 'More',
    intro: 'Everything that is not on the bar at the bottom of the screen.',
    steps: [
      {
        title: 'Your business',
        body: 'Progress, plus any tool you already use, sits at the top.',
      },
      {
        title: 'More tools',
        body: 'Messages, Programs, Automation, Reviews, Website, Shop and Documents wait here until you start using them. Once you do, they move up by themselves.',
      },
      {
        title: 'Help on every screen',
        body: 'Every screen has an (i) next to its title. Tap it any time for a short walkthrough of that screen. Nothing opens by itself. The welcome tour of the whole app is here too.',
        cta: { label: 'Watch the welcome tour', to: WELCOME_TOUR },
      },
    ],
  },
};

export function getTutorial(tabId) {
  return TUTORIALS[tabId] || null;
}

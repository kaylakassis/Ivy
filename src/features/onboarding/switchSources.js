// "Where are your clients today?" choices for the onboarding Switch step
// and the import hub. Ids are whitelisted server-side (VALID_SWITCH_FROM in
// api/onboarding/state.js); keep both lists in sync.
//
// Export directions were checked against each app's own help center in
// November 2026 (Square, Acuity, Vagaro, Calendly, Mindbody, Fresha, Booksy,
// Apple, Google). Where an app's own docs do not describe a self-serve
// export (GlossGenius), the wording stays general on purpose. Two short
// lines each: line 1 is clients, line 2 is appointments or the next step.
//
// `actions` decides the buttons on the step:
//   file     → upload a CSV / spreadsheet / contacts / calendar file
//   contacts → upload a .vcf or pick from the phone's contacts
//   google   → appointments from Google Calendar
//   ics      → appointments from a calendar file
//   photo    → send Ivy a screenshot or photo (always offered)
export const SWITCH_SOURCES = [
  {
    id: 'square', label: 'Square Appointments', actions: ['file'],
    guide: [
      'Clients: in your Square Dashboard, go to Customers, Directory, Import / Export, then Export customers.',
      'Appointments: send Ivy a screenshot of your upcoming calendar.',
    ],
  },
  {
    id: 'acuity', label: 'Acuity', actions: ['file', 'google'],
    guide: [
      'Clients: go to Clients, Import/export, then Export client list.',
      'Appointments: if Acuity adds them to your Google Calendar, bring them in from there.',
    ],
  },
  {
    id: 'vagaro', label: 'Vagaro', actions: ['file'],
    guide: [
      'Clients: on a computer, open the Customers report and use Export to save it as Excel (owner login).',
      'Open that file and save it as CSV, or send Ivy a screenshot of the list.',
    ],
  },
  {
    id: 'glossgenius', label: 'GlossGenius', actions: ['file'],
    guide: [
      'Clients: on a computer, open your Clients list and look for Export.',
      'No Export button? Ask GlossGenius support for a copy, or send Ivy a screenshot.',
    ],
  },
  {
    id: 'booksy', label: 'Booksy', actions: ['file'],
    guide: [
      "Clients: Booksy's help center says to ask their support team for a copy of your client list.",
      'While you wait, send Ivy screenshots of your client list.',
    ],
  },
  {
    id: 'calendly', label: 'Calendly', actions: ['file', 'google'],
    guide: [
      'Go to Scheduled Events, pick Past or a date range, then Export. The file has each name and email.',
      'Upcoming bookings on your Google Calendar can come in from there.',
    ],
  },
  {
    id: 'mindbody', label: 'Mindbody', actions: ['file'],
    guide: [
      'Clients: open Reports, Mailing Lists, pick all clients, Generate, then Export to Excel.',
      'Open that file and save it as CSV, or send Ivy a screenshot.',
    ],
  },
  {
    id: 'fresha', label: 'Fresha', actions: ['file'],
    guide: [
      'Clients: open Clients, tap Options at the top right, then choose CSV.',
      'Appointments: send Ivy a screenshot of your upcoming calendar.',
    ],
  },
  {
    id: 'spreadsheet', label: 'A spreadsheet', actions: ['file'],
    guide: [
      'Excel: File, Save As, CSV. Google Sheets: File, Download, Comma-separated values.',
      'Upload it here and Ivy matches the columns for you.',
    ],
  },
  {
    id: 'phone', label: 'My phone contacts', actions: ['contacts'],
    guide: [
      'iPhone: in Contacts, touch and hold a list, tap Export, then save the file.',
      'Or export a contacts file from iCloud.com. Then tick who is a client.',
    ],
  },
  {
    id: 'paper', label: 'A paper book or notes', actions: ['photo'],
    guide: [
      'Take a clear photo of each page and send it to Ivy.',
      'Ivy reads the names and numbers, and you check them before anything is saved.',
    ],
  },
  {
    id: 'google', label: 'Google Calendar', actions: ['google', 'ics'],
    guide: [
      'Connect Google Calendar and pick which upcoming events become bookings.',
      'Clients are added from those events. Nobody gets a message.',
    ],
  },
  {
    id: 'other', label: 'Somewhere else', actions: ['file'],
    guide: [
      'Look for Export in your Clients or Customers list, and pick CSV or Excel.',
      'No export? Send Ivy a screenshot of your client list.',
    ],
  },
  { id: 'new', label: "I'm just getting started", actions: [], guide: [] },
];

export const SWITCH_SOURCE_BY_ID = Object.fromEntries(SWITCH_SOURCES.map((s) => [s.id, s]));

// The message Ivy's composer is prefilled with for "Send Ivy a screenshot".
// The owner reviews it and presses send themselves.
export function screenshotPrompt(sourceId) {
  const s = SWITCH_SOURCE_BY_ID[sourceId];
  if (sourceId === 'paper') return 'Here is a photo of my client book. Please add these people as my clients.';
  if (s && sourceId !== 'other' && sourceId !== 'new' && sourceId !== 'spreadsheet' && sourceId !== 'phone') {
    return `Here is a screenshot of my clients from ${s.label}. Please add them as my clients.`;
  }
  return 'Here is a screenshot of my client list. Please add these people as my clients.';
}

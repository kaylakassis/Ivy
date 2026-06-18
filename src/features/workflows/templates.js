// Workflow template catalog. Each entry is a complete preset that
// produces a `workflows` row when accepted. Picking a template just
// pre-fills the WorkflowEditor - every field stays editable, including
// trigger type and action ordering, so owners can tweak the defaults
// to match their voice / cadence before saving.
//
// Token support (resolved at workflow execution time, see api/_lib/workflows.js):
//   {{firstName}}  {{clientName}}  {{businessName}}  {{ownerName}}
//
// Shape of each template:
//   id           - stable id for analytics + "you already imported X"
//   category     - UI grouping
//   name         - pre-fills the workflow name (editable)
//   description  - pre-fills the workflow description (editable)
//   summary      - one-liner shown in the picker (NOT saved)
//   triggerType  - lead_created | client_created | client_inactive | booking_completed
//   triggerConfig - JSONB
//   actions      - same shape the editor produces

export const WORKFLOW_TEMPLATES = [
  // ──────────────────────────────────────────────────────────────
  // Welcome / Onboarding
  // ──────────────────────────────────────────────────────────────
  {
    id: 'welcome-new-client',
    category: 'Welcome & onboarding',
    name: 'Welcome new client',
    description: 'Warm intro email + an internal task to make a personal welcome call.',
    summary: 'Email + a task to call them, the moment a client is added.',
    triggerType: 'client_created',
    triggerConfig: {},
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Welcome to {{businessName}}, {{firstName}}!',
          body: `Hi {{firstName}},\n\nWe're so glad to have you. Quick note from {{ownerName}} - if you have any questions before your first appointment, just reply to this email.\n\nA few things you might find useful:\n  • Book / reschedule any time from your portal\n  • All your invoices + documents live there too\n  • We send a reminder 24 hours before each visit\n\nLooking forward to working with you.\n\n{{ownerName}}`,
        },
      },
      {
        type: 'create_task',
        config: {
          title: 'Welcome call: {{clientName}}',
          notes: 'Quick check-in - anything they want us to know before their first session?',
          dueInDays: 1,
        },
      },
    ],
  },

  {
    id: 'new-client-intake-form',
    category: 'Welcome & onboarding',
    name: 'Send intake form to new clients',
    description: 'Auto-send a document for signing whenever a client is added.',
    summary: 'Auto-send an intake/consent form when a client is added.',
    triggerType: 'client_created',
    triggerConfig: {},
    actions: [
      {
        type: 'send_document',
        config: { templateId: '' }, // owner picks in the editor
      },
      { type: 'wait', config: { days: 3, hours: 0 } },
      {
        type: 'create_task',
        config: {
          title: 'Chase intake form from {{clientName}}',
          notes: 'They were sent the intake form 3 days ago - check if it\'s back.',
          dueInDays: 0,
        },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────
  // Lead nurture
  // ──────────────────────────────────────────────────────────────
  {
    id: 'lead-instant-reply',
    category: 'Lead nurture',
    name: 'Instant lead reply',
    description: 'Reply to every new contact-form lead within seconds with your booking link.',
    summary: 'Instant auto-reply to inbound leads with a booking CTA.',
    triggerType: 'lead_created',
    triggerConfig: {},
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Thanks for reaching out, {{firstName}}',
          body: `Hi {{firstName}},\n\nThanks for getting in touch with {{businessName}}. I usually reply within a few hours, but in the meantime you can grab any open slot from my calendar with the button below.\n\nTalk soon,\n{{ownerName}}`,
          ctaUrl: '',
        },
      },
    ],
  },

  {
    id: 'lead-3step-nurture',
    category: 'Lead nurture',
    name: '5-day lead nurture sequence',
    description: 'Intro → social proof → soft offer. Stops if they\'ve already booked (tag-gated).',
    summary: 'Three emails over 5 days that warm a cold lead.',
    triggerType: 'lead_created',
    triggerConfig: {},
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Hi from {{businessName}}',
          body: `Hi {{firstName}},\n\nNice to meet you. I'm {{ownerName}} - I run {{businessName}}.\n\nI'll be honest, I'm not going to spam you. Just wanted to introduce myself and let you know what to expect if you decide to book.\n\nMore from me in a couple of days. In the meantime, if you have a question, just reply.\n\n{{ownerName}}`,
        },
      },
      { type: 'wait', config: { days: 2, hours: 0 } },
      {
        type: 'if_lacks_tag',
        config: { tag: 'booked' },
      },
      {
        type: 'send_email',
        config: {
          subject: 'A quick story, {{firstName}}',
          body: `Hi {{firstName}},\n\nHonestly, the best way to know if we're a fit is to hear from the people I already work with.\n\nA client said this recently: "I came in skeptical - it turned out to be the easiest decision I made all year."\n\nIf you want, you can book a session straight from the calendar link in my replies.\n\n{{ownerName}}`,
        },
      },
      { type: 'wait', config: { days: 3, hours: 0 } },
      {
        type: 'if_lacks_tag',
        config: { tag: 'booked' },
      },
      {
        type: 'send_email',
        config: {
          subject: 'Last note from me, {{firstName}}',
          body: `Hi {{firstName}},\n\nI won't keep emailing you - promise. Just wanted to leave one more invitation.\n\nIf you'd like to try a session, hit reply and we'll find a time. If not, no hard feelings - wishing you well.\n\n{{ownerName}}`,
        },
      },
      {
        type: 'create_task',
        config: {
          title: 'Personal follow-up: {{clientName}}',
          notes: 'They went through the full nurture sequence. Worth a 30-second hand-written reply.',
          dueInDays: 1,
        },
      },
    ],
  },

  {
    id: 'lead-quick-task',
    category: 'Lead nurture',
    name: 'New lead → call within 24h',
    description: 'Drops a task on your list to personally call any new lead within a day.',
    summary: 'Adds a "call new lead" task to your queue.',
    triggerType: 'lead_created',
    triggerConfig: {},
    actions: [
      {
        type: 'create_task',
        config: {
          title: 'Call new lead: {{clientName}}',
          notes: 'Personal call within 24h converts way better than email.',
          dueInDays: 1,
        },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────
  // Retention / Win-back
  // ──────────────────────────────────────────────────────────────
  {
    id: 'winback-60-days',
    category: 'Retention & win-back',
    name: 'Win back after 60 days',
    description: 'Gentle "miss seeing you" email when a client hasn\'t booked in 60 days.',
    summary: '60-day silence → friendly win-back email.',
    triggerType: 'client_inactive',
    triggerConfig: { daysInactive: 60 },
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Miss seeing you, {{firstName}}',
          body: `Hi {{firstName}},\n\nIt's been a couple of months. No agenda - just wanted to say hi and leave the door open if you'd like to come back in.\n\nReply with a couple of times that work and I'll pencil you in.\n\n{{ownerName}}`,
        },
      },
    ],
  },

  {
    id: 'winback-90-day-task',
    category: 'Retention & win-back',
    name: 'Win back after 90 days - with task',
    description: 'Email + an internal task so you remember to personally check in.',
    summary: '90-day silence → email + a "personal check-in" task.',
    triggerType: 'client_inactive',
    triggerConfig: { daysInactive: 90 },
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Quick hello, {{firstName}}',
          body: `Hi {{firstName}},\n\nIt's been about three months since we last connected. Not chasing - just wanted to make sure everything's okay and let you know I'd love to see you again whenever you're ready.\n\n{{ownerName}}`,
        },
      },
      {
        type: 'create_task',
        config: {
          title: 'Personal follow-up: {{clientName}} (90d silent)',
          notes: 'Long-time client gone quiet - worth a personal text or call.',
          dueInDays: 2,
        },
      },
    ],
  },

  {
    id: 'vip-quick-winback',
    category: 'Retention & win-back',
    name: 'VIP-only fast win-back (30 days)',
    description: 'Only fires for clients tagged "vip" - faster cadence for your best clients.',
    summary: '30-day silence + tagged "vip" → personal email + a task.',
    triggerType: 'client_inactive',
    triggerConfig: { daysInactive: 30 },
    actions: [
      {
        type: 'if_has_tag',
        config: { tag: 'vip' },
      },
      {
        type: 'send_email',
        config: {
          subject: '{{firstName}}, want to lock in your next slot?',
          body: `Hi {{firstName}},\n\nNoticed it's been a few weeks since you've been in. As one of my regulars, I want to make sure you've got something on the books.\n\nReply with a couple of times this week or next and I'll hold a slot.\n\n{{ownerName}}`,
        },
      },
      {
        type: 'create_task',
        config: {
          title: 'Personal text to {{clientName}}',
          notes: 'VIP client, 30 days quiet. Worth a personal text.',
          dueInDays: 0,
        },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────
  // Post-booking follow-up
  // ──────────────────────────────────────────────────────────────
  {
    id: 'post-booking-thank-you',
    category: 'Post-booking follow-up',
    name: 'Thank-you email next day',
    description: 'Short note after every completed session.',
    summary: '1 day after each session → quick thank-you email.',
    triggerType: 'booking_completed',
    triggerConfig: { daysAfter: 1 },
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Thank you for coming in, {{firstName}}',
          body: `Hi {{firstName}},\n\nReally enjoyed seeing you yesterday. If anything came up afterwards, or you want to talk through next steps, just hit reply.\n\n{{ownerName}}`,
        },
      },
    ],
  },

  {
    id: 'post-booking-review-request',
    category: 'Post-booking follow-up',
    name: 'Ask for a review (3 days after)',
    description: 'Asks happy clients for a review once the session has settled in.',
    summary: '3 days after a session → review-request email.',
    triggerType: 'booking_completed',
    triggerConfig: { daysAfter: 3 },
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'A favour, {{firstName}}?',
          body: `Hi {{firstName}},\n\nIf you enjoyed our last session, would you mind leaving a short review? It genuinely helps new people find me - and one sentence is plenty.\n\nNo pressure if it's not for you. Either way, thank you for trusting me.\n\n{{ownerName}}`,
          ctaUrl: '',
        },
      },
    ],
  },

  {
    id: 'post-booking-rebook',
    category: 'Post-booking follow-up',
    name: 'Re-book reminder (4 weeks out)',
    description: 'Nudge to book the next session before life gets in the way.',
    summary: '28 days after a session → re-book email + SMS.',
    triggerType: 'booking_completed',
    triggerConfig: { daysAfter: 28 },
    actions: [
      {
        type: 'send_email',
        config: {
          subject: 'Time to book your next session, {{firstName}}?',
          body: `Hi {{firstName}},\n\nIt's been about four weeks since we last met - usually a good moment to lock in the next one before the calendar fills up.\n\nReply with a couple of times that work and I'll hold a slot for you.\n\n{{ownerName}}`,
        },
      },
      {
        type: 'send_sms',
        config: {
          body: 'Hi {{firstName}} - it\'s {{ownerName}}. Want to lock in your next session? Reply with a couple of times that work.',
        },
      },
    ],
  },

  {
    id: 'post-booking-followup-task',
    category: 'Post-booking follow-up',
    name: 'Internal follow-up task',
    description: 'Adds a task to personally check in after a session - no automated email.',
    summary: 'Adds a task to your list 2 days after a session.',
    triggerType: 'booking_completed',
    triggerConfig: { daysAfter: 2 },
    actions: [
      {
        type: 'create_task',
        config: {
          title: 'Check in with {{clientName}}',
          notes: 'How did they feel after the session? Any wins / concerns to address?',
          dueInDays: 0,
        },
      },
    ],
  },
];

// Sorted unique list of categories - used by the picker for grouping.
export const TEMPLATE_CATEGORIES = Array.from(
  new Set(WORKFLOW_TEMPLATES.map((t) => t.category))
);

// Pull a single template (and clone its actions / triggerConfig so the
// editor's mutations don't bleed back into the catalog).
export function getTemplateById(id) {
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  return {
    ...t,
    triggerConfig: { ...(t.triggerConfig || {}) },
    actions: (t.actions || []).map((a) => ({
      type: a.type,
      config: { ...(a.config || {}) },
    })),
  };
}

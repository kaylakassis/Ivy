// Service-business categories used by Onboarding (step 2: "What do you
// do?") and the Calendar Share drawer's category dropdown. Centralized
// so adding a category here unlocks it everywhere — previously this
// list was duplicated across two files and silently drifted.
//
// Each category drives:
//   - Ivy's coaching tone (the LLM gets the category as a hint)
//   - The starter service-pack the wizard suggests on step 3
//   - The category facet on the Discover surface for clients
//
// "Other" exists as a deliberate escape hatch — solo businesses don't
// fit five tidy buckets, and forcing a wrong choice hurts both the
// service-pack quality and Ivy's tone-matching.
export const CATEGORIES = [
  { id: 'Wellness',     label: 'Wellness',          icon: 'Spark',
    hint: 'Massage, acupuncture, energy work, reiki' },
  { id: 'Beauty',       label: 'Beauty',            icon: 'Gift',
    hint: 'Hair, nails, skin, brows, lashes, tattoos' },
  { id: 'Fitness',      label: 'Fitness',           icon: 'Trending',
    hint: 'Personal training, yoga, pilates, sports coaching' },
  { id: 'Health',       label: 'Health',            icon: 'Check',
    hint: 'Therapy, nutrition, chiropractic, doulas' },
  { id: 'Home',         label: 'Home services',     icon: 'Home',
    hint: 'Cleaning, handyman, lawn, pool, locksmith' },
  { id: 'Pet',          label: 'Pet services',      icon: 'Heart',
    hint: 'Walking, grooming, training, boarding' },
  { id: 'Creative',     label: 'Creative',          icon: 'Camera',
    hint: 'Photography, video, design, copywriting' },
  { id: 'Education',    label: 'Education',         icon: 'Trophy',
    hint: 'Tutoring, music, language, dance, instruction' },
  { id: 'Events',       label: 'Events & hospitality', icon: 'Calendar',
    hint: 'Planning, catering, DJ, florist, bartender' },
  { id: 'Professional', label: 'Professional',      icon: 'Doc',
    hint: 'Consulting, coaching, legal, accounting' },
  { id: 'Other',        label: 'Other',             icon: 'Plus',
    hint: 'Something else — we still fit. Pick this and customize.' },
];

// Just the IDs — used by ShareDrawer's <select>.
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Starter packs the onboarding wizard offers when a category is picked.
// The user can add any subset to their workspace in one click. Prices
// are placeholders meant to be tweaked, not blindly accepted.
export const SERVICE_PACKS = {
  Wellness: [
    { name: '60-min massage',           durationMinutes: 60, price: 120 },
    { name: '90-min massage',           durationMinutes: 90, price: 170 },
    { name: 'Initial consult',          durationMinutes: 30, price: 0 },
  ],
  Beauty: [
    { name: 'Cut & style',              durationMinutes: 60, price: 90 },
    { name: 'Color',                    durationMinutes: 120, price: 180 },
    { name: 'Manicure',                 durationMinutes: 45, price: 50 },
  ],
  Fitness: [
    { name: '60-min training session',  durationMinutes: 60, price: 95 },
    { name: 'Group class',              durationMinutes: 60, price: 25 },
    { name: 'Free consultation',        durationMinutes: 30, price: 0 },
  ],
  Health: [
    { name: 'Initial intake',           durationMinutes: 60, price: 150 },
    { name: 'Follow-up session',        durationMinutes: 50, price: 120 },
    { name: 'Discovery call',           durationMinutes: 20, price: 0 },
  ],
  Home: [
    { name: 'Standard service visit',   durationMinutes: 90, price: 120 },
    { name: 'Deep clean / project',     durationMinutes: 180, price: 240 },
    { name: 'Quote / walkthrough',      durationMinutes: 30, price: 0 },
  ],
  Pet: [
    { name: '30-min visit',             durationMinutes: 30, price: 25 },
    { name: 'Grooming appointment',     durationMinutes: 90, price: 80 },
    { name: 'Meet & greet',             durationMinutes: 20, price: 0 },
  ],
  Creative: [
    { name: 'Mini session',             durationMinutes: 30, price: 150 },
    { name: 'Full session',             durationMinutes: 120, price: 600 },
    { name: 'Consultation',             durationMinutes: 30, price: 0 },
  ],
  Education: [
    { name: '60-min lesson',            durationMinutes: 60, price: 80 },
    { name: '90-min deep session',      durationMinutes: 90, price: 110 },
    { name: 'Trial class',              durationMinutes: 30, price: 0 },
  ],
  Events: [
    { name: 'Half-day service',         durationMinutes: 240, price: 800 },
    { name: 'Full-day service',         durationMinutes: 480, price: 1500 },
    { name: 'Planning consultation',    durationMinutes: 60, price: 0 },
  ],
  Professional: [
    { name: 'Discovery call',           durationMinutes: 30, price: 0 },
    { name: '60-min consult',           durationMinutes: 60, price: 200 },
    { name: 'Strategy workshop',        durationMinutes: 120, price: 600 },
  ],
  Other: [
    { name: '30-min appointment',       durationMinutes: 30, price: 0 },
    { name: '60-min appointment',       durationMinutes: 60, price: 0 },
    { name: 'Discovery / consult',      durationMinutes: 20, price: 0 },
  ],
};

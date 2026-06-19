// Canonical Ivy OS pricing constants - the single source of truth shared
// by the marketing ROI calculator, the pricing page, and the in-app
// paywall. Keeping them here (rather than inside a lazy-loaded marketing
// component) means the always-loaded paywall can show the same numbers
// without pulling the marketing bundle into the core chunk.
//
// If a competitor changes their price, update TOOL_STACK here and every
// surface that quotes the savings number updates together.

// Typical replaceable monthly spend across the SaaS stack a solo
// business otherwise has to assemble. Numbers are publicly listed
// entry-tier prices (May 2026), kept conservative so we never
// over-promise.
export const TOOL_STACK = [
  { name: 'HoneyBook',  monthly: 39, replaces: 'clients + invoices + contracts' },
  { name: 'Calendly',   monthly: 12, replaces: 'booking pages + reminders' },
  { name: 'QuickBooks Self-Employed', monthly: 20, replaces: 'invoices + expenses + taxes' },
  { name: 'Mailchimp',  monthly: 13, replaces: 'newsletter + email blasts' },
  { name: 'Squarespace', monthly: 23, replaces: 'website + custom domain' },
  { name: 'Loom',       monthly: 15, replaces: 'product walkthroughs' },
];

export const STACK_TOTAL = TOOL_STACK.reduce((sum, t) => sum + t.monthly, 0);

// The single paid subscription ("Active").
export const IVY_PRICE = 49;

// Trial length granted at signup. Matches the workspaces.trial_ends_at
// default (api/_lib/schema.js) - the hard paywall flips the wall on
// when this expires. Marketing copy reads from here so a future change
// in the trial length only happens in one place.
export const TRIAL_DAYS = 14;

// Annual plan ("Active, billed yearly"). Priced at 10× the monthly
// rate so a year of Ivy OS costs the same as ten months paid monthly -
// i.e. "2 months free" versus 12 × $49 = $588. Surfaced as the
// highlighted LTV option on the paywall + pricing page; monthly stays
// the honest default.
export const IVY_PRICE_ANNUAL = 490;

// Derived once so copy never hardcodes the math (same discipline as
// STACK_TOTAL): the yearly saving vs paying monthly, and the effective
// monthly rate when billed annually.
export const ANNUAL_SAVINGS = IVY_PRICE * 12 - IVY_PRICE_ANNUAL;          // $98
export const ANNUAL_MONTHLY_EQUIV = Math.round((IVY_PRICE_ANNUAL / 12) * 100) / 100; // $40.83

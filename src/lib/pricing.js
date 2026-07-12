// Canonical Ivy pricing constants - the single source of truth shared
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
// over-promise. Sum lands above $149/mo so the "save $100+/mo on
// average" headline is grounded in real prices rather than puffery.
export const TOOL_STACK = [
  { name: 'HoneyBook',  monthly: 39, replaces: 'clients + invoices + contracts' },
  { name: 'Calendly',   monthly: 12, replaces: 'booking pages + reminders' },
  { name: 'Acuity Scheduling', monthly: 16, replaces: 'advanced scheduling + intake forms' },
  { name: 'QuickBooks Self-Employed', monthly: 20, replaces: 'invoices + expenses + taxes' },
  { name: 'Mailchimp',  monthly: 13, replaces: 'newsletter + email blasts' },
  { name: 'Squarespace', monthly: 23, replaces: 'website + custom domain' },
  { name: 'DocuSign',   monthly: 15, replaces: 'legally-binding e-signatures' },
  { name: 'Loom',       monthly: 15, replaces: 'product walkthroughs' },
];

export const STACK_TOTAL = TOOL_STACK.reduce((sum, t) => sum + t.monthly, 0);

// The single paid subscription ("Active"). Matches the Stripe price the
// checkout charges (IVY_STRIPE_PRICE_ID) — keep them in lockstep.
export const IVY_PRICE = 8.99;

// Trial length granted at signup. Matches the workspaces.trial_ends_at
// default (api/_lib/schema.js) - the hard paywall flips the wall on
// when this expires. Marketing copy reads from here so a future change
// in the trial length only happens in one place.
export const TRIAL_DAYS = 14;

// Billing cadence for the "Active" plan. We bill every WEEK (7 days) — so
// 365/7 ≈ 52.14 cycles per year. All savings/equivalence math below is derived
// from this so a future cadence change only requires updating CYCLES_PER_YEAR.
export const BILLING_CYCLE_DAYS = 7;
export const CYCLES_PER_YEAR = 365 / BILLING_CYCLE_DAYS;

// Annual plan ("Active, billed yearly"). Priced below ~52 × the weekly rate so
// it's a genuine discount. Surfaced as the highlighted LTV option on the paywall
// + pricing page; the weekly plan stays the honest default.
export const IVY_PRICE_ANNUAL = 375;

// Derived once so copy never hardcodes the math (same discipline as
// STACK_TOTAL): the yearly saving vs paying weekly, and the per-week
// equivalent of the annual rate.
export const ANNUAL_SAVINGS = Math.round(IVY_PRICE * CYCLES_PER_YEAR - IVY_PRICE_ANNUAL);  // ≈ $94
export const ANNUAL_CYCLE_EQUIV = Math.round((IVY_PRICE_ANNUAL / CYCLES_PER_YEAR) * 100) / 100;  // ≈ $7.19 per week
// Percent saved by paying annually vs per-cycle. Comes out to ~20% but NOT
// exactly, so every surface prefixes it with "~" / "about" — never a bare 20%.
export const ANNUAL_SAVINGS_PCT = Math.round((1 - IVY_PRICE_ANNUAL / (IVY_PRICE * CYCLES_PER_YEAR)) * 100);  // ≈ 20

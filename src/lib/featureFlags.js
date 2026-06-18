// Build-time feature flags. Use sparingly - these are for hiding
// product surfaces from users while keeping the backend code intact
// so a flip-on is a one-line change.
//
// Toggle a flag and redeploy. Backed by Vite env vars when present
// (VITE_FLAG_*); falls back to the hard-coded default below.
//
// IMPORTANT: do not gate security on these. Flags are visible in the
// shipped bundle; they only affect what the UI offers. Backend endpoints
// must enforce their own access rules independently.

const FALSE_VALUES = new Set(['0', 'false', 'off', 'no']);
function envFlag(name, fallback) {
  const v = import.meta.env?.[`VITE_FLAG_${name}`];
  if (v == null || v === '') return fallback;
  return !FALSE_VALUES.has(String(v).toLowerCase());
}

export const FLAGS = {
  // Show the Square + PayPal connect cards in Finance → Provider, the
  // Square/PayPal columns on the marketing comparison pages, and any
  // other surface that offers them as options. Tabled for launch -
  // Stripe is the only payment provider we surface for now. The
  // backend code remains intact; flipping this back to true re-exposes
  // them everywhere.
  squarePaypal: envFlag('SQUARE_PAYPAL', false),
};

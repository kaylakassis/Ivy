// Locale + currency-aware money formatting.
//
// The app used to hardcode '$' + .toLocaleString('en-US', ...) all
// over the place — fine while every workspace was USD-only. With
// multi-currency invoices each one carries its own currency code;
// we have to render the right symbol + decimal convention.
//
// Browser Intl.NumberFormat does the heavy lifting; this helper
// just centralizes the call so we don't drift if we ever need to
// override (e.g. JPY has no decimals).

const formatterCache = new Map();
function getFormatter(currency) {
  const code = (currency || 'USD').toUpperCase();
  if (formatterCache.has(code)) return formatterCache.get(code);
  let f;
  try {
    f = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
    });
  } catch {
    // Unknown currency code — fall back to USD formatting with the
    // code prepended, e.g. "ZZZ 1,234.00". Better than crashing the UI.
    f = {
      format: (n) => `${code} ${Number(n || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      })}`,
    };
  }
  formatterCache.set(code, f);
  return f;
}

export function fmtMoney(amount, currency = 'USD') {
  const n = Number(amount || 0);
  return getFormatter(currency).format(n);
}

// Quick check: is this currency code valid for Intl?
export function isSupportedCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/i.test(code)) return false;
  try {
    new Intl.NumberFormat(undefined, { style: 'currency', currency: code.toUpperCase() });
    return true;
  } catch {
    return false;
  }
}

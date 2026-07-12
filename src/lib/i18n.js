// Lightweight i18n for Ivy.
//
// Why not react-intl / i18next / formatjs:
//   • react-intl bundles ~80 KB for features (ICU MessageFormat,
//     plural rules, AST cache) we don't yet need.
//   • i18next is fine but pulls a thousand-file ecosystem with it.
//   • This module is ~80 lines + one strings.js per locale. We can
//     graduate to a real library when we genuinely need ICU
//     formatting (gender-aware messages, ordinal plurals in 25
//     languages, etc.).
//
// What it does:
//   t('marketing.hero.title')                 → 'Run your whole business from one place'
//   t('billing.due_in_days', { n: 3 })        → 'Due in 3 days'
//   t('inbox.unread', { n: 1 })               → '1 unread'
//   t('inbox.unread', { n: 5 })               → '5 unread'
//
// Plural support: when a key has `_one` / `_other` siblings, t()
// picks based on the `n` interpolation. Otherwise it's a plain
// template-substitution lookup.
//
// Storage: per-locale JS module under src/lib/locales/. Lazy-loaded
// on locale change. Default 'en' is bundled in the main chunk
// (every user starts in English; locale switch is the rare path).
//
// Locale resolution:
//   1. URL ?lang=fr override (highest priority)
//   2. localStorage 'Ivy:lang'
//   3. navigator.language matched to a supported code
//   4. 'en' fallback
import { useEffect, useState, useCallback } from 'react';
import en from './locales/en.js';

const LOCALE_KEY = 'Ivy:lang';

// Static-import 'en' for cold-start speed. Other locales lazy-load
// via the dynamic import() in setLocale below. Bundle splitter
// drops each locale into its own chunk.
const LOADED = new Map([['en', en]]);

let currentLocale = 'en';
let currentStrings = en;
const subscribers = new Set();

export function getLocale() { return currentLocale; }
export function getSupportedLocales() {
  // Hardcoded for now - we don't ship dynamic locale discovery.
  // Each locale that gets a strings file should be added here so
  // the language picker UI knows what to offer.
  return [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Español' },
    { code: 'fr', label: 'Français' },
    // Add more as locale files land.
  ];
}

export async function setLocale(code) {
  if (code === currentLocale) return;
  if (!LOADED.has(code)) {
    try {
      // Dynamic import so each locale is its own chunk; only the
      // active one is loaded. Falls back to English on import
      // failure (typo'd code, network error).
      const mod = await import(`./locales/${code}.js`);
      LOADED.set(code, mod.default || mod);
    } catch {
      // Unknown / missing locale: stay on current. Caller can
      // surface this as a UI hint if they want.
      // eslint-disable-next-line no-console
      console.warn(`[i18n] locale '${code}' not available; staying on '${currentLocale}'`);
      return;
    }
  }
  currentLocale = code;
  currentStrings = LOADED.get(code);
  try { localStorage.setItem(LOCALE_KEY, code); } catch { /* private-mode */ }
  for (const fn of subscribers) try { fn(code); } catch { /* keep going */ }
}

// Pick a starting locale on first import.
(function initLocale() {
  try {
    const url  = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null;
    const ls   = (() => { try { return localStorage.getItem(LOCALE_KEY); } catch { return null; } })();
    const navL = typeof navigator !== 'undefined' ? (navigator.language || '').slice(0, 2).toLowerCase() : null;
    const supported = new Set(getSupportedLocales().map((l) => l.code));
    const pick = [url, ls, navL].find((c) => c && supported.has(c));
    if (pick) {
      // Sync: only 'en' is preloaded. If user prefers fr/es etc,
      // kick off the async load - until it resolves, we render in
      // English. Components subscribed via useLocale will re-render
      // when the load completes.
      if (pick === 'en') currentLocale = 'en';
      else setLocale(pick);
    }
  } catch {
    // SSR or other context - stay on English.
  }
})();

// t(key, vars?) - looks up the string in the current locale's strings
// table; falls back to English if missing; falls back to the key
// itself if both miss (developer can tell something's off).
export function t(key, vars) {
  const tableStrings = currentStrings || {};
  let value = tableStrings[key];

  // Plural lookup: if vars.n is a number and we have _one/_other
  // siblings, pick the right one.
  if (vars && typeof vars.n === 'number') {
    const pluralKey = vars.n === 1 ? `${key}_one` : `${key}_other`;
    if (tableStrings[pluralKey] !== undefined) value = tableStrings[pluralKey];
    else if (en[pluralKey] !== undefined) value = en[pluralKey];
  }
  if (value === undefined) value = en[key];
  if (value === undefined) return key;

  // {var} interpolation - extremely simple, no ICU.
  if (vars && typeof value === 'string') {
    return value.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
  }
  return value;
}

// React hook so components re-render when the locale changes.
export function useLocale() {
  const [locale, setLocaleState] = useState(currentLocale);
  useEffect(() => {
    const onChange = (code) => setLocaleState(code);
    subscribers.add(onChange);
    return () => { subscribers.delete(onChange); };
  }, []);
  const change = useCallback((code) => setLocale(code), []);
  return { locale, setLocale: change };
}

// Per-section style: the one list of what the editor's "Section style"
// panel (Inspector.jsx StyleControls + AnimationPicker) can set, shared by
// the editor, Ivy (api/_lib/ivyWebsiteTools.js), the React renderer
// (SectionRenderer.jsx) and the server HTML (api/_lib/siteHtml.js).
//
// Stored on each section, outside `data`:
//   style.background       '' | a swatch value below | '#rrggbb'
//   style.padding          undefined (Normal) | 'compact' (Snug) | 'spacious' (Roomy)
//   style.textAlign        undefined | 'left' | 'center' | 'right'
//   style.hideOnDesktop    true | undefined
//   style.hideOnMobile     true | undefined
//   style.headlineGradient undefined | a headline swatch value below
//   style.parallax         true | undefined
//   animate                null | 'fade' | { type, delayMs, durationMs }
//
// Nothing here is free-form CSS. Renderers only apply a background or
// headline effect that passes safeBackground / safeHeadlineGradient, so a
// value like "red;}body{display:none}" or url(...) never reaches a page.
import { ANIMATIONS, PADDING_DENSITIES } from './sections.js';
import { BG_SWATCHES, HEADLINE_SWATCHES, isHexColor, safeBackground, safeHeadlineGradient } from './styleSafety.js';

export { BG_SWATCHES, HEADLINE_SWATCHES, isHexColor, safeBackground, safeHeadlineGradient };

// Stored value (undefined = Normal) and the button label the editor shows.
export const SPACING_OPTIONS = [
  { id: 'snug',   stored: 'compact',  label: 'Snug' },
  { id: 'normal', stored: undefined,  label: 'Normal' },
  { id: 'roomy',  stored: 'spacious', label: 'Roomy' },
];
export const TEXT_ALIGN_OPTIONS = [
  { id: 'default', stored: undefined, label: 'Default' },
  { id: 'left',    stored: 'left',    label: 'Left' },
  { id: 'center',  stored: 'center',  label: 'Center' },
  { id: 'right',   stored: 'right',   label: 'Right' },
];
// The editor's sliders: 0 to 2 s wait, 0.15 to 2 s duration, 50 ms steps.
export const ANIMATION_DELAY = { min: 0, max: 2000, step: 50, dflt: 0 };
export const ANIMATION_DURATION = { min: 150, max: 2000, step: 50, dflt: 700 };

export const safePadding = (v) => (v && Object.prototype.hasOwnProperty.call(PADDING_DENSITIES, v) ? v : '');
export const safeTextAlign = (v) => (['left', 'center', 'right'].includes(v) ? v : '');

// The animation as { type, delayMs, durationMs }, or null when the
// section just appears (or the stored value is not one the editor offers).
export function normalizeAnimate(animate) {
  if (!animate) return null;
  const raw = typeof animate === 'string' ? { type: animate } : (typeof animate === 'object' ? animate : null);
  if (!raw || !Object.prototype.hasOwnProperty.call(ANIMATIONS, raw.type)) return null;
  const num = (x, r) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : r.dflt;
  };
  return {
    type: raw.type,
    delayMs: raw.delayMs == null ? ANIMATION_DELAY.dflt : num(raw.delayMs, ANIMATION_DELAY),
    durationMs: raw.durationMs == null ? ANIMATION_DURATION.dflt : num(raw.durationMs, ANIMATION_DURATION),
  };
}
// Stored form, same as the editor's AnimationPicker: a plain string when the
// timings are the defaults, else the object.
export function storedAnimate(a) {
  if (!a || !a.type) return null;
  if ((a.delayMs || 0) === ANIMATION_DELAY.dflt && (a.durationMs || ANIMATION_DURATION.dflt) === ANIMATION_DURATION.dflt) return a.type;
  return { type: a.type, delayMs: a.delayMs || 0, durationMs: a.durationMs || ANIMATION_DURATION.dflt };
}

// ── plain words ───────────────────────────────────────────────────────
// A rough everyday name for a hex colour ("light green", "dark blue"), so
// nobody has to read a colour code.
export function colorWords(hex) {
  if (!isHexColor(hex)) return 'a color';
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l >= 0.94) return 'white';
  if (l <= 0.08) return 'black';
  if (s < 0.12) return l > 0.7 ? 'light gray' : l < 0.3 ? 'dark gray' : 'gray';
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  let name;
  if (h < 15 || h >= 345) name = 'red';
  else if (h < 40) name = (l < 0.4 ? 'brown' : 'orange');
  else if (h < 65) name = (l > 0.8 ? 'cream' : 'yellow');
  else if (h < 160) name = 'green';
  else if (h < 195) name = 'teal';
  else if (h < 250) name = 'blue';
  else if (h < 290) name = 'purple';
  else name = 'pink';
  const tone = l > 0.65 ? 'light ' : l < 0.3 ? 'dark ' : '';
  return name === 'cream' || name === 'brown' ? name : `${tone}${name}`;
}

export function backgroundWords(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'the template color';
  const sw = BG_SWATCHES.find((x) => x.v && x.v.toLowerCase() === s.toLowerCase());
  if (sw) return sw.label;
  if (isHexColor(s)) return `a custom color (${colorWords(s)})`;
  return 'a background the editor no longer offers (it is not shown)';
}
export function headlineWords(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'plain';
  const sw = HEADLINE_SWATCHES.find((x) => x.v && x.v.toLowerCase() === s.toLowerCase());
  return sw ? sw.label : 'plain (the stored effect is not one the editor offers)';
}
export function spacingWords(v) {
  const p = safePadding(v);
  return (SPACING_OPTIONS.find((o) => o.stored === (p && p !== 'normal' ? p : undefined)) || SPACING_OPTIONS[1]).label;
}
export function showOnWords(style) {
  const d = !style?.hideOnDesktop; const m = !style?.hideOnMobile;
  if (d && m) return 'computers and phones';
  if (d) return 'computers only (hidden on phones)';
  if (m) return 'phones only (hidden on computers)';
  return 'neither computers nor phones (hidden everywhere)';
}
const secs = (ms) => `${Math.round((Number(ms) || 0) / 10) / 100} s`;
export function animationWords(animate) {
  const a = normalizeAnimate(animate);
  if (!a) return 'just appears (no animation)';
  return `${ANIMATIONS[a.type].label} (waits ${secs(a.delayMs)}, takes ${secs(a.durationMs)})`;
}

// Everything about a section's look, in plain words (get_website).
export function describeSectionStyle(section) {
  const st = section?.style && typeof section.style === 'object' ? section.style : {};
  const out = {
    background: backgroundWords(st.background),
    spaceAboveAndBelow: spacingWords(st.padding),
    textAlignment: (TEXT_ALIGN_OPTIONS.find((o) => o.stored === (safeTextAlign(st.textAlign) || undefined)) || TEXT_ALIGN_OPTIONS[0]).label,
    showsOn: showOnWords(st),
    headlineColorEffect: headlineWords(st.headlineGradient),
    photoMovesSlowerThanPage: st.parallax ? 'on' : 'off',
    appearsWhenScrolledIntoView: animationWords(section?.animate),
  };
  if (isHexColor(st.background) && !BG_SWATCHES.some((x) => x.v.toLowerCase() === String(st.background).toLowerCase())) {
    out.backgroundCode = String(st.background).toLowerCase();
  }
  return out;
}

// The same, as one short sentence.
export function styleSentence(section) {
  const d = describeSectionStyle(section);
  return `background ${d.background}; space above and below ${d.spaceAboveAndBelow}; text alignment ${d.textAlignment}; shows on ${d.showsOn}; headline color effect ${d.headlineColorEffect}; photo moves slower than the page ${d.photoMovesSlowerThanPage}; ${d.appearsWhenScrolledIntoView}`;
}

// The colour choices of the editor's "Section style" panel and the checks
// every renderer runs before painting one. No imports, so the Ivy approval
// card can use it without pulling in the whole section catalog. The rest
// of the style rules live in sectionStyle.js, which re-exports these.
export const BG_SWATCHES = [
  { id: 'template',          v: '', label: 'Use the template color' },
  { id: 'white',             v: '#FFFFFF', label: 'White' },
  { id: 'near_black',        v: '#0D0E0C', label: 'Near black' },
  { id: 'warm_cream',        v: '#F5F1EA', label: 'Warm cream' },
  { id: 'sage_green',        v: '#5B7C5F', label: 'Sage green' },
  { id: 'sunset_blend',      v: 'linear-gradient(135deg,#E5572B,#F2D2BC)', label: 'Sunset blend' },
  { id: 'deep_forest_blend', v: 'linear-gradient(180deg,#15201A,#1F2B23)', label: 'Deep forest blend' },
];
export const HEADLINE_SWATCHES = [
  { id: 'plain',          v: '', label: 'Plain (template color)' },
  { id: 'pink_to_violet', v: 'linear-gradient(90deg,#F472B6,#A78BFA)', label: 'Pink to violet' },
  { id: 'orange_to_rose', v: 'linear-gradient(90deg,#FB923C,#F43F5E)', label: 'Orange to rose' },
  { id: 'teal_to_blue',   v: 'linear-gradient(90deg,#2DD4BF,#3B82F6)', label: 'Teal to blue' },
  { id: 'gold',           v: 'linear-gradient(90deg,#FACC15,#EAB308)', label: 'Gold' },
];

const HEX6 = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v) => HEX6.test(String(v ?? ''));

// A background the renderers apply: a 6-digit hex colour, or exactly one
// of the editor's blend swatches. Anything else renders as no override.
const BG_GRADIENTS = new Set(BG_SWATCHES.filter((s) => s.v.startsWith('linear-gradient')).map((s) => s.v.toLowerCase()));
const HEADLINE_GRADIENTS = new Set(HEADLINE_SWATCHES.filter((s) => s.v).map((s) => s.v.toLowerCase()));
export function safeBackground(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (HEX6.test(s)) return s;
  return BG_GRADIENTS.has(s.toLowerCase()) ? s : '';
}
export function safeHeadlineGradient(v) {
  const s = String(v ?? '').trim();
  return s && HEADLINE_GRADIENTS.has(s.toLowerCase()) ? s : '';
}

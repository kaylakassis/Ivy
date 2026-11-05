// The field palette shared by the PDF editor, the written-document
// editor, the preview and the signing page. Must match the server's
// VALID_FIELD_TYPES (api/_lib/documents.js).
//
// Default sizes are fractions of the page (w of width, h of height) so a
// freshly dropped box looks right on a Letter page at any zoom.
export const FIELD_TYPES = [
  { id: 'signature', label: 'Signature',   short: 'Sign',     icon: 'Edit',     w: 0.28, h: 0.055, hint: 'Their signature' },
  { id: 'initial',   label: 'Initials',    short: 'Initial',  icon: 'Edit',     w: 0.09, h: 0.045, hint: 'Their initials' },
  { id: 'date',      label: 'Date signed', short: 'Date',     icon: 'Calendar', w: 0.17, h: 0.032, hint: 'Filled in automatically when they sign' },
  { id: 'name',      label: 'Full name',   short: 'Name',     icon: 'Users',    w: 0.28, h: 0.032, hint: 'Their full name' },
  { id: 'email',     label: 'Email',       short: 'Email',    icon: 'Mail',     w: 0.30, h: 0.032, hint: 'Filled in with their email' },
  { id: 'company',   label: 'Company',     short: 'Company',  icon: 'Home',     w: 0.28, h: 0.032, hint: 'Their company name' },
  { id: 'title',     label: 'Title',       short: 'Title',    icon: 'Star',     w: 0.24, h: 0.032, hint: 'Their job title' },
  { id: 'text',      label: 'Text',        short: 'Text',     icon: 'Doc',      w: 0.30, h: 0.032, hint: 'Any answer you ask for' },
  { id: 'checkbox',  label: 'Checkbox',    short: 'Check',    icon: 'Check',    w: 0.03, h: 0.024, hint: 'A box they tick' },
  { id: 'dropdown',  label: 'Dropdown',    short: 'Choice',   icon: 'ArrowDown', w: 0.24, h: 0.032, hint: 'They pick one of your choices' },
];

export const FIELD_META = Object.fromEntries(FIELD_TYPES.map((t) => [t.id, t]));

export function fieldLabel(f) {
  if (!f) return 'Field';
  return f.label || FIELD_META[f.type]?.label || 'Field';
}

// One color per signer so the owner can see who fills what.
export const SIGNER_COLORS = [
  '#2C7BE5', '#B4472E', '#1F8A4C', '#B97A07', '#6E3FB6',
  '#0D6E6E', '#A02E63', '#3B5998', '#7A6B22', '#5C5C5C',
];
export const signerColor = (i) => SIGNER_COLORS[(i || 0) % SIGNER_COLORS.length];

export function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

// "MC" from "Mia Client".
export function initialsOf(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 3).join('').toUpperCase();
}

// Invoice design catalog, shared by the browser (document renderer, design
// editor) and the server (validation, email font stacks). Pure data.

// Fonts an owner can pick for invoices. `css` is the web stack, `google` the
// Google Fonts family to load for it, `email` a safe stack for mail clients
// (most never load web fonts, so each maps to a matching system family).
export const INVOICE_FONTS = {
  system:     { label: 'Clean',          sample: 'Modern and neutral',   css: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", google: null, email: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  inter:      { label: 'Inter',          sample: 'Crisp and contemporary', css: "'Inter', -apple-system, sans-serif", google: 'Inter:wght@400;500;600;700', email: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  dm_sans:    { label: 'DM Sans',        sample: 'Friendly geometric',   css: "'DM Sans', -apple-system, sans-serif", google: 'DM+Sans:wght@400;500;700', email: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  montserrat: { label: 'Montserrat',     sample: 'Bold and confident',   css: "'Montserrat', -apple-system, sans-serif", google: 'Montserrat:wght@400;500;600;700', email: "'Trebuchet MS', Helvetica, Arial, sans-serif" },
  fraunces:   { label: 'Fraunces',       sample: 'Warm classic serif',   css: "'Fraunces', Georgia, serif", google: 'Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600', email: "Georgia, 'Times New Roman', serif" },
  playfair:   { label: 'Playfair',       sample: 'Elegant and editorial', css: "'Playfair Display', Georgia, serif", google: 'Playfair+Display:wght@400;500;600;700', email: "Georgia, 'Times New Roman', serif" },
  lora:       { label: 'Lora',           sample: 'Soft readable serif',  css: "'Lora', Georgia, serif", google: 'Lora:ital,wght@0,400;0,500;0,700;1,400', email: "Georgia, 'Times New Roman', serif" },
  cormorant:  { label: 'Cormorant',      sample: 'Refined and light',    css: "'Cormorant Garamond', Georgia, serif", google: 'Cormorant+Garamond:wght@400;500;700', email: "Garamond, Georgia, serif" },
};

// How the invoice is laid out.
export const INVOICE_LAYOUTS = {
  classic: { label: 'Classic', hint: 'Logo and details up top, a colored rule under the header' },
  bold:    { label: 'Bold',    hint: 'A full-width band in your color with your logo and the invoice number' },
  minimal: { label: 'Minimal', hint: 'Plenty of white space, thin lines, color only on the total' },
};

export const DEFAULT_DESIGN = { font: 'system', layout: 'classic', accentColor: '#2E3168', footer: 'Thank you for your business.', contact: '' };

export function isInvoiceFont(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(INVOICE_FONTS, k); }
export function isInvoiceLayout(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(INVOICE_LAYOUTS, k); }

export function fontCss(key) { return (INVOICE_FONTS[key] || INVOICE_FONTS.system).css; }
export function fontEmailStack(key) { return (INVOICE_FONTS[key] || INVOICE_FONTS.system).email; }

// Load the Google family for a font once (browser only). No-op for system.
const loaded = new Set();
export function loadInvoiceFont(key) {
  if (typeof document === 'undefined') return;
  const f = INVOICE_FONTS[key];
  if (!f?.google || loaded.has(key)) return;
  loaded.add(key);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
  document.head.appendChild(l);
}

// Black or white text for a given background hex, by relative luminance.
export function inkFor(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#ffffff';
  let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#111111' : '#ffffff';
}

// A realistic sample invoice for the design editor's live preview.
export const SAMPLE_INVOICE = {
  number: 'INV-1042', status: 'sent',
  issueDate: new Date().toISOString().slice(0, 10),
  dueDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  clientName: 'Casey Roberts', clientEmail: 'casey@example.com',
  items: [
    { description: 'Strategy session (60 min)', quantity: 1, rate: 150 },
    { description: 'Follow-up plan and notes', quantity: 1, rate: 75 },
    { description: 'Travel', quantity: 2, rate: 12.5 },
  ],
  taxRate: 0, discount: 0, subtotal: 250, tax: 0, total: 250, paidAmount: 0,
  notes: 'Payment is due within 14 days. Thanks so much for working with me.',
};

// Copies the web fonts Ivy uses into public/fonts/g/ so every page loads
// them from Ivy's own server and nothing is requested from Google.
//
// Why: a font request to a third party hands that party each visitor's IP
// address before they have agreed to anything. Hosting the files ourselves
// removes the request (and works offline inside the iPhone app).
//
// The fonts are the same open-licensed families as before (SIL Open Font
// License or Apache 2.0); each family's license is copied alongside it.
//
// To repeat (only when the font list changes):
//   mkdir /tmp/fonts && cd /tmp/fonts && npm init -y
//   npm install @fontsource-variable/<slug> ...   (variable families)
//   npm install @fontsource/<slug> ...            (static families)
//   node <repo>/scripts/fonts/vendor-fonts.mjs /tmp/fonts/node_modules
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NM = process.argv[2];
if (!NM || !fs.existsSync(NM)) { console.error('usage: vendor-fonts.mjs <node_modules with @fontsource packages>'); process.exit(1); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'public', 'fonts', 'g');
const SUBSETS = ['latin', 'latin-ext'];

// name: the font-family the CSS in the app asks for. v: variable package.
// weights/italics only matter for static packages.
export const FAMILIES = [
  { name: 'Inter', slug: 'inter', v: true },
  { name: 'Fraunces', slug: 'fraunces', v: true },
  { name: 'Space Grotesk', slug: 'space-grotesk', v: true },
  { name: 'Playfair Display', slug: 'playfair-display', v: true },
  { name: 'Lato', slug: 'lato', weights: [400, 700] },
  { name: 'DM Serif Display', slug: 'dm-serif-display', weights: [400] },
  { name: 'DM Sans', slug: 'dm-sans', v: true },
  { name: 'Bodoni Moda', slug: 'bodoni-moda', v: true },
  { name: 'Montserrat', slug: 'montserrat', v: true },
  { name: 'Cormorant Garamond', slug: 'cormorant-garamond', v: true },
  { name: 'Open Sans', slug: 'open-sans', v: true },
  { name: 'Archivo Black', slug: 'archivo-black', weights: [400] },
  { name: 'Archivo', slug: 'archivo', v: true },
  { name: 'Abril Fatface', slug: 'abril-fatface', weights: [400] },
  { name: 'IBM Plex Mono', slug: 'ibm-plex-mono', weights: [400] },
  { name: 'IBM Plex Sans', slug: 'ibm-plex-sans', v: true },
  { name: 'Oswald', slug: 'oswald', v: true },
  { name: 'Lora', slug: 'lora', v: true, italic: true },
  { name: 'Spectral', slug: 'spectral', weights: [400, 500, 700] },
  { name: 'Jost', slug: 'jost', v: true },
  { name: 'Marcellus', slug: 'marcellus', weights: [400] },
  { name: 'Nunito', slug: 'nunito', v: true },
  { name: 'Bebas Neue', slug: 'bebas-neue', weights: [400] },
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });

// One package CSS file -> the @font-face blocks for our subsets, pointing at /fonts/g/.
function blocks(pkgDir, cssFile, family) {
  const file = path.join(pkgDir, cssFile);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const css = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const url = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(body);
    if (!url) continue;
    const fname = url[1];
    const subset = SUBSETS.find((s) => new RegExp(`^${family.slug}-${s}-(?!ext)`).test(fname) || (s === 'latin-ext' && fname.startsWith(`${family.slug}-latin-ext-`)));
    if (!subset || (subset === 'latin' && fname.startsWith(`${family.slug}-latin-ext-`))) continue;
    fs.copyFileSync(path.join(pkgDir, 'files', fname), path.join(OUT, fname));
    const get = (prop) => (new RegExp(`${prop}:\\s*([^;]+);`).exec(body) || [])[1];
    out.push([
      '@font-face{',
      `font-family:'${family.name}';`,
      `font-style:${get('font-style') || 'normal'};`,
      'font-display:swap;',
      `font-weight:${get('font-weight') || '400'};`,
      get('font-stretch') ? `font-stretch:${get('font-stretch')};` : '',
      `src:url(/fonts/g/${fname}) format('${family.v ? 'woff2-variations' : 'woff2'}');`,
      get('unicode-range') ? `unicode-range:${get('unicode-range')};` : '',
      '}',
    ].join(''));
  }
  if (!out.length) throw new Error(`no latin faces in ${file}`);
  return out;
}

const perFamily = {};
let files = 0;
for (const f of FAMILIES) {
  const pkgDir = path.join(NM, f.v ? '@fontsource-variable' : '@fontsource', f.slug);
  if (!fs.existsSync(pkgDir)) throw new Error(`package not installed: ${pkgDir}`);
  const cssFiles = f.v
    ? ['wght.css', ...(f.italic ? ['wght-italic.css'] : [])]
    : f.weights.map((w) => `${w}.css`);
  perFamily[f.name] = cssFiles.flatMap((c) => blocks(pkgDir, c, f));
  files += perFamily[f.name].length;
  fs.copyFileSync(path.join(pkgDir, 'LICENSE'), path.join(OUT, 'licenses', `${f.slug}.txt`));
}

const head = (what) => `/* ${what} Served from Ivy's own server: no request to a third party.\n   Generated by scripts/fonts/vendor-fonts.mjs. Licenses: /fonts/g/licenses/ */\n`;
fs.writeFileSync(path.join(ROOT, 'public', 'fonts', 'inter.css'), head('Inter, the font of the Ivy site and app.') + perFamily.Inter.join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'public', 'fonts', 'families.css'),
  head('The font choices for customer websites and invoices. A browser only downloads the families a page uses.') + Object.values(perFamily).flat().join('\n') + '\n');
const bytes = fs.readdirSync(OUT).filter((n) => n.endsWith('.woff2')).reduce((a, n) => a + fs.statSync(path.join(OUT, n)).size, 0);
console.log(`${FAMILIES.length} families, ${files} font files, ${(bytes / 1024).toFixed(0)} KB`);

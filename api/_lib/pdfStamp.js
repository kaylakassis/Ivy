// Server-side PDF stamping. Called when the last signer completes a doc
// whose kind === 'pdf' and file_url is set. We:
//   1. Fetch the original PDF bytes from Blob.
//   2. For every field placed by the owner, draw the signer's submitted
//      value at the (page, x, y, w, h) coordinates the editor recorded.
//      - signature → embedded PNG of the canvas drawing
//      - text / initial / date → drawText with a serviceable font fit
//   3. Append a final page summarizing every signer (name, email,
//      signed_at, IP) plus the document's tamper-evident SHA-256 hash.
//   4. Save and return the bytes - the caller uploads them to Blob and
//      stamps `documents.final_pdf_url` so the owner + every signer can
//      download the flattened, legally-binding artifact.
//
// Coordinates: the editor stores fields with x/y/w/h as 0..1 fractions
// of the rendered page size in the BROWSER (top-left origin). pdf-lib
// uses bottom-left points. We flip Y here.
//
// Failures are surfaced (caller logs + falls back to no final PDF)
// rather than blocking completion - the canonical record is still the
// document_signers rows + completion_hash.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { put } from '@vercel/blob';

const SIG_TEXT_FALLBACK_FONT_SIZE = 14;

export async function stampCompletedPdf({ pdfUrl, fields, signers, doc, hash }) {
  if (!pdfUrl) return null;
  const buf = await fetch(pdfUrl).then((r) => {
    if (!r.ok) throw new Error(`fetch original PDF failed: ${r.status}`);
    return r.arrayBuffer();
  });
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = pdf.getPages();

  // Build a lookup: fieldId → { signedValue, signer }. The latest
  // (highest order_index) signer to touch a field wins, mirroring how
  // the UI shows it.
  const valueByField = new Map();
  for (const s of signers) {
    for (const fv of (s.field_values || [])) {
      // Skip empty values so a later signer's blank can't clobber an
      // earlier signer's real value (keeps the flattened PDF consistent
      // with the completion_hash, which is computed from non-empty values).
      if (fv.value) valueByField.set(fv.id, { value: fv.value, signer: s });
    }
  }

  for (const f of fields || []) {
    const meta = valueByField.get(f.id);
    if (!meta || !meta.value) continue;
    const pageIdx = Number.isInteger(f.page) ? f.page : 0;
    const page = pages[pageIdx] || pages[0];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();

    // Coordinates: editor stored top-left origin, 0..1 fractions.
    const x  = clamp01(f.x ?? 0) * pw;
    const yT = clamp01(f.y ?? 0) * ph;
    const w  = clamp01(f.w ?? 0.2) * pw;
    const h  = clamp01(f.h ?? 0.04) * ph;
    // pdf-lib origin is bottom-left.
    const y  = ph - yT - h;

    if (f.type === 'signature') {
      const png = decodeSignaturePng(meta.value);
      if (png) {
        try {
          const img = await pdf.embedPng(png);
          const ratio = Math.min(w / img.width, h / img.height);
          const drawW = img.width * ratio;
          const drawH = img.height * ratio;
          page.drawImage(img, {
            x: x + (w - drawW) / 2,
            y: y + (h - drawH) / 2,
            width: drawW,
            height: drawH,
          });
          continue;
        } catch {
          // fall through
        }
      }
      // Typed signature: SignaturePad emits the raw string. Render the
      // value (or fall back to the signer's name) in bold so it visually
      // reads as a "signed" mark.
      const txt = (typeof meta.value === 'string' && meta.value && !meta.value.startsWith('data:'))
        ? meta.value
        : (meta.signer.name || '');
      drawFitText(page, txt, x, y, w, h, helvBold, rgb(0.05, 0.07, 0.12));
      continue;
    }

    if (f.type === 'date' || f.type === 'text' || f.type === 'initial') {
      drawFitText(page, String(meta.value), x, y, w, h, helv, rgb(0.05, 0.07, 0.12));
    }
  }

  drawAuditPages(pdf, { doc, signers, hash, helv, helvBold });

  const bytes = await pdf.save();
  return bytes;
}

// Upload stamped bytes to Blob and return { url, pathname } so the
// caller can persist them on the document row.
export async function uploadStampedPdf({ workspaceId, docId, bytes }) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN missing');
  }
  const safeId = String(docId).replace(/[^a-z0-9-]/gi, '');
  const pathname = `${workspaceId}/documents/${safeId}-signed.pdf`;
  const result = await put(pathname, bytes, {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'application/pdf',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: result.url, pathname: result.pathname };
}

// ─── helpers ──────────────────────────────────────────────────────────

// SignaturePad emits a `data:image/png;base64,...` URL. We strip the
// prefix and convert to a Uint8Array so pdf-lib can embed it. Returns
// null if the value isn't a PNG data URL.
function decodeSignaturePng(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) return null;
  const b64 = value.slice('data:image/png;base64,'.length);
  try {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

// Pick a font size that fits the box height-wise; trim with an ellipsis
// if the rendered width still overflows.
function drawFitText(page, text, x, y, w, h, font, color) {
  let size = Math.min(h * 0.7, 22);
  if (size < 6) size = 6;
  let display = text;
  let measured = font.widthOfTextAtSize(display, size);
  if (measured > w) {
    // Shrink first, then ellipsize.
    while (size > 7 && measured > w) {
      size -= 1;
      measured = font.widthOfTextAtSize(display, size);
    }
    while (display.length > 1 && measured > w) {
      display = display.slice(0, -2) + '…';
      measured = font.widthOfTextAtSize(display, size);
    }
  }
  page.drawText(display, {
    x: x + 4,
    y: y + (h - size) / 2 + size * 0.18,
    size: size || SIG_TEXT_FALLBACK_FONT_SIZE,
    font,
    color,
  });
}

function clamp01(n) {
  if (!Number.isFinite(Number(n))) return 0;
  const v = Number(n);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatTs(ts) {
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return String(ts);
  }
}

// The signing record: one page (or more, for many signers) listing every
// signer with time, IP and user agent, plus the tamper-evident hash.
// Shared by the uploaded-PDF and written-document renderers.
function drawAuditPages(pdf, { doc, signers, hash, helv, helvBold }) {
  let current = pdf.addPage();
  const { width: aw, height: ah } = current.getSize();
  const margin = 56;
  let cy = ah - margin;
  current.drawText('Signing record', { x: margin, y: cy, size: 22, font: helvBold, color: rgb(0.05, 0.07, 0.12) });
  cy -= 30;
  current.drawText(doc.name || 'Document', { x: margin, y: cy, size: 12, font: helv, color: rgb(0.30, 0.30, 0.32) });
  cy -= 28;
  current.drawLine({ start: { x: margin, y: cy }, end: { x: aw - margin, y: cy }, thickness: 0.5, color: rgb(0.7, 0.7, 0.72) });
  cy -= 22;

  for (const s of signers) {
    if (cy < 140) {
      // Spill onto another page if we run out of room (rare unless 8+ signers).
      current.drawText('- continued on next page -', { x: margin, y: 30, size: 9, font: helv, color: rgb(0.5, 0.5, 0.5) });
      current = pdf.addPage();
      cy = current.getSize().height - margin;
    }
    current.drawText(`${s.order_index + 1}. ${s.name}`, { x: margin, y: cy, size: 13, font: helvBold, color: rgb(0.05, 0.07, 0.12) });
    cy -= 16;
    const lines = [
      s.email,
      s.signed_at ? `Signed at ${formatTs(s.signed_at)}` : (s.declined_at ? `Declined at ${formatTs(s.declined_at)}` : '-'),
      s.ip ? `IP ${s.ip}` : null,
      s.user_agent ? truncate(`UA ${s.user_agent}`, 90) : null,
      s.decline_reason ? truncate(`Reason: ${s.decline_reason}`, 90) : null,
    ].filter(Boolean);
    for (const line of lines) {
      current.drawText(line, { x: margin + 14, y: cy, size: 10, font: helv, color: rgb(0.30, 0.30, 0.32) });
      cy -= 13;
    }
    cy -= 12;
  }

  if (hash) {
    // The hash block needs ~70px; spill if it won't fit on the current page.
    if (cy < 90) {
      current = pdf.addPage();
      cy = current.getSize().height - margin;
    }
    cy -= 8;
    current.drawLine({ start: { x: margin, y: cy }, end: { x: aw - margin, y: cy }, thickness: 0.5, color: rgb(0.7, 0.7, 0.72) });
    cy -= 18;
    current.drawText('Tamper-evident hash (SHA-256)', { x: margin, y: cy, size: 10, font: helvBold, color: rgb(0.30, 0.30, 0.32) });
    cy -= 14;
    // Wrap the hash so it always fits.
    const half = Math.ceil(hash.length / 2);
    current.drawText(hash.slice(0, half), { x: margin, y: cy, size: 9, font: helv, color: rgb(0.05, 0.07, 0.12) });
    cy -= 12;
    current.drawText(hash.slice(half),    { x: margin, y: cy, size: 9, font: helv, color: rgb(0.05, 0.07, 0.12) });
  }

}

// ─── Written documents ────────────────────────────────────────────────
// A written (template or typed) document has no PDF to stamp, so build
// one: the body laid out on Letter pages, a Signatures section showing
// every signer's fields (drawn signature image or typed name, dates,
// initials, text answers), then the same signing record as above.
// Handles the tags the editor allows - h1-h3, p, br, strong, em, ul, ol,
// li - and ignores anything else, matching the sanitizer on the sign page.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 56;
const BODY_SIZE = 11, BODY_LEAD = 15;

export async function renderWrittenPdf({ doc, fields, signers, hash, business }) {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const ink = rgb(0.08, 0.09, 0.1);
  const muted = rgb(0.38, 0.38, 0.4);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const width = PAGE_W - MARGIN * 2;
  const ensure = (need) => {
    if (y - need < MARGIN) { page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
  };
  const writeLines = (text, { font = helv, size = BODY_SIZE, lead = BODY_LEAD, color = ink, indent = 0, hang = '' } = {}) => {
    const lines = wrap(clean(text), font, size, width - indent - (hang ? 16 : 0));
    lines.forEach((line, i) => {
      ensure(lead);
      if (i === 0 && hang) page.drawText(hang, { x: MARGIN + indent, y, size, font, color });
      page.drawText(line, { x: MARGIN + indent + (hang ? 16 : 0), y, size, font, color });
      y -= lead;
    });
  };

  // Title block.
  writeLines(doc.name || 'Document', { font: helvBold, size: 18, lead: 24 });
  const metaBits = [];
  if (business) metaBits.push(`Prepared by ${business}`);
  if (doc.completed_at) metaBits.push(`Completed ${formatTs(doc.completed_at)}`);
  if (metaBits.length) writeLines(metaBits.join('  ·  '), { size: 9.5, lead: 13, color: muted });
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.75, 0.75, 0.77) });
  y -= 18;

  // Body.
  const blocks = htmlToBlocks(doc.content_html || '');
  for (const b of blocks) {
    if (b.type === 'h1') { y -= 6; writeLines(b.text, { font: helvBold, size: 16, lead: 21 }); y -= 4; }
    else if (b.type === 'h2') { y -= 4; writeLines(b.text, { font: helvBold, size: 13.5, lead: 18 }); y -= 3; }
    else if (b.type === 'h3') { y -= 2; writeLines(b.text, { font: helvBold, size: 12, lead: 16 }); y -= 2; }
    else if (b.type === 'li') { writeLines(b.text, { indent: 10, hang: b.ordered ? `${b.index}.` : '•' }); y -= 2; }
    else if (b.type === 'p') { writeLines(b.text, { font: b.bold ? helvBold : helv }); y -= 7; }
  }

  // Signatures.
  y -= 10; ensure(60);
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.75, 0.75, 0.77) });
  y -= 22;
  writeLines('Signatures', { font: helvBold, size: 14, lead: 20 });
  y -= 4;
  const byField = new Map();
  for (const s of signers) for (const fv of (s.field_values || [])) if (fv.value) byField.set(fv.id, fv.value);
  for (const s of signers) {
    const idx = Number.isInteger(s.order_index) ? s.order_index : 0;
    const mine = (fields || []).filter((f) => (Number.isInteger(f.signerIndex) ? f.signerIndex : 0) === idx);
    ensure(40);
    writeLines(`${signers.length > 1 ? `${idx + 1}. ` : ''}${s.name || 'Signer'}${s.email ? `  ·  ${s.email}` : ''}`, { font: helvBold, size: 11, lead: 16 });
    for (const f of mine) {
      const value = byField.get(f.id) ?? f.value ?? '';
      const label = f.label || f.type;
      if (f.type === 'signature') {
        ensure(74);
        page.drawText(clean(label), { x: MARGIN + 10, y, size: 9, font: helv, color: muted });
        y -= 6;
        const png = decodeSignaturePng(value);
        let drawn = false;
        if (png) {
          try {
            const img = await pdf.embedPng(png);
            const ratio = Math.min(220 / img.width, 56 / img.height);
            const w = img.width * ratio, h = img.height * ratio;
            page.drawImage(img, { x: MARGIN + 10, y: y - h, width: w, height: h });
            y -= h;
            drawn = true;
          } catch { /* fall back to text */ }
        }
        if (!drawn) {
          const txt = (typeof value === 'string' && value && !value.startsWith('data:')) ? value : (s.name || '');
          y -= 18;
          page.drawText(clean(txt), { x: MARGIN + 10, y, size: 18, font: helvOblique, color: ink });
        }
        y -= 4;
        page.drawLine({ start: { x: MARGIN + 10, y }, end: { x: MARGIN + 240, y }, thickness: 0.6, color: rgb(0.5, 0.5, 0.52) });
        y -= 14;
      } else {
        ensure(16);
        const line = `${label}: ${String(value || '')}`;
        writeLines(line, { indent: 10, size: 10.5, lead: 15 });
      }
    }
    const when = s.signed_at ? `Signed ${formatTs(s.signed_at)}` : null;
    const stamp = [when, s.ip ? `IP ${s.ip}` : null].filter(Boolean).join('  ·  ');
    if (stamp) writeLines(stamp, { indent: 10, size: 9, lead: 13, color: muted });
    y -= 10;
  }

  drawAuditPages(pdf, { doc, signers, hash, helv, helvBold });
  return pdf.save();
}

// Word-wrap `text` to `maxWidth` points at `size`, breaking on spaces and
// hard-breaking any single word wider than a line.
function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (let w of words) {
      while (font.widthOfTextAtSize(w, size) > maxWidth) {
        // Hard-break an overlong token.
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) line = trial;
      else { if (line) out.push(line); line = w; }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// Helvetica in pdf-lib is WinAnsi: keep Latin-1 plus the common typographic
// punctuation, drop anything else (emoji, CJK) rather than throw mid-render.
function clean(s) {
  return decodeEntities(String(s ?? ''))
    .replace(/[\u2010-\u2012]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\u2122]/g, '')
    .replace(/[ \t]+/g, ' ');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Turn the editor's HTML into flat blocks. Same whitelist as the sign page.
function htmlToBlocks(html) {
  const blocks = [];
  const src = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?!\/?(?:h[1-3]|p|strong|b|em|i|ul|ol|li|div)\b)[^>]+>/gi, '');
  const re = /<(h[1-3]|p|li|div)\b[^>]*>([\s\S]*?)<\/\1>|<(ol|ul)\b[^>]*>|<\/(ol|ul)>/gi;
  const listStack = [];
  let m; let last = 0;
  const pushLoose = (chunk) => {
    const text = chunk.replace(/<[^>]+>/g, '').trim();
    if (text) blocks.push({ type: 'p', text });
  };
  while ((m = re.exec(src))) {
    pushLoose(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[3]) { listStack.push({ ordered: m[3].toLowerCase() === 'ol', n: 0 }); continue; }
    if (m[4]) { listStack.pop(); continue; }
    const tag = m[1].toLowerCase();
    const inner = m[2];
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    if (tag === 'li') {
      const l = listStack[listStack.length - 1] || { ordered: false, n: 0 };
      l.n += 1;
      blocks.push({ type: 'li', text, ordered: l.ordered, index: l.n });
    } else if (tag === 'p' || tag === 'div') {
      const bold = /^\s*<(strong|b)\b[^>]*>[\s\S]*<\/(strong|b)>\s*$/i.test(inner);
      blocks.push({ type: 'p', text, bold });
    } else {
      blocks.push({ type: tag, text });
    }
  }
  pushLoose(src.slice(last));
  return blocks;
}

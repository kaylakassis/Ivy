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
      valueByField.set(fv.id, { value: fv.value || '', signer: s });
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

  // Audit page. `current` advances to each spill page so overflow entries
  // are drawn on the page we actually added (not the original one).
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

// Server-side PDF stamping. Called when the last signer completes a doc
// whose kind === 'pdf' and file_url is set. We:
//   1. Fetch the original PDF bytes from Blob (platform host only).
//   2. For every field placed by the owner, draw the signer's submitted
//      value at the page + position the editor recorded:
//        signature / initials → the drawn PNG, or the typed text
//        checkbox             → a check mark
//        everything else      → the text, shrunk to fit the box
//   3. Append a certificate of completion: the document, the original
//      file's SHA-256, every signer (email, role, viewed / agreed /
//      signed times, IP, device), the event log, and the completion hash.
//   4. Save and return the bytes. The caller uploads them and records
//      the signed file's own SHA-256 on the document row.
//
// Coordinates: the editor stores x/y/w/h as 0..1 fractions of the page AS
// DISPLAYED (pdf.js shows the crop box, turned by the page's /Rotate),
// top-left origin. mapPage() turns those back into PDF user space for the
// real page, so a field lands in the same spot on rotated pages and on
// pages whose crop box doesn't start at 0,0. Text and images are rotated
// with the page so they read upright for the viewer.
//
// Failures are surfaced (caller logs + falls back to no final PDF)
// rather than blocking completion - the canonical record is still the
// document_signers rows + completion_hash.
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { put } from '@vercel/blob';
import { assertPlatformBlobUrl } from './safeUrl.js';
import { uploadPrefix } from './blobScope.js';

const INK = rgb(0.05, 0.07, 0.12);
const MUTED = rgb(0.30, 0.30, 0.32);

export async function stampCompletedPdf({ pdfUrl, pdfBytes, fields, signers, doc, hash, business }) {
  let buf = pdfBytes || null;
  if (!buf) {
    if (!pdfUrl) return null;
    // Only ever fetch from the platform blob store: file_url is owner-supplied
    // and this runs server side, so an arbitrary host would be an SSRF hole.
    const safePdfUrl = assertPlatformBlobUrl(pdfUrl, { what: 'PDF URL' });
    buf = await fetch(safePdfUrl).then((r) => {
      if (!r.ok) throw new Error(`fetch original PDF failed: ${r.status}`);
      return r.arrayBuffer();
    });
  }
  const sourceBytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const pdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false });
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = pdf.getPages();
  const originalPageCount = pages.length;

  // fieldId → { value, signer }. Only non-empty values, so a later
  // signer's blank can't clobber an earlier signer's real value.
  const valueByField = new Map();
  for (const s of signers) {
    for (const fv of (s.field_values || [])) {
      if (fv && fv.value) valueByField.set(fv.id, { value: fv.value, signer: s });
    }
  }

  for (const f of fields || []) {
    const meta = valueByField.get(f.id);
    if (!meta || !meta.value) continue;
    const pageIdx = Number.isInteger(f.page) ? f.page : 0;
    // A field on a page this PDF doesn't have is skipped, never moved to
    // page 1 where it would land on the wrong text.
    const page = pages[pageIdx];
    if (!page) continue;
    const m = mapPage(page);
    const rect = {
      x: clamp01(f.x ?? 0) * m.dispW,
      y: clamp01(f.y ?? 0) * m.dispH,
      w: clamp01(f.w ?? 0.2) * m.dispW,
      h: clamp01(f.h ?? 0.04) * m.dispH,
    };
    if (rect.w <= 0 || rect.h <= 0) continue;

    if (f.type === 'checkbox') {
      if (meta.value === 'true') drawCheck(page, m, rect);
      continue;
    }
    if (f.type === 'signature' || f.type === 'initial') {
      const png = decodeSignaturePng(meta.value);
      if (png) {
        try {
          const img = await pdf.embedPng(png);
          const ratio = Math.min(rect.w / img.width, rect.h / img.height);
          const dw = img.width * ratio;
          const dh = img.height * ratio;
          const dx = rect.x + (rect.w - dw) / 2;
          const dy = rect.y + (rect.h - dh) / 2;
          const [px, py] = m.toPdf(dx, dy + dh);
          page.drawImage(img, { x: px, y: py, width: dw, height: dh, rotate: degrees(m.rot) });
          continue;
        } catch {
          // fall through to text
        }
      }
      const txt = (typeof meta.value === 'string' && meta.value && !meta.value.startsWith('data:'))
        ? meta.value
        : (meta.signer.name || '');
      drawFitText(page, m, rect, txt, helvBold, f.type === 'initial');
      continue;
    }
    drawFitText(page, m, rect, String(meta.value), helv, false);
  }

  drawAuditPages(pdf, {
    doc, signers, hash, helv, helvBold, business,
    sourceHash, pageCount: originalPageCount,
  });

  const bytes = await pdf.save();
  return bytes;
}

// The page as pdf.js displays it: crop box, turned by /Rotate. Returns
// the displayed size and toPdf(dx, dy) mapping a displayed point
// (top-left origin) to PDF user space.
export function mapPage(page) {
  let box;
  try { box = page.getCropBox(); } catch { box = null; }
  if (!box || !(box.width > 0) || !(box.height > 0)) {
    const s = page.getSize();
    box = { x: 0, y: 0, width: s.width, height: s.height };
  }
  let rot = 0;
  try { rot = page.getRotation().angle || 0; } catch { rot = 0; }
  rot = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
  const { x: bx, y: by, width: W, height: H } = box;
  const dispW = rot % 180 === 0 ? W : H;
  const dispH = rot % 180 === 0 ? H : W;
  const toPdf = (dx, dy) => {
    switch (rot) {
      case 90:  return [bx + dy, by + dx];
      case 180: return [bx + W - dx, by + dy];
      case 270: return [bx + W - dy, by + H - dx];
      default:  return [bx + dx, by + H - dy];
    }
  };
  return { rot, dispW, dispH, toPdf };
}

function drawCheck(page, m, r) {
  const s = Math.min(r.w, r.h);
  const ox = r.x + (r.w - s) / 2;
  const oy = r.y + (r.h - s) / 2;
  const pts = [[0.18, 0.55], [0.42, 0.78], [0.84, 0.24]].map(([fx, fy]) => m.toPdf(ox + fx * s, oy + fy * s));
  const thickness = Math.max(1, s * 0.12);
  for (let i = 0; i < pts.length - 1; i++) {
    page.drawLine({
      start: { x: pts[i][0], y: pts[i][1] }, end: { x: pts[i + 1][0], y: pts[i + 1][1] },
      thickness, color: INK,
    });
  }
}

// Upload stamped bytes and return { url, pathname, private } so the
// caller can persist them on the document row. The pathname sits under
// the workspace's ws/<id>/ prefix (api/_lib/blobScope.js). A private
// blob store is used when the project has one; otherwise the file is
// public-but-unguessable (random suffix) and only ever reached through
// Ivy's signed, expiring links (api/documents/file.js).
let privateUnsupported = false;
export async function uploadStampedPdf({ workspaceId, docId, bytes }) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN missing');
  }
  const safeId = String(docId).replace(/[^a-z0-9-]/gi, '');
  let prefix;
  try { prefix = uploadPrefix(String(workspaceId)); } catch { prefix = `${String(workspaceId).replace(/[^a-z0-9-]/gi, '')}/`; }
  const pathname = `${prefix}documents/${safeId}-signed.pdf`;
  const opts = {
    addRandomSuffix: true,
    contentType: 'application/pdf',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  };
  if (!privateUnsupported) {
    try {
      const result = await put(pathname, bytes, { ...opts, access: 'private' });
      return { url: result.url, pathname: result.pathname, private: true };
    } catch {
      // A public store refuses private blobs. Remember that for this
      // instance so later completions don't pay for a failing request.
      privateUnsupported = true;
    }
  }
  const result = await put(pathname, bytes, { ...opts, access: 'public' });
  return { url: result.url, pathname: result.pathname, private: false };
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

// Draw `text` inside the displayed rect `r`: pick a size that fits the
// box height, shrink then ellipsize to fit the width, rotate with the page.
function drawFitText(page, m, r, text, font, centered) {
  let display = clean(text).replace(/\s+/g, ' ').trim();
  if (!display) return;
  let size = Math.min(r.h * 0.68, 22);
  if (size < 5) size = 5;
  const pad = Math.min(4, r.w * 0.05);
  const maxW = Math.max(1, r.w - pad * 2);
  let measured = font.widthOfTextAtSize(display, size);
  while (size > 6 && measured > maxW) {
    size -= 0.5;
    measured = font.widthOfTextAtSize(display, size);
  }
  while (display.length > 1 && measured > maxW) {
    display = display.slice(0, -2) + '…';
    measured = font.widthOfTextAtSize(display, size);
  }
  const dx = centered ? r.x + (r.w - measured) / 2 : r.x + pad;
  // Baseline: vertically centre the cap height in the box.
  const dy = r.y + r.h / 2 + size * 0.35;
  const [px, py] = m.toPdf(dx, dy);
  page.drawText(display, { x: px, y: py, size, font, color: INK, rotate: degrees(m.rot) });
}

function clamp01(n) {
  if (!Number.isFinite(Number(n))) return 0;
  const v = Number(n);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatTs(ts) {
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return '';
  }
}

// The certificate of completion. Shared by the uploaded-PDF and
// written-document renderers. Every string goes through clean() so a
// name or value in a script Helvetica can't encode never breaks the file.
function drawAuditPages(pdf, { doc, signers, hash, helv, helvBold, business, sourceHash, pageCount }) {
  const PW = 612, PH = 792, M = 56;
  let page = pdf.addPage([PW, PH]);
  let y = PH - M;
  const width = PW - M * 2;
  const ensure = (need) => {
    if (y - need < M) {
      page.drawText('Continued on next page', { x: M, y: 30, size: 8, font: helv, color: MUTED });
      page = pdf.addPage([PW, PH]);
      y = PH - M;
    }
  };
  const line = (text, { font = helv, size = 9.5, color = MUTED, indent = 0, lead = 12.5 } = {}) => {
    for (const l of wrap(clean(text), font, size, width - indent)) {
      ensure(lead);
      page.drawText(l, { x: M + indent, y, size, font, color });
      y -= lead;
    }
  };
  const rule = () => {
    ensure(16);
    y -= 4;
    page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.5, color: rgb(0.75, 0.75, 0.77) });
    y -= 14;
  };

  line('Certificate of completion', { font: helvBold, size: 20, color: INK, lead: 26 });
  line(doc.name || 'Document', { font: helvBold, size: 12, color: INK, lead: 16 });
  y -= 4;
  line(`Document ID: ${doc.id || ''}`);
  if (business) line(`Sent by: ${business}`);
  if (pageCount) line(`Pages in the original document: ${pageCount}`);
  if (doc.sent_at) line(`Sent: ${formatTs(doc.sent_at)}`);
  line(`Completed: ${formatTs(doc.completed_at || new Date())}`);
  if (sourceHash) {
    y -= 2;
    line('Original document fingerprint (SHA-256 of the uploaded file):', { font: helvBold });
    line(sourceHash, { color: INK, size: 8.5 });
  }
  rule();

  line('Signers', { font: helvBold, size: 13, color: INK, lead: 18 });
  for (const s of signers) {
    ensure(70);
    const role = s.is_owner ? 'Business' : 'Client';
    line(`${(s.order_index ?? 0) + 1}. ${s.name || 'Signer'} (${role})`, { font: helvBold, size: 11, color: INK, lead: 15 });
    const facts = [
      s.email ? `Email: ${s.email}` : null,
      s.viewed_at ? `Opened: ${formatTs(s.viewed_at)}` : null,
      s.consent_at ? `Agreed to sign electronically: ${formatTs(s.consent_at)}` : null,
      s.signed_at ? `Signed: ${formatTs(s.signed_at)}` : (s.declined_at ? `Declined: ${formatTs(s.declined_at)}` : null),
      s.ip ? `IP address: ${s.ip}` : null,
      s.user_agent ? `Device: ${String(s.user_agent).slice(0, 220)}` : null,
      s.decline_reason ? `Reason: ${String(s.decline_reason).slice(0, 300)}` : null,
    ].filter(Boolean);
    for (const f of facts) line(f, { indent: 14 });
    y -= 6;
  }

  const events = Array.isArray(doc.activity) ? doc.activity : [];
  if (events.length) {
    rule();
    line('Event log', { font: helvBold, size: 13, color: INK, lead: 18 });
    for (const e of events.slice(-60)) {
      if (!e) continue;
      line(`${formatTs(e.ts)}  ${String(e.text || e.kind || '').slice(0, 300)}${e.ip ? `  (IP ${e.ip})` : ''}`, { size: 8.5, lead: 11.5 });
    }
  }

  if (hash) {
    rule();
    line('Completion fingerprint (SHA-256 of the document and every signer\'s answers and times):', { font: helvBold });
    line(hash, { color: INK, size: 8.5 });
  }
  y -= 6;
  line('The SHA-256 fingerprint of this signed PDF file is recorded in Ivy when the file is created, so any later change to the file can be detected.', { size: 8.5, lead: 11.5 });
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
        const shown = f.type === 'checkbox' ? (value === 'true' ? 'Yes' : 'No') : String(value || '');
        const line = `${label}: ${shown}`;
        writeLines(line, { indent: 10, size: 10.5, lead: 15 });
      }
    }
    const when = s.signed_at ? `Signed ${formatTs(s.signed_at)}` : null;
    const stamp = [when, s.ip ? `IP ${s.ip}` : null].filter(Boolean).join('  ·  ');
    if (stamp) writeLines(stamp, { indent: 10, size: 9, lead: 13, color: muted });
    y -= 10;
  }

  drawAuditPages(pdf, { doc, signers, hash, helv, helvBold, business });
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

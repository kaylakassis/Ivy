// Server-side check of an uploaded PDF before it becomes a document.
//
// The browser uploads straight to Blob storage, so the server never saw
// the bytes. When the editor then PATCHes the document with the new
// fileUrl, api/documents/[id].js calls fetchAndInspectPdf(): it downloads
// the file (platform blob host only, size capped), checks it really is a
// PDF, parses it, and returns the facts the rest of the flow relies on:
// the real page count, each page's size and rotation, and the SHA-256 of
// the original bytes (printed on the signing certificate as the "before"
// fingerprint).
//
// Parsing hostile input: the parse runs in a worker thread with a memory
// cap and a time limit, so a malformed or deliberately nasty file can
// only ever produce a friendly error, never crash or hang the function.
// If worker threads are unavailable in some runtime, it falls back to an
// in-process parse wrapped in try/catch.
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { assertPlatformBlobUrl } from './safeUrl.js';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
const PARSE_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

export class PdfRejectedError extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}

const require = createRequire(import.meta.url);
let pdfLibPath = null;
try { pdfLibPath = require.resolve('pdf-lib'); } catch { pdfLibPath = null; }

// CommonJS on purpose: eval workers run as CJS.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { PDFDocument } = require(workerData.lib);
    const pdf = await PDFDocument.load(workerData.bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const pages = pdf.getPages().slice(0, ${MAX_PDF_PAGES + 1}).map((p) => {
      const b = p.getCropBox();
      return { w: b.width, h: b.height, rotation: p.getRotation().angle || 0 };
    });
    parentPort.postMessage({ ok: true, pageCount: pdf.getPageCount(), encrypted: !!pdf.isEncrypted, pages });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
})();
`;

function parseInWorker(bytes) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { bytes, lib: pdfLibPath },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (e) {
      reject(Object.assign(new Error('worker unavailable'), { workerUnavailable: true, cause: e }));
      return;
    }
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => done(reject, new PdfRejectedError('That PDF took too long to read. Try saving it again as a new PDF and upload that.')), PARSE_TIMEOUT_MS);
    worker.once('message', (m) => done(resolve, m));
    worker.once('error', (e) => done(resolve, { ok: false, error: e?.message || 'worker error' }));
    worker.once('exit', (code) => done(resolve, { ok: false, error: `worker exited ${code}` }));
  });
}

async function parseInProcess(bytes) {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const pages = pdf.getPages().slice(0, MAX_PDF_PAGES + 1).map((p) => {
      const b = p.getCropBox();
      return { w: b.width, h: b.height, rotation: p.getRotation().angle || 0 };
    });
    return { ok: true, pageCount: pdf.getPageCount(), encrypted: !!pdf.isEncrypted, pages };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

// Validate raw bytes. Returns { pageCount, pages, sha256, bytes: n }.
// Throws PdfRejectedError with a plain-language message on anything wrong.
export async function inspectPdfBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length < 64) throw new PdfRejectedError("That file is empty or isn't a PDF.");
  if (bytes.length > MAX_PDF_BYTES) throw new PdfRejectedError('PDFs can be up to 25 MB. Try a smaller file.');
  // The %PDF- header must appear near the start (some writers put a few
  // junk bytes first; readers allow up to 1 KB).
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (head.indexOf('%PDF-') === -1) throw new PdfRejectedError("That file isn't a PDF. Please choose a .pdf file.");

  let result;
  if (pdfLibPath) {
    try { result = await parseInWorker(bytes); }
    catch (e) {
      if (e instanceof PdfRejectedError) throw e;
      result = await parseInProcess(bytes);
    }
  } else {
    result = await parseInProcess(bytes);
  }
  if (!result?.ok) throw new PdfRejectedError("We couldn't read that PDF. It may be damaged. Try saving it again as a new PDF and upload that.");
  if (result.encrypted) {
    throw new PdfRejectedError('This PDF has security settings (a password or editing lock), so signatures can\'t be added to it. Save or print it as a new PDF without a password, then upload that.');
  }
  if (!Number.isInteger(result.pageCount) || result.pageCount < 1) throw new PdfRejectedError('That PDF has no pages.');
  if (result.pageCount > MAX_PDF_PAGES) throw new PdfRejectedError(`PDFs can have up to ${MAX_PDF_PAGES} pages.`);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { pageCount: result.pageCount, pages: result.pages || [], sha256, size: bytes.length };
}

// Download from the platform blob store (never any other host: this runs
// server side, so an arbitrary URL would be an SSRF hole) and inspect.
export async function fetchAndInspectPdf(url) {
  let safe;
  try { safe = assertPlatformBlobUrl(url, { what: 'PDF URL' }); }
  catch { throw new PdfRejectedError('Upload the PDF first.'); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(safe, { signal: ctrl.signal, redirect: 'error' });
  } catch {
    clearTimeout(timer);
    throw new PdfRejectedError("We couldn't open the uploaded PDF. Please try uploading it again.");
  }
  try {
    if (!res.ok) throw new PdfRejectedError("We couldn't open the uploaded PDF. Please try uploading it again.");
    const len = Number(res.headers?.get?.('content-length') || 0);
    if (len > MAX_PDF_BYTES) throw new PdfRejectedError('PDFs can be up to 25 MB. Try a smaller file.');
    const buf = new Uint8Array(await res.arrayBuffer());
    return await inspectPdfBytes(buf);
  } finally {
    clearTimeout(timer);
  }
}

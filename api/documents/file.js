// GET /api/documents/file?t=<signed token>
//
// Opens one PDF of one document: the uploaded original ('source') or the
// signed copy ('final'). The token is minted by api/_lib/docFiles.js into
// API responses the caller was already allowed to see (the owner's
// document list, the client portal, the signing page) and expires within
// a day. No session is needed, so the same link works in the iPhone app,
// a new browser tab, or a signer who has no account.
//
// The document row is re-read on every request: a deleted document, a
// signed copy that no longer exists, or a stored address outside the
// platform blob store all answer 404. Private blobs are streamed through
// this function; public-store files (unguessable addresses) are reached
// with a no-store redirect, so the storage address is never kept in any
// API response, page, or email.
//
// Static sibling of [id].js so Vercel routes /api/documents/file here.
import { get } from '@vercel/blob';
import { sql } from '../_lib/db.js';
import { verifyDocFileToken } from '../_lib/docFiles.js';
import { isPlatformBlobUrl } from '../_lib/safeUrl.js';
import { blobPathnameForWorkspace } from '../_lib/blobScope.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { methodNotAllowed, notFound, serverError } from '../_lib/json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, ['GET']);
  // The token is the credential, so a cross-origin read (pdf.js in the
  // iPhone app runs on capacitor://localhost) is fine. No cookies are used.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `docfile:ip:${ip}`, max: 300, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const claim = verifyDocFileToken((req.query.t || '').toString());
    if (!claim || !UUID_RE.test(claim.documentId)) return notFound(res, 'This link has expired. Go back and open the document again.');

    const { rows } = await sql`
      SELECT id, workspace_id, name, status, file_url, final_pdf_url, final_pdf_private
        FROM documents WHERE id = ${claim.documentId}
    `;
    const doc = rows[0];
    if (!doc) return notFound(res, 'Document not found');
    const url = claim.kind === 'final' ? doc.final_pdf_url : doc.file_url;
    if (!url || !isPlatformBlobUrl(url)) return notFound(res, 'File not found');
    if (claim.kind === 'final' && doc.status !== 'completed') return notFound(res, 'File not found');

    // Files uploaded since workspace scoping carry the ws/<id>/ prefix; a
    // stored address under some OTHER workspace's prefix is never served.
    const scoped = blobPathnameForWorkspace(url, String(doc.workspace_id));
    let pathname = '';
    try { pathname = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, ''); } catch { pathname = ''; }
    if (!scoped && /^ws\//.test(pathname)) return notFound(res, 'File not found');

    const filename = `${String(doc.name || 'document').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document'}${claim.kind === 'final' ? '-signed' : ''}.pdf`;

    if (claim.kind === 'final' && doc.final_pdf_private) {
      const blob = await get(url, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
      if (!blob?.stream) return notFound(res, 'File not found');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method === 'HEAD') return res.end();
      const reader = blob.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }

    res.statusCode = 302;
    res.setHeader('Location', url);
    return res.end();
  } catch (err) {
    return serverError(res, err);
  }
}

// /api/documents/:id
//   GET    → single document (workspace-scoped)
//   PATCH  → update draft fields (only allowed while status='draft')
//   DELETE → remove

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc, cleanFields, fetchSigners } from '../_lib/documents.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';
import { blobPathnameForWorkspace } from '../_lib/blobScope.js';
import { fetchAndInspectPdf, PdfRejectedError } from '../_lib/pdfInspect.js';
import { enforce } from '../_lib/rate-limit.js';
import { sanitizeDocHtml } from '../../src/lib/docHtml.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return notFound(res, 'Document not found');

    if (req.method === 'GET') {
      const signers = await fetchSigners(id);
      return ok(res, { document: serializeDoc(doc, signers) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Restore: send/resend gate voided AND declined docs with "restore
      // to draft first", so that restore has to actually exist. Exactly
      // { status: 'draft' } flips either state back to an editable,
      // re-sendable draft.
      if ((doc.status === 'voided' || doc.status === 'declined')
          && body.status === 'draft' && Object.keys(body).length === 1) {
        const r = await sql`
          UPDATE documents SET status = 'draft', updated_at = NOW()
           WHERE id = ${id} AND workspace_id = ${workspaceId}
             AND status IN ('voided', 'declined')
           RETURNING *
        `;
        if (r.rows.length === 0) return badRequest(res, 'Document is no longer voided/declined');
        const signers = await fetchSigners(id);
        return ok(res, { document: serializeDoc(r.rows[0], signers) });
      }
      // Drafts and voided are editable; sent/signed content is locked,
      // and declined must be restored to draft (above) before editing.
      if (doc.status !== 'draft' && doc.status !== 'voided') {
        return badRequest(res, doc.status === 'declined'
          ? "Restore the declined document to draft first (PATCH { status: 'draft' })"
          : "Can't edit a document after it's been sent");
      }
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v || v.length > 200) return badRequest(res, 'Name is required (max 200 chars)');
        push('name', v);
      }
      if ('contentHtml' in body) {
        // Saved through the same allowlist the editor and signing page use.
        push('content_html', body.contentHtml ? sanitizeDocHtml(String(body.contentHtml).slice(0, 200000)) : null);
      }
      // A new PDF: check it server side before the document points at it.
      // Must be a file this workspace uploaded (ws/<id>/ prefix on the
      // platform blob store), must really be a PDF that parses, isn't
      // locked, and has 1-200 pages. The page count and the SHA-256
      // "before" fingerprint come from the server's read, never the browser.
      let inspected = null;
      if ('fileUrl' in body && body.fileUrl) {
        const url = String(body.fileUrl);
        const pathname = blobPathnameForWorkspace(url, String(workspaceId));
        if (!pathname) return badRequest(res, 'Invalid fileUrl: upload the PDF first');
        const blocked = await enforce(req, res, [
          { key: `doc-pdf-check:ws:${workspaceId}`, max: 60, windowSeconds: 60 * 60 },
        ]);
        if (blocked) return;
        try {
          inspected = await fetchAndInspectPdf(url);
        } catch (e) {
          if (e instanceof PdfRejectedError) return badRequest(res, e.message);
          throw e;
        }
        push('file_url', url);
        push('pdf_blob_pathname', pathname);
        push('page_count', inspected.pageCount);
        push('source_pdf_sha256', inspected.sha256);
        push('kind', 'pdf');
        // Positions are page-relative: a different file means the old
        // placements no longer line up, unless the caller sends new ones.
        if (!('fields' in body)) push('fields', '[]');
      } else if ('fileUrl' in body) {
        push('file_url', null);
        push('pdf_blob_pathname', null);
        push('source_pdf_sha256', null);
      }
      const effectivePages = inspected ? inspected.pageCount
        : ((('kind' in body ? body.kind : doc.kind) === 'pdf' && doc.file_url) ? doc.page_count : null);
      if ('fields' in body) {
        const fields = cleanFields(body.fields, { pageCount: effectivePages || undefined });
        if (fields === null) return badRequest(res, 'Invalid fields');
        push('fields', JSON.stringify(fields));
      }
      if ('isTemplate' in body) {
        push('is_template', !!body.isTemplate);
      }
      if ('kind' in body && !inspected) {
        const k = (body.kind || '').toString();
        if (k !== 'pdf' && k !== 'written') return badRequest(res, 'Invalid kind');
        push('kind', k);
      }
      if ('pageCount' in body && !inspected) {
        const n = Number(body.pageCount);
        if (!Number.isInteger(n) || n < 1 || n > 200) return badRequest(res, 'pageCount out of range');
        push('page_count', n);
      }

      if (sets.length === 0) return ok(res, { document: serializeDoc(doc) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE documents SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      const signers = await fetchSigners(id);
      return ok(res, { document: serializeDoc(rows[0], signers) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}

// API-backed documents store.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useDocuments() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/documents')
      .then((r) => live && setDocuments(r.documents || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.get('/documents');
    setDocuments(r.documents || []);
    return r.documents;
  }, []);

  const create = useCallback(async (input) => {
    const r = await api.post('/documents', input);
    setDocuments((ds) => [r.document, ...ds]);
    return r.document;
  }, []);

  // Clone a built-in starter template (api/_lib/documentTemplates.js)
  // into a fresh draft. Single round trip — the server handles the
  // body + field copy. Returns the new doc so callers can immediately
  // open it in the editor.
  const createFromTemplate = useCallback(async (templateId, name) => {
    const r = await api.post('/documents/templates', { templateId, name });
    setDocuments((ds) => [r.document, ...ds]);
    return r.document;
  }, []);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/documents/' + id, patch);
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  const remove = useCallback(async (id) => {
    await api.del('/documents/' + id);
    setDocuments((ds) => ds.filter((d) => d.id !== id));
  }, []);

  // Accepts a single clientId (legacy) OR an array of recipients
  // ([{ clientId, name?, email? }]) for multi-signer sends. The
  // server endpoint normalizes both.
  const send = useCallback(async (id, recipientsOrClientId) => {
    const body = Array.isArray(recipientsOrClientId)
      ? { id, recipients: recipientsOrClientId }
      : { id, clientId: recipientsOrClientId };
    const r = await api.post('/documents/send', body);
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  // Resend a pending document to its current awaiting signer. Mints a
  // fresh sign link (older links stop working) so the recipient always
  // clicks the most-recent email.
  const resend = useCallback(async (id) => {
    const r = await api.post('/documents/resend', { id });
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  const voidDoc = useCallback(async (id) => {
    const r = await api.post('/documents/void', { id });
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  // Streams a PDF directly to Vercel Blob using the upload-token
  // endpoint, then PATCHes the document row with the new fileUrl,
  // page count, and kind='pdf'. Returns the updated document. The
  // browser also counts pages locally so we don't need an extra
  // server round trip.
  const uploadPdf = useCallback(async (id, file) => {
    if (!file) throw new Error('No file');
    if (file.type !== 'application/pdf') throw new Error('Please choose a PDF');
    if (file.size > 25 * 1024 * 1024) throw new Error('PDF must be under 25 MB');

    const { upload } = await import('@vercel/blob/client');
    const result = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/documents/upload-token',
      contentType: 'application/pdf',
    });

    const pageCount = await countPdfPages(file).catch(() => 1);

    const patched = await api.patch('/documents/' + id, {
      kind: 'pdf',
      fileUrl: result.url,
      pdfBlobPathname: result.pathname,
      pageCount,
      // Wipe any prior field placements when swapping the source PDF;
      // page-relative coordinates would otherwise misalign.
      fields: [],
    });
    setDocuments((ds) => ds.map((d) => d.id === id ? patched.document : d));
    return patched.document;
  }, []);

  return { documents, loading, error, refresh, create, createFromTemplate, update, remove, send, resend, void: voidDoc, uploadPdf };
}

// Local-only page counter so we can stamp page_count on the row at
// upload time without a server round trip. Re-uses the pdfjs-dist
// import the editor + viewer already load.
async function countPdfPages(file) {
  const lib = await import('pdfjs-dist/build/pdf.mjs');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;
  return pdf.numPages;
}

// API-backed documents store.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useDocuments() {
  const [documents, setDocuments] = useState([]);
  // Your own saved templates (documents.is_template), listed separately.
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/documents')
      .then((r) => live && setDocuments(r.documents || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    api.get('/documents?templates=1')
      .then((r) => live && setTemplates(r.documents || []))
      .catch(() => live && setTemplates([]));
    return () => { live = false; };
  }, []);

  // A changed row may live in either list.
  const replace = useCallback((doc) => {
    if (!doc) return;
    setDocuments((ds) => ds.map((d) => d.id === doc.id ? doc : d));
    setTemplates((ts) => ts.map((d) => d.id === doc.id ? doc : d));
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
  // into a fresh draft. Single round trip - the server handles the
  // body + field copy. Returns the new doc so callers can immediately
  // open it in the editor.
  const createFromTemplate = useCallback(async (templateId, name) => {
    const r = await api.post('/documents/templates', { templateId, name });
    setDocuments((ds) => [r.document, ...ds]);
    return r.document;
  }, []);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/documents/' + id, patch);
    replace(r.document);
    return r.document;
  }, [replace]);

  const remove = useCallback(async (id) => {
    await api.del('/documents/' + id);
    setDocuments((ds) => ds.filter((d) => d.id !== id));
    setTemplates((ts) => ts.filter((d) => d.id !== id));
  }, []);

  // "Save as template": a reusable copy (fields and PDF included).
  const saveTemplate = useCallback(async (id, name) => {
    const r = await api.post('/documents/save-template', { id, ...(name ? { name } : {}) });
    setTemplates((ts) => [r.template, ...ts]);
    return r.template;
  }, []);

  // Send a saved template to many clients: one copy each.
  const sendTemplate = useCallback(async (templateId, clientIds, ownerSigns = null) => {
    const r = await api.post('/documents/send-template', { templateId, clientIds, ...(ownerSigns ? { ownerSigns } : {}) });
    const fresh = await api.get('/documents').catch(() => null);
    if (fresh?.documents) setDocuments(fresh.documents);
    return r;
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
    // Whole response: callers need selfSignUrl / warning, not just the doc.
    return r;
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
  // endpoint, then PATCHes the document row with the new fileUrl. The
  // server re-reads the file (real PDF? not locked? how many pages?) and
  // answers with a plain-language error if it can't use it.
  const uploadPdf = useCallback(async (id, file) => {
    if (!file) throw new Error('No file');
    const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!looksPdf) throw new Error('Please choose a PDF file');
    if (file.size > 25 * 1024 * 1024) throw new Error('PDFs can be up to 25 MB');

    const { uploadFile: upload } = await import('../../lib/blobUpload.js');
    const result = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/documents/upload-token',
      contentType: 'application/pdf',
    });

    const patched = await api.patch('/documents/' + id, {
      kind: 'pdf',
      fileUrl: result.url,
      pdfBlobPathname: result.pathname,
      // Wipe any prior field placements when swapping the source PDF;
      // page-relative coordinates would otherwise misalign.
      fields: [],
    });
    replace(patched.document);
    return patched.document;
  }, [replace]);

  // Owner-as-signer: mint a link for their own turn (see api/documents/self-sign.js).
  const selfSignLink = useCallback(async (id) => {
    const r = await api.post('/documents/self-sign', { id });
    return r.url;
  }, []);

  return { documents, templates, loading, error, refresh, create, createFromTemplate, update, remove, send, resend, void: voidDoc, uploadPdf, selfSignLink, saveTemplate, sendTemplate };
}

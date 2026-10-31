// "Preview" from the invoice editor: exactly what the client will get.
// Two tabs: the invoice document (same renderer as the public page and
// the PDF) and the email, subject and body, rendered by the server with
// the same code the send button uses. Print / Save PDF, a shortcut to the
// design editor, and Send right from here.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import InvoiceDocument, { printInvoice } from './InvoiceDocument.jsx';
import InvoiceDesignModal from './InvoiceDesignModal.jsx';

export default function InvoicePreviewModal({ invoiceId, draft, onClose, onSend, sendLabel = 'Send invoice' }) {
  useEscapeKey(onClose);
  const [tab, setTab] = useState('invoice');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [designOpen, setDesignOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const load = () => api.get(`/invoices/preview?id=${encodeURIComponent(invoiceId)}`).then(setData).catch((e) => setErr(e.message || 'Could not load the preview'));
  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [invoiceId]);

  const inv = data ? { ...data.invoice, ...(draft || {}) } : null;

  return createPortal((
    <div role="dialog" aria-modal="true" aria-labelledby="inv-preview-title" className="motion-backdrop"
      // stopPropagation: this portal's clicks bubble through the React tree to
      // the drawer or card that opened it, which would otherwise close.
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div className="motion-modal" style={{ width: '100%', maxWidth: 860, maxHeight: '96vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)', color: 'var(--fg)', borderRadius: 16, border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <div id="inv-preview-title" style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>Preview: what {inv?.clientName || 'your client'} will see</div>
          <div role="tablist" style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 3, borderRadius: 10 }}>
            {[['invoice', 'Invoice'], ['email', 'Email']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="btn btn-ghost"
                style={{ padding: '6px 12px', fontSize: 13, borderRadius: 8, background: tab === k ? 'var(--surface)' : 'transparent', fontWeight: tab === k ? 600 : 500 }}>{l}</button>
            ))}
          </div>
          <button className="btn btn-ghost" aria-label="Close" onClick={onClose} style={{ padding: 8 }}><Icons.X size={15}/></button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: tab === 'invoice' ? '#d7dbe0' : 'var(--surface-2)', padding: tab === 'invoice' ? 18 : 0 }}>
          {err && <div style={{ padding: 20, color: 'var(--danger)' }}>{err}</div>}
          {!data && !err && <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading preview…</div>}
          {data && tab === 'invoice' && (
            <div style={{ maxWidth: 720, margin: '0 auto' }}>
              <InvoiceDocument invoice={inv} business={data.invoice.business}/>
            </div>
          )}
          {data && tab === 'email' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420 }}>
              <div style={{ padding: '10px 14px', fontSize: 12.5, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <span style={{ color: 'var(--muted)' }}>Subject: </span><strong>{data.email.subject}</strong>
              </div>
              <iframe title="Email preview" sandbox="" srcDoc={data.email.html} style={{ flex: 1, width: '100%', minHeight: 480, border: 0, background: '#fff' }}/>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-outline" onClick={() => setDesignOpen(true)} style={{ fontSize: 13 }}>
            <Icons.Image size={13}/> Change design
          </button>
          {tab === 'invoice' && (
            <button className="btn btn-outline" onClick={printInvoice} style={{ fontSize: 13 }}>
              <Icons.Doc size={13}/> Print / Save PDF
            </button>
          )}
          <span style={{ flex: 1 }}/>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 13 }}>Back to editing</button>
          {onSend && (
            <button className="btn btn-primary" disabled={sending} style={{ fontSize: 13 }}
              onClick={async () => { setSending(true); try { await onSend(); } finally { setSending(false); } }}>
              <Icons.Mail size={13}/> {sending ? 'Sending…' : sendLabel}
            </button>
          )}
        </div>
      </div>
      {designOpen && <InvoiceDesignModal onClose={() => { setDesignOpen(false); load(); }}/>}
    </div>
  ), document.body);
}

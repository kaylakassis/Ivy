// Finance → Invoices: a small card showing the owner's current invoice
// design with a Customize button that opens the design editor.
// /finance?design=1 opens it straight away (used by the preview's
// "Change design" shortcut and the Account page).
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { INVOICE_FONTS, INVOICE_LAYOUTS, DEFAULT_DESIGN, SAMPLE_INVOICE } from '../../lib/invoiceDesign.js';
import InvoiceDocument from './InvoiceDocument.jsx';
import InvoiceDesignModal from './InvoiceDesignModal.jsx';

export default function InvoiceDesignCard() {
  const [params, setParams] = useSearchParams();
  const [b, setB] = useState(null);
  const [open, setOpen] = useState(params.get('design') === '1');
  const load = () => api.get('/account/branding').then((r) => setB(r.branding || {})).catch(() => setB({}));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (params.get('design') === '1') { const n = new URLSearchParams(params); n.delete('design'); setParams(n, { replace: true }); }
  }, [params, setParams]);

  const business = b ? { name: b.businessName || 'Your business', logoUrl: b.logoUrl, accentColor: b.accentColor || DEFAULT_DESIGN.accentColor, font: b.font || DEFAULT_DESIGN.font, layout: b.invoiceLayout || DEFAULT_DESIGN.layout, footer: b.invoiceFooter != null ? b.invoiceFooter : DEFAULT_DESIGN.footer, contact: b.contact || '' } : null;
  const fontLabel = INVOICE_FONTS[business?.font]?.label || 'Clean';
  const layoutLabel = INVOICE_LAYOUTS[business?.layout]?.label || 'Classic';

  return (
    <div className="card" style={{ padding: 18, marginBottom: 14, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <div aria-hidden="true" style={{ width: 150, height: 104, borderRadius: 8, overflow: 'hidden', background: '#d7dbe0', flex: '0 0 auto', position: 'relative' }}>
        {business && (
          <div style={{ position: 'absolute', left: 8, top: 8, width: 560, transformOrigin: 'top left', transform: 'scale(0.24)', pointerEvents: 'none' }}>
            <InvoiceDocument invoice={SAMPLE_INVOICE} business={business}/>
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div className="metric-label" style={{ marginBottom: 4 }}>Invoice design</div>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>
          {business ? <>{layoutLabel} layout · {fontLabel} · <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: business.accentColor, verticalAlign: '-1px' }}/> {business.logoUrl ? 'your logo' : 'no logo yet'}</> : 'Loading…'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
          Your logo, color, font and layout on every invoice, and on the emails that carry them. Preview any invoice before you send it.
        </div>
      </div>
      <button className="btn btn-outline" onClick={() => setOpen(true)} style={{ fontSize: 13 }}>
        <Icons.Image size={13}/> Customize
      </button>
      {open && <InvoiceDesignModal onClose={() => { setOpen(false); load(); }}/>}
    </div>
  );
}

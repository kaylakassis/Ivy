// The invoice as a document: what the client sees on /invoice/:token, what
// the owner sees in Preview before sending, and what prints or saves as a
// PDF. One renderer, so the preview is always exactly what goes out.
//
// Always rendered as paper (white, dark text) whatever the app theme, in
// the owner's chosen font, layout and accent color (src/lib/invoiceDesign.js).
import React, { useEffect, useRef, useState } from 'react';
import { INVOICE_FONTS, DEFAULT_DESIGN, fontCss, inkFor, loadInvoiceFont } from '../../lib/invoiceDesign.js';
import { fmtMoney } from '../../lib/money.js';

function fmtDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' && d.length === 10 ? d + 'T00:00:00' : d;
  try { return new Date(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return String(d); }
}
function lines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}
function totalsOf(inv) {
  const items = inv.items || [];
  const subtotal = inv.subtotal != null ? Number(inv.subtotal) : items.reduce((s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0), 0);
  const discount = Number(inv.discount || 0);
  const taxRate = Number(inv.taxRate || 0);
  const taxable = Math.max(0, subtotal - discount);
  const tax = inv.tax != null ? Number(inv.tax) : taxable * (taxRate / 100);
  const total = inv.total != null ? Number(inv.total) : taxable + tax;
  return { subtotal, discount, taxRate, tax, total };
}

// Pin a short, legible palette for paper so dark-mode variables never leak in.
const P = { ink: '#111318', ink2: '#3d434d', muted: '#6b7280', rule: '#e5e7eb', paper: '#ffffff', soft: '#f5f6f8' };

// Phones: the document tightens its padding and stacks the From / Bill to /
// dates block in two columns once it is narrower than 540px.
function useNarrow(ref) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 540));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return narrow;
}

export default function InvoiceDocument({ invoice, business, design, compact: compactProp = false, style }) {
  const rootRef = useRef(null);
  const narrow = useNarrow(rootRef);
  const compact = compactProp || narrow;
  const inv = invoice || {};
  const biz = business || {};
  const d = {
    font: design?.font || biz.font || DEFAULT_DESIGN.font,
    layout: design?.layout || biz.layout || DEFAULT_DESIGN.layout,
    accent: design?.accentColor || biz.accentColor || DEFAULT_DESIGN.accentColor,
    footer: design?.footer != null ? design.footer : (biz.footer != null ? biz.footer : DEFAULT_DESIGN.footer),
    contact: design?.contact != null ? design.contact : (biz.contact || ''),
    logoUrl: design?.logoUrl !== undefined ? design.logoUrl : (biz.logoUrl || null),
    name: design?.name || biz.name || 'Your business',
  };
  useEffect(() => { loadInvoiceFont(d.font); }, [d.font]);
  const ink = inkFor(d.accent);
  const t = totalsOf(inv);
  const paid = inv.status === 'paid';
  const refunded = inv.status === 'refunded';
  const paidSoFar = Number(inv.paidAmount || 0);
  const remaining = Math.max(0, t.total - paidSoFar);
  const fontFamily = fontCss(d.font);
  const isSerif = /serif/.test(fontFamily) && !/sans-serif/.test(fontFamily.split(',')[0]);
  const pad = compact ? 22 : 40;
  const contactLines = lines(d.contact);

  const Logo = ({ light = false }) => (d.logoUrl
    ? <img src={d.logoUrl} alt={d.name} style={{ maxHeight: compact ? 34 : 48, maxWidth: 180, objectFit: 'contain', display: 'block' }}/>
    : <div style={{ fontSize: compact ? 18 : 24, fontWeight: isSerif ? 500 : 700, letterSpacing: '-0.01em', color: light ? ink : P.ink }}>{d.name}</div>);

  const Label = ({ children, light }) => (
    <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: light ? ink : P.muted, opacity: light ? 0.8 : 1, marginBottom: 4 }}>{children}</div>
  );

  const header = d.layout === 'bold' ? (
    <div style={{ background: d.accent, color: ink, padding: `${pad * 0.7}px ${pad}px`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <Logo light/>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: compact ? 20 : 28, fontWeight: 700, letterSpacing: '0.02em' }}>INVOICE</div>
        <div style={{ fontSize: 13, opacity: 0.9 }}>{inv.number || 'INV-0000'}</div>
      </div>
    </div>
  ) : d.layout === 'minimal' ? (
    <div style={{ padding: `${pad}px ${pad}px 0`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
      <Logo/>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: compact ? 16 : 20, fontWeight: 500, color: P.ink2, letterSpacing: '0.04em' }}>Invoice</div>
        <div style={{ fontSize: 13, color: P.muted }}>{inv.number || 'INV-0000'}</div>
      </div>
    </div>
  ) : (
    <div style={{ padding: `${pad}px ${pad}px ${pad * 0.5}px`, borderBottom: `3px solid ${d.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <Logo/>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: compact ? 20 : 26, fontWeight: 700, color: d.accent, letterSpacing: '0.02em' }}>INVOICE</div>
        <div style={{ fontSize: 13, color: P.muted }}>{inv.number || 'INV-0000'}</div>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="invoice-doc" style={{
      fontFamily, color: P.ink, background: P.paper, borderRadius: compact ? 10 : 6,
      boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 10px 30px rgba(0,0,0,0.10)',
      overflow: 'hidden', position: 'relative', lineHeight: 1.45, ...style,
    }}>
      {paid && (
        <div aria-label="Paid" style={{
          position: 'absolute', top: compact ? 64 : 96, right: pad, transform: 'rotate(-12deg)',
          border: `3px solid ${d.accent}`, color: d.accent, borderRadius: 8, padding: '4px 14px',
          fontSize: compact ? 16 : 22, fontWeight: 800, letterSpacing: '0.18em', opacity: 0.85,
        }}>PAID</div>
      )}
      {header}

      <div style={{ padding: `${pad * 0.6}px ${pad}px 0`, display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : '1.2fr 1fr 1fr', gap: 18 }}>
        <div>
          <Label>From</Label>
          <div style={{ fontWeight: 600 }}>{d.name}</div>
          {contactLines.map((l, i) => <div key={i} style={{ fontSize: 12.5, color: P.ink2 }}>{l}</div>)}
        </div>
        <div>
          <Label>Bill to</Label>
          <div style={{ fontWeight: 600 }}>{inv.clientName || 'Client'}</div>
          {inv.clientEmail && <div style={{ fontSize: 12.5, color: P.ink2 }}>{inv.clientEmail}</div>}
        </div>
        <div style={{ gridColumn: compact ? '1 / -1' : 'auto', textAlign: compact ? 'left' : 'right' }}>
          <Label>Issued</Label>
          <div style={{ fontSize: 13 }}>{fmtDate(inv.issueDate) || '—'}</div>
          {inv.dueDate && (<><Label>Due</Label><div style={{ fontSize: 13, fontWeight: 600 }}>{fmtDate(inv.dueDate)}</div></>)}
        </div>
      </div>

      <div style={{ padding: `${pad * 0.6}px ${pad}px 0` }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={d.layout === 'minimal' ? { borderBottom: `1px solid ${P.ink}` } : { background: d.layout === 'bold' ? P.soft : d.accent, color: d.layout === 'bold' ? P.ink : ink }}>
              {['Description', 'Qty', 'Rate', 'Amount'].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '9px 10px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: d.layout === 'minimal' ? P.muted : 'inherit' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(inv.items || []).map((it, i) => (
              <tr key={it.id || i} style={{ borderBottom: `1px solid ${P.rule}` }}>
                <td style={{ padding: '10px', verticalAlign: 'top' }}>{it.description || '—'}</td>
                <td style={{ padding: '10px', textAlign: 'right', color: P.ink2 }}>{Number(it.quantity || 0)}</td>
                <td style={{ padding: '10px', textAlign: 'right', color: P.ink2 }}>{fmtMoney(it.rate, inv.currency)}</td>
                <td style={{ padding: '10px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(Number(it.quantity || 0) * Number(it.rate || 0), inv.currency)}</td>
              </tr>
            ))}
            {(!inv.items || inv.items.length === 0) && (
              <tr><td colSpan={4} style={{ padding: 14, color: P.muted, textAlign: 'center' }}>No line items yet</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <div style={{ minWidth: compact ? 200 : 260, fontSize: 13 }}>
            <Row label="Subtotal" value={fmtMoney(t.subtotal, inv.currency)}/>
            {t.discount > 0 && <Row label="Discount" value={'− ' + fmtMoney(t.discount, inv.currency)}/>}
            {t.taxRate > 0 && <Row label={`Tax (${t.taxRate}%)`} value={fmtMoney(t.tax, inv.currency)}/>}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 10px', marginTop: 4, borderTop: `2px solid ${d.layout === 'minimal' ? P.ink : d.accent}`, fontSize: compact ? 15 : 17, fontWeight: 700, color: d.layout === 'minimal' ? d.accent : P.ink }}>
              <span>{paid ? 'Total paid' : refunded ? 'Total (refunded)' : 'Total due'}</span>
              <span>{fmtMoney(paid ? t.total : remaining, inv.currency)}</span>
            </div>
            {!paid && paidSoFar > 0 && <Row label="Already paid" value={'− ' + fmtMoney(paidSoFar, inv.currency)} muted/>}
          </div>
        </div>
      </div>

      {(inv.notes || d.footer) && (
        <div style={{ padding: `${pad * 0.5}px ${pad}px ${pad}px`, fontSize: 12.5, color: P.ink2 }}>
          {inv.notes && (<><Label>Notes</Label><div style={{ whiteSpace: 'pre-wrap', marginBottom: d.footer ? 14 : 0 }}>{inv.notes}</div></>)}
          {d.footer && <div style={{ borderTop: `1px solid ${P.rule}`, paddingTop: 12, color: P.muted, textAlign: 'center' }}>{d.footer}</div>}
        </div>
      )}
      {/* Discreet attribution on every invoice, on screen and in print. */}
      <div className="invoice-doc-powered" style={{ padding: `0 ${pad}px ${compact ? 14 : 18}px`, textAlign: 'center', fontSize: 10.5, letterSpacing: '0.02em', color: '#9ca3af' }}>
        <a href="https://www.joinivy.ai" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
          Powered by Ivy: For Solo Businesses
        </a>
      </div>
    </div>
  );
}

function Row({ label, value, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 10px', color: muted ? '#6b7280' : '#3d434d' }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

// Print only the document. Clones the first .invoice-doc on the page into
// a host that is the only visible thing while body.print-invoice-only is
// set (global.css), then opens the print dialog. "Save as PDF" is a
// destination in every print dialog, including iPhone's share sheet.
export function printInvoice() {
  if (typeof window === 'undefined') return;
  const doc = document.querySelector('.invoice-doc');
  if (!doc) { window.print(); return; }
  const host = document.createElement('div');
  host.className = 'invoice-print-host';
  host.style.display = 'none';
  host.appendChild(doc.cloneNode(true));
  document.body.appendChild(host);
  document.body.classList.add('print-invoice-only');
  const done = () => {
    document.body.classList.remove('print-invoice-only');
    host.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
  setTimeout(done, 60000);
}

export { INVOICE_FONTS };

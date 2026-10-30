// Invoice design editor: logo, business name, color, font, layout, contact
// lines and footer, with a live preview of a sample invoice on the right.
// Saves to /api/account/branding (the same branding emails use), so an
// owner's logo and color stay consistent across invoices and emails.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { INVOICE_FONTS, INVOICE_LAYOUTS, DEFAULT_DESIGN, SAMPLE_INVOICE, fontCss, loadInvoiceFont } from '../../lib/invoiceDesign.js';
import InvoiceDocument from './InvoiceDocument.jsx';

const SWATCHES = ['#2E3168', '#0F766E', '#1D4ED8', '#7C3AED', '#BE185D', '#B45309', '#15803D', '#111827'];

export default function InvoiceDesignModal({ onClose }) {
  useEscapeKey(onClose);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [initial, setInitial] = useState(null);
  const [f, setF] = useState({ name: '', logoUrl: null, logoPathname: null, accentColor: DEFAULT_DESIGN.accentColor, font: DEFAULT_DESIGN.font, layout: DEFAULT_DESIGN.layout, contact: '', footer: DEFAULT_DESIGN.footer });

  useEffect(() => {
    let live = true;
    api.get('/account/branding').then((r) => {
      if (!live) return;
      const b = r.branding || {};
      const next = {
        name: b.businessName || '', logoUrl: b.logoUrl || null, logoPathname: b.logoPathname || null,
        accentColor: b.accentColor || DEFAULT_DESIGN.accentColor, font: b.font || DEFAULT_DESIGN.font,
        layout: b.invoiceLayout || DEFAULT_DESIGN.layout, contact: b.contact || '',
        footer: b.invoiceFooter != null ? b.invoiceFooter : DEFAULT_DESIGN.footer,
      };
      setF(next); setInitial(next);
    }).catch((e) => live && setErr(e.message || 'Could not load')).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);
  useEffect(() => { Object.keys(INVOICE_FONTS).forEach(loadInvoiceFont); }, []);

  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setSaved(false); };
  const dirty = useMemo(() => initial && JSON.stringify(initial) !== JSON.stringify(f), [initial, f]);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const r = await api.patch('/account/branding', {
        businessName: f.name || undefined, logoUrl: f.logoUrl, logoPathname: f.logoPathname,
        accentColor: f.accentColor, font: f.font, invoiceLayout: f.layout, contact: f.contact, invoiceFooter: f.footer,
      });
      const b = r.branding || {};
      setInitial({ ...f, name: b.businessName || f.name });
      setSaved(true);
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const onPickLogo = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr('Logo must be under 10 MB'); return; }
    setUploading(true); setErr(null);
    try {
      const { uploadFile } = await import('../../lib/blobUpload.js');
      const r = await uploadFile(file.name, file, { access: 'public', handleUploadUrl: '/api/account/branding-logo-token', contentType: file.type });
      setF((x) => ({ ...x, logoUrl: r.url, logoPathname: r.pathname })); setSaved(false);
    } catch (ex) { setErr(ex.message || 'Upload failed'); }
    finally { setUploading(false); }
  };

  const business = { name: f.name || 'Your business', logoUrl: f.logoUrl, accentColor: f.accentColor, font: f.font, layout: f.layout, footer: f.footer, contact: f.contact };
  const hexOk = /^#[0-9a-fA-F]{6}$/.test(f.accentColor);

  return createPortal((
    <div role="dialog" aria-modal="true" aria-labelledby="inv-design-title" className="motion-backdrop"
      // stopPropagation: this portal's clicks bubble through the React tree to
      // the drawer or card that opened it, which would otherwise close.
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1010, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div className="motion-modal" style={{ width: '100%', maxWidth: 1100, height: 'min(96vh, 820px)', display: 'flex', flexDirection: 'column', background: 'var(--surface)', color: 'var(--fg)', borderRadius: 16, border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ flex: 1 }}>
            <div id="inv-design-title" style={{ fontWeight: 600, fontSize: 15 }}>Invoice design</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Your logo and color also appear on every email your clients get.</div>
          </div>
          <button className="btn btn-ghost" aria-label="Close" onClick={onClose} style={{ padding: 8 }}><Icons.X size={15}/></button>
        </div>

        <div className="inv-design-body" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr' }}>
          <div style={{ overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 18, borderRight: '1px solid var(--border)' }}>
            {loading ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div> : (
              <>
                <section>
                  <Label>Logo</Label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 10, background: '#fff', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                      {f.logoUrl ? <img src={f.logoUrl} alt="" style={{ maxWidth: '85%', maxHeight: '85%', objectFit: 'contain' }}/> : <Icons.Image size={22} stroke="var(--muted)"/>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label className="btn btn-outline" style={{ cursor: 'pointer', fontSize: 12, padding: '6px 10px' }}>
                        {uploading ? 'Uploading…' : (f.logoUrl ? 'Replace logo' : 'Upload logo')}
                        <input type="file" accept="image/*" onChange={onPickLogo} disabled={uploading} style={{ display: 'none' }}/>
                      </label>
                      {f.logoUrl && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 8px', color: 'var(--danger)' }} onClick={() => { set('logoUrl', null); set('logoPathname', null); }}>Remove</button>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>PNG, JPG, WebP or SVG. Without a logo, your business name is used.</div>
                </section>

                <section>
                  <Label>Business name</Label>
                  <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Your business" style={inputS}/>
                </section>

                <section>
                  <Label>Color</Label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    {SWATCHES.map((c) => (
                      <button key={c} type="button" aria-label={c} onClick={() => set('accentColor', c)}
                        style={{ width: 26, height: 26, borderRadius: 13, background: c, border: f.accentColor.toLowerCase() === c.toLowerCase() ? '3px solid var(--fg)' : '2px solid rgba(255,255,255,0.25)', cursor: 'pointer' }}/>
                    ))}
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                      <input type="color" value={hexOk ? f.accentColor : '#2E3168'} onChange={(e) => set('accentColor', e.target.value)} style={{ width: 28, height: 28, padding: 0, border: 0, background: 'none', cursor: 'pointer' }}/>
                      Custom
                    </label>
                    <input value={f.accentColor} onChange={(e) => set('accentColor', e.target.value)} maxLength={7} style={{ ...inputS, width: 92, fontFamily: 'var(--font-num)' }}/>
                  </div>
                </section>

                <section>
                  <Label>Font</Label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {Object.entries(INVOICE_FONTS).map(([k, font]) => (
                      <button key={k} type="button" aria-pressed={f.font === k} onClick={() => set('font', k)} style={{
                        textAlign: 'left', padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                        border: `2px solid ${f.font === k ? 'var(--accent)' : 'var(--border)'}`, background: f.font === k ? 'var(--accent-soft)' : 'var(--surface-2)', color: 'var(--fg)',
                      }}>
                        <div style={{ fontFamily: fontCss(k), fontSize: 16, lineHeight: 1.1 }}>{font.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{font.sample}</div>
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <Label>Layout</Label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {Object.entries(INVOICE_LAYOUTS).map(([k, l]) => (
                      <button key={k} type="button" aria-pressed={f.layout === k} onClick={() => set('layout', k)} title={l.hint} style={{
                        padding: 8, borderRadius: 10, cursor: 'pointer', color: 'var(--fg)',
                        border: `2px solid ${f.layout === k ? 'var(--accent)' : 'var(--border)'}`, background: f.layout === k ? 'var(--accent-soft)' : 'var(--surface-2)',
                      }}>
                        <LayoutThumb kind={k} accent={hexOk ? f.accentColor : '#2E3168'}/>
                        <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>{l.label}</div>
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <Label>Your details on the invoice</Label>
                  <textarea value={f.contact} onChange={(e) => set('contact', e.target.value)} rows={3} placeholder={'123 Main St, Suite 4\nAustin, TX 78701\n(512) 555-0100 · hello@yourbusiness.com'} style={{ ...inputS, resize: 'vertical', fontFamily: 'inherit' }}/>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Address, phone, email, tax ID. One per line, shown under your name.</div>
                </section>

                <section>
                  <Label>Footer line</Label>
                  <input value={f.footer} onChange={(e) => set('footer', e.target.value)} maxLength={300} placeholder="Thank you for your business." style={inputS}/>
                </section>
              </>
            )}
          </div>

          <div style={{ overflow: 'auto', background: '#d7dbe0', padding: 18 }}>
            <div style={{ maxWidth: 680, margin: '0 auto' }}>
              <InvoiceDocument invoice={SAMPLE_INVOICE} business={business}/>
              <div style={{ textAlign: 'center', fontSize: 11.5, color: '#4b5563', marginTop: 10 }}>Sample invoice. Your real line items, dates and client replace these.</div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
          {err && <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</span>}
          {saved && !dirty && <span style={{ color: 'var(--ok)', fontSize: 12.5 }}>Saved. Every new invoice and email uses this design.</span>}
          <span style={{ flex: 1 }}/>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 13 }}>{dirty ? 'Discard' : 'Done'}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty || !hexOk} style={{ fontSize: 13 }}>{saving ? 'Saving…' : 'Save design'}</button>
        </div>
      </div>
    </div>
  ), document.body);
}

function Label({ children }) {
  return <div className="metric-label" style={{ marginBottom: 6 }}>{children}</div>;
}
const inputS = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--fg)', fontSize: 13 };

function LayoutThumb({ kind, accent }) {
  const bar = (w, h = 4, c = '#cbd0d6') => <div style={{ width: w, height: h, background: c, borderRadius: 2 }}/>;
  return (
    <div style={{ background: '#fff', borderRadius: 6, padding: 6, height: 62, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden' }}>
      {kind === 'bold'
        ? <div style={{ background: accent, height: 14, borderRadius: 3 }}/>
        : kind === 'classic'
          ? <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: `2px solid ${accent}`, paddingBottom: 3 }}>{bar('30%', 6, '#8a9099')}{bar('22%', 6, accent)}</div>
          : <div style={{ display: 'flex', justifyContent: 'space-between' }}>{bar('30%', 6, '#8a9099')}{bar('18%', 6, '#8a9099')}</div>}
      {bar('60%')}{bar('80%')}{bar('70%')}
      <div style={{ alignSelf: 'flex-end' }}>{bar(30, 5, kind === 'minimal' ? accent : '#4b5563')}</div>
    </div>
  );
}

// Sales-tax default card. One number: the % seeded onto every new
// invoice, POS sale, and billed time entry. Kept deliberately tiny -
// most service-only owners leave it at 0; retail sellers set it once
// and stop re-keying tax on every sale.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function SalesTaxCard() {
  const [rate, setRate] = useState('');
  const [saved, setSaved] = useState(null); // last-saved value for dirty check
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/finance/tax-settings')
      .then((r) => {
        if (!live) return;
        const v = Number(r.defaultTaxRate || 0);
        setRate(v ? String(v) : '');
        setSaved(v);
      })
      .catch(() => { /* card stays editable; save surfaces errors */ });
    return () => { live = false; };
  }, []);

  const dirty = saved !== null && Number(rate || 0) !== saved;

  const save = async () => {
    setBusy(true); setErr(null); setOk(false);
    try {
      const r = await api.patch('/finance/tax-settings', { defaultTaxRate: Number(rate || 0) });
      setSaved(Number(r.defaultTaxRate || 0));
      setOk(true);
      setTimeout(() => setOk(false), 2500);
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Icons.Doc size={16} sw={1.7}/>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Sales tax</h3>
      </div>
      <p style={{ margin: '6px 0 12px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Your default tax rate. New invoices, in-person sales, and billed time
        start with this rate (you can still change it per invoice). Leave it
        at 0 if you don't charge sales tax.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', width: 120 }}>
          <input type="number" min="0" max="100" step="0.001" value={rate}
            onChange={(e) => setRate(e.target.value)} placeholder="0"
            style={{
              width: '100%', padding: '9px 30px 9px 12px', borderRadius: 10,
              border: '1px solid var(--border-strong)', fontSize: 14,
              background: 'var(--surface)', color: 'var(--fg)', outline: 0, boxSizing: 'border-box',
            }}/>
          <span style={{
            position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
            fontSize: 13, color: 'var(--muted)',
          }}>%</span>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}
          style={{ fontSize: 12.5, padding: '9px 16px', opacity: (busy || !dirty) ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {ok && <span style={{ fontSize: 12.5, color: 'var(--ok)', fontWeight: 600 }}>Saved</span>}
      </div>
      {err && (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)',
        }}>{err}</div>
      )}
    </div>
  );
}

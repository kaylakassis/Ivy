// Coupon codes for programs (owner): percent or amount off, one program or
// all of them, optional expiry and use limit, first payment only or every
// payment for subscriptions. Opened from the Programs list.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import { Sheet, Field } from './communityUi.jsx';
import { fmtPrice } from './ProgramContent.jsx';

const label = (c) => (c.kind === 'percent' ? `${c.percentOff}% off` : `${fmtPrice(c.amountOffCents)} off`);

export default function CouponsSheet({ programs, onClose }) {
  const [list, setList] = useState(null); const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { api.get('/programs/coupons').then((r) => setList(r.coupons || [])).catch((e) => { setErr(e.message); setList([]); }); }, []);
  const off = async (c) => {
    if (!window.confirm(`Switch off ${c.code}? It stops working right away. Subscriptions already using it keep their discount.`)) return;
    try { const r = await api.patch('/programs/coupons', { couponId: c.id, active: false }); setList(r.coupons); } catch (e) { setErr(e.message); }
  };
  return (
    <Sheet title="Coupon codes" onClose={onClose} width={560}>
      {adding ? <CouponForm programs={programs} onCancel={() => setAdding(false)} onSaved={(r) => { setList(r.coupons); setAdding(false); }}/> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>Buyers enter a code on the sales page. Codes are also added to your payment account so your dashboard matches.</div>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><Icons.Plus size={13} sw={2}/> New code</button>
          </div>
          {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
          {list === null ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div> : list.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>No codes yet.</div>
          ) : (
            <div className="card">
              {list.map((c, i) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: i ? '1px solid var(--border)' : 'none', opacity: c.active ? 1 : 0.55 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 650, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '.02em' }}>{c.code}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {label(c)} · {c.programTitle || 'all programs'}{c.duration === 'forever' ? ' · every payment' : ''}
                      {c.expiresAt ? ` · until ${new Date(c.expiresAt).toLocaleDateString()}` : ''} · used {c.used}{c.maxRedemptions ? ` of ${c.maxRedemptions}` : ''}{c.active ? '' : ' · off'}
                    </div>
                  </div>
                  {c.active && <button type="button" className="btn btn-ghost" onClick={() => off(c)} style={{ fontSize: 12.5 }}>Switch off</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function CouponForm({ programs, onCancel, onSaved }) {
  const [f, setF] = useState({ code: '', kind: 'percent', value: '', programId: '', duration: 'once', expiresAt: '', maxRedemptions: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const body = {
      code: f.code, kind: f.kind, programId: f.programId || null, duration: f.duration,
      ...(f.kind === 'percent' ? { percentOff: Number(f.value) } : { amountOffCents: Math.round(Number(f.value) * 100) }),
      expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null,
      maxRedemptions: f.maxRedemptions === '' ? null : Number(f.maxRedemptions),
    };
    try { onSaved(await api.post('/programs/coupons', body)); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const anySub = f.programId ? programs.find((p) => p.id === f.programId)?.billing !== 'one_time' : programs.some((p) => p.billing !== 'one_time');
  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Code" hint="Letters, numbers, dashes. Not case sensitive."><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/\s+/g, '') })} placeholder="WELCOME20" maxLength={32} autoFocus required/></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Discount">
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">Percent off</option><option value="amount">Amount off</option></select>
        </Field>
        <Field label={f.kind === 'percent' ? 'Percent' : 'Amount'}>
          <input className="input" type="number" min={f.kind === 'percent' ? 1 : 0.01} max={f.kind === 'percent' ? 100 : undefined} step={f.kind === 'percent' ? 1 : 0.01} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder={f.kind === 'percent' ? '20' : '10.00'} required/>
        </Field>
      </div>
      <Field label="Works on">
        <select className="input" value={f.programId} onChange={(e) => setF({ ...f, programId: e.target.value })}>
          <option value="">All programs</option>
          {programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </Field>
      {anySub && (
        <Field label="On subscriptions">
          <select className="input" value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })}><option value="once">First payment only</option><option value="forever">Every payment</option></select>
        </Field>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Expires" hint="Optional"><input className="input" type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })}/></Field>
        <Field label="Max uses" hint="Optional"><input className="input" type="number" min="1" inputMode="numeric" value={f.maxRedemptions} onChange={(e) => setF({ ...f, maxRedemptions: e.target.value })} placeholder="No limit"/></Field>
      </div>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Back</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !f.code || !f.value}>{busy ? 'Saving…' : 'Create code'}</button>
      </div>
    </form>
  );
}

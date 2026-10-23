// "Other ways to get paid" - Zelle, Venmo, Cash App, cash, check. Nothing
// here moves money through Ivy. The owner lists how to reach them, the
// public invoice page shows the enabled rows with a Copy button and an
// "I've sent it" tap, and the owner confirms from the invoice drawer.
//
// Reads + writes /api/finance/manual-methods. The server validates
// (known types, handle 120 chars, note 300 chars, at most 6 rows, a handle
// is required when a Zelle / Venmo / Cash App row is on).
import React, { useEffect, useState, useCallback } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const ROWS = [
  { type: 'zelle',   label: 'Zelle',    handleLabel: 'Phone or email your Zelle is tied to', placeholder: '(555) 555-0100 or you@example.com' },
  { type: 'venmo',   label: 'Venmo',    handleLabel: 'Venmo username', placeholder: '@your-name' },
  { type: 'cashapp', label: 'Cash App', handleLabel: 'Cashtag', placeholder: '$yourname' },
  { type: 'cash',    label: 'Cash',     simple: true },
  { type: 'check',   label: 'Check',    simple: true, noteLabel: 'Who to make it out to, where to mail it (optional)' },
];

function emptyRow(type) {
  return { type, handle: '', note: '', enabled: false };
}

export default function ManualMethodsCard() {
  const [rows, setRows]     = useState(null);
  const [saved, setSaved]   = useState(null); // JSON snapshot of last saved state
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);
  const [flash, setFlash]   = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/finance/manual-methods');
      const byType = Object.fromEntries((r.methods || []).map((m) => [m.type, m]));
      const next = ROWS.map((d) => ({ ...emptyRow(d.type), ...(byType[d.type] || {}) }));
      setRows(next);
      setSaved(JSON.stringify(next));
    } catch (e) {
      setErr(e.message || 'Could not load payment methods');
      setRows(ROWS.map((d) => emptyRow(d.type)));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = (type, p) => setRows((xs) => xs.map((r) => r.type === type ? { ...r, ...p } : r));
  const dirty = rows && JSON.stringify(rows) !== saved;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      // Only send rows that carry something - an untouched, off row is noise.
      const methods = rows.filter((r) => r.enabled || r.handle || r.note);
      const r = await api.patch('/finance/manual-methods', { methods });
      const byType = Object.fromEntries((r.methods || []).map((m) => [m.type, m]));
      const next = ROWS.map((d) => ({ ...emptyRow(d.type), ...(byType[d.type] || {}) }));
      setRows(next);
      setSaved(JSON.stringify(next));
      setFlash(true);
      setTimeout(() => setFlash(false), 1800);
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return <div className="card" style={{ padding: 20, fontSize: 13, color: 'var(--muted)' }}>Loading other ways to get paid…</div>;
  }

  const enabledCount = rows.filter((r) => r.enabled).length;

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Icons.Dollar size={16} sw={1.7}/>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Other ways to get paid</h3>
        {enabledCount > 0 && (
          <span style={{
            padding: '2px 7px', borderRadius: 999,
            background: 'var(--surface-2)', color: 'var(--ok)',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{enabledCount} on</span>
        )}
      </div>
      <p style={{ margin: '6px 0 16px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Clients see these on every invoice and tell you when they've sent it. You confirm,
        and the invoice is marked paid. Ivy never moves this money. It only keeps track.
      </p>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 12,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ROWS.map((d) => {
          const r = rows.find((x) => x.type === d.type) || emptyRow(d.type);
          return (
            <div key={d.type} style={{
              padding: 14, borderRadius: 12,
              border: '1px solid ' + (r.enabled ? 'var(--accent)' : 'var(--border)'),
              background: r.enabled ? 'var(--accent-soft)' : 'var(--surface)',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <strong style={{ fontSize: 13.5, color: 'var(--fg)', flex: 1 }}>{d.label}</strong>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!r.enabled}
                    onChange={(e) => patch(d.type, { enabled: e.target.checked })}
                    aria-label={`Accept ${d.label}`}/>
                  {r.enabled ? 'On' : 'Off'}
                </label>
              </div>
              {!d.simple && (
                <div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>{d.handleLabel}</div>
                  <input value={r.handle}
                    onChange={(e) => patch(d.type, { handle: e.target.value })}
                    placeholder={d.placeholder}
                    maxLength={120}
                    style={inputS}/>
                </div>
              )}
              {(r.enabled || r.note) && (
                <div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
                    {d.noteLabel || 'Note for the client (optional)'}
                  </div>
                  <input value={r.note}
                    onChange={(e) => patch(d.type, { note: e.target.value })}
                    placeholder={d.type === 'cash' ? 'Example: at your appointment' : ''}
                    maxLength={300}
                    style={inputS}/>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <div style={{ flex: 1, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          Zelle is never a checkout method anywhere. Listing it here is how clients find it.
        </div>
        {flash && <span style={{ fontSize: 12, color: 'var(--ok)' }}>Saved</span>}
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}
          style={{ fontSize: 12, padding: '6px 14px' }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

const inputS = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};

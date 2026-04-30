// Manage the workspace's bookable services. Saves the whole list at once.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import Drawer, { inputSty } from './Drawer.jsx';

export default function ServicesDrawer({ initial, onSave, onClose }) {
  const [items, setItems] = useState(() => initial.length > 0 ? initial.map((s) => ({ ...s })) : [{
    id: null, name: 'Intro session', durationMinutes: 30, price: 0,
  }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const update = (i, patch) => setItems((xs) => xs.map((x, j) => j === i ? { ...x, ...patch } : x));
  const remove = (i) => setItems((xs) => xs.filter((_, j) => j !== i));
  const add = () => setItems((xs) => [...xs, { id: null, name: '', durationMinutes: 60, price: 0 }]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(items.map((s, i) => ({
        id: s.id,
        name: (s.name || '').trim(),
        durationMinutes: Number(s.durationMinutes),
        price: Number(s.price),
        displayOrder: i,
      })));
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Services" subtitle="What clients can book on your calendar." onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.map((s, i) => (
          <div key={i} style={{
            padding: 14, borderRadius: 10, border: '1px solid var(--border)',
            background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input value={s.name} onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Service name" style={{ ...inputSty, flex: 1 }}/>
              <button className="btn btn-ghost" style={{ padding: 6, color: 'var(--danger)' }}
                onClick={() => remove(i)} title="Remove">
                <Icons.Trash size={14}/>
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Duration (min)</span>
                <input type="number" min={5} max={1440} step={5} value={s.durationMinutes}
                  onChange={(e) => update(i, { durationMinutes: Math.max(5, Math.min(1440, Number(e.target.value) || 0)) })}
                  style={inputSty}/>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Price ($)</span>
                <input type="number" min={0} step={1} value={s.price}
                  onChange={(e) => update(i, { price: Math.max(0, Number(e.target.value) || 0) })}
                  style={inputSty}/>
              </label>
            </div>
          </div>
        ))}
        <button className="btn btn-outline" onClick={add} style={{ justifyContent: 'center' }}>
          <Icons.Plus size={13}/> Add service
        </button>
      </div>

      {err && (
        <div style={{
          marginTop: 14, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
        <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}
          style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save services'}
        </button>
      </div>
    </Drawer>
  );
}

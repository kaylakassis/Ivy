// Modal: collect name, email, source — adds as a lead.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';

const SOURCES = ['Referral', 'Instagram', 'Website', 'Email', 'Walk-in', 'Other'];

export default function AddClientModal({ onClose, onAdd }) {
  const [name, setName]     = useState('');
  const [email, setEmail]   = useState('');
  const [source, setSource] = useState('Referral');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);

  const canAdd = name.trim().length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!canAdd) return;
    setBusy(true);
    setErr(null);
    try {
      await onAdd({ name: name.trim(), email: email.trim() || null, source });
    } catch (ex) {
      setErr(ex.message || 'Could not add client');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 120,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="card" style={{ padding: 28, width: '100%', maxWidth: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Users size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, flex: 1 }}>Add new lead</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Name" autoFocus required style={inputS}/>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            type="email" placeholder="Email (optional)" style={inputS}/>
          <div>
            <div className="metric-label" style={{ marginBottom: 6 }}>Source</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {SOURCES.map((s) => (
                <button key={s} type="button" onClick={() => setSource(s)} style={{
                  padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 550, cursor: 'pointer',
                  border: '1px solid ' + (source === s ? 'var(--accent)' : 'var(--border)'),
                  background: source === s ? 'var(--accent-soft)' : 'var(--surface)',
                  color: source === s ? 'var(--accent)' : 'var(--fg-2)',
                }}>{s}</button>
              ))}
            </div>
          </div>
        </div>

        {err && (
          <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button type="button" className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center', opacity: (!canAdd || busy) ? 0.6 : 1 }}
            disabled={!canAdd || busy}>
            <Icons.Plus size={12} sw={2.2}/>{busy ? 'Adding…' : 'Add as lead'}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputS = {
  padding: '10px 12px',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  fontSize: 14,
  background: 'var(--surface)',
  color: 'var(--fg)',
  outline: 0,
};

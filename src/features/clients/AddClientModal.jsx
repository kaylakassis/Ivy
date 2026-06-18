// Modal: collect name + email + phone (all required) + source - adds as a lead.
// Photo upload + per-client attachments live in the full ClientDrawer
// once the lead exists, since upload-then-cancel without a row leaves
// orphan files in Blob.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { useEscapeKey } from '../../lib/useEscapeKey.js';

const SOURCES = ['Referral', 'Instagram', 'Website', 'Email', 'Walk-in', 'Other'];

export default function AddClientModal({ onClose, onAdd }) {
  useEscapeKey(onClose);
  const [name, setName]     = useState('');
  const [email, setEmail]   = useState('');
  const [phone, setPhone]   = useState('');
  const [source, setSource] = useState('Referral');
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState(null);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const trimmedPhone = phone.trim();
  // All three are required. Email validity is a loose check - the
  // server runs the strict one and rejects if needed.
  const emailLooksValid = /\S+@\S+\.\S+/.test(trimmedEmail);
  const phoneLooksValid = trimmedPhone.replace(/\D/g, '').length >= 7;
  const canAdd = trimmedName.length > 0 && emailLooksValid && phoneLooksValid;

  const submit = async (e) => {
    e.preventDefault();
    if (!canAdd) return;
    setBusy(true);
    setErr(null);
    try {
      await onAdd({
        name: trimmedName,
        email: trimmedEmail,
        phone: trimmedPhone,
        source,
      });
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
        className="card" style={{ padding: 28, width: '100%', maxWidth: 460 }}>
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
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Full name" autoFocus required style={inputS}/>
          </Field>
          <Field label="Email">
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              type="email" placeholder="name@example.com" required style={inputS}/>
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)}
              type="tel" inputMode="tel" autoComplete="tel"
              placeholder="(555) 555-5555" required style={inputS}/>
          </Field>
          <Field label="Source">
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
          </Field>
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

function Field({ label, children }) {
  return (
    <div>
      <div className="metric-label" style={{ marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

const inputS = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  fontSize: 14,
  background: 'var(--surface)',
  color: 'var(--fg)',
  outline: 0,
  boxSizing: 'border-box',
};

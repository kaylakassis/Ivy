// Send one of your saved templates to several clients at once. Each
// client gets their own copy to sign (api/documents/send-template.js).
// If the template has fields for a second signer, you sign too: pick
// whether you sign after your client (the usual countersign) or before.
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';

export default function SendTemplateModal({ template, onSend, onClose, onDone }) {
  const needsOwner = (template.fields || []).some((f) => (f.signerIndex || 0) >= 1);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [ownerSigns, setOwnerSigns] = useState(needsOwner ? 'last' : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  useEscapeKey(onClose);

  useEffect(() => {
    let live = true;
    api.get('/clients')
      .then((r) => live && setClients(r.clients || []))
      .catch(() => live && setClients([]))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients
      .filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q))
      .slice(0, 300);
  }, [clients, query]);

  const toggle = (id) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else if (n.size < 50) n.add(id);
    return n;
  });

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await onSend([...picked], ownerSigns);
      setResult(r);
    } catch (e) {
      setErr(e.message || 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Send template" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{
        padding: 0, width: '100%', maxWidth: 540, maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="metric-label">Send to clients</div>
            <h3 style={{ margin: '4px 0 0', fontSize: 16, fontWeight: 600, overflowWrap: 'anywhere' }}>{template.name}</h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close" style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        {result ? (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
              <Icons.Check size={18} sw={2.4} stroke="var(--ok)"/>
              <span>Sent to {result.sent.length} {result.sent.length === 1 ? 'client' : 'clients'}. Each gets their own copy to sign.</span>
            </div>
            {result.skipped.length > 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                Not sent to {result.skipped.map((s) => s.name || 'a client').join(', ')}: {result.skipped.every((s) => s.reason === 'no email') ? 'no email address on file.' : 'they could not be found.'}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={onDone}>Done</button>
            </div>
          </div>
        ) : (
          <>
            {needsOwner && (
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 8 }}>
                  This template has fields for you too. When do you sign?
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[['last', 'After my client'], ['first', 'Before my client']].map(([v, l]) => (
                    <button key={v} type="button" onClick={() => setOwnerSigns(v)} aria-pressed={ownerSigns === v}
                      className={ownerSigns === v ? 'btn btn-primary' : 'btn btn-outline'}
                      style={{ fontSize: 12, padding: '6px 12px' }}>{l}</button>
                  ))}
                </div>
              </div>
            )}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', borderRadius: 10,
                background: 'var(--surface-2)', border: '1px solid var(--border)',
              }}>
                <Icons.Search size={14} stroke="var(--muted)"/>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients"
                  aria-label="Search clients"
                  style={{ flex: 1, background: 'none', border: 0, outline: 'none', fontSize: 14, color: 'var(--fg)', minWidth: 0 }}/>
              </div>
            </div>
            <div className="scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 160 }}>
              {loading ? (
                <div style={{ padding: 28, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
              ) : shown.length === 0 ? (
                <div style={{ padding: 28, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>No clients match.</div>
              ) : shown.map((c) => (
                <label key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', minHeight: 44,
                  borderBottom: '1px solid var(--border)', cursor: c.email ? 'pointer' : 'default',
                  opacity: c.email ? 1 : 0.55,
                }}>
                  <input type="checkbox" checked={picked.has(c.id)} disabled={!c.email} onChange={() => toggle(c.id)}
                    style={{ width: 18, height: 18 }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.email || 'No email on file'}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            {err && (
              <div role="alert" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', color: 'var(--danger)', fontSize: 12.5, background: 'rgba(155,44,44,0.08)' }}>{err}</div>
            )}
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{picked.size} selected{picked.size >= 50 ? ' (50 at a time)' : ''}</span>
              <div style={{ flex: 1 }}/>
              <button onClick={onClose} className="btn btn-outline" disabled={busy}>Cancel</button>
              <button onClick={submit} disabled={busy || picked.size === 0} className="btn btn-primary"
                style={{ opacity: (busy || picked.size === 0) ? 0.6 : 1 }}>
                {busy ? 'Sending…' : `Send to ${picked.size || '…'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

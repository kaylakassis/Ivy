// Pick a client to send a document to.
import React, { useState, useMemo, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function SendDocumentModal({ documentName, onSend, onClose }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/clients')
      .then((r) => live && setClients(r.clients || []))
      .catch(() => live && setClients([]))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients
      .filter((c) => c.email)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q));
  }, [clients, query]);

  const pick = async (clientId) => {
    setBusy(true);
    setErr(null);
    try { await onSend(clientId); }
    catch (e) { setErr(e.message || 'Could not send'); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card scroll" style={{
        padding: 0, width: '100%', maxWidth: 480, maxHeight: '76vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="metric-label">Send for signing</div>
            <h3 style={{ margin: '4px 0 0', fontSize: 16, fontWeight: 600 }}>{documentName}</h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 11px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <Icons.Search size={14} stroke="var(--muted)"/>
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search clients" autoFocus
              style={{ flex: 1, background: 'none', border: 0, outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
          </div>
        </div>

        <div className="scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 200 }}>
          {loading ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              {clients.length === 0
                ? 'Add clients first to send them documents.'
                : 'Clients need an email to receive a signing link.'}
            </div>
          ) : candidates.map((c) => {
            const initials = (c.name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
            return (
              <button key={c.id} disabled={busy} onClick={() => pick(c.id)} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 16px', border: 0, background: 'transparent',
                borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
              }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 99,
                  background: 'var(--accent-soft)', color: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 600, flexShrink: 0,
                }}>{initials}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.email}
                  </div>
                </div>
                <Icons.Arrow size={13} stroke="var(--muted)"/>
              </button>
            );
          })}
        </div>

        {err && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)',
            color: 'var(--danger)', fontSize: 12.5, background: 'rgba(155,44,44,0.08)' }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

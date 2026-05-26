// Multi-recipient send modal. Pick one or more clients, optionally
// reorder them, then send. Each gets a per-signer token (sequential
// signing) — only the first one's email goes out immediately; the
// next signer is auto-emailed when the previous completes.
import React, { useState, useMemo, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';

export default function SendDocumentModal({ documentName, onSend, onClose }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');
  // Ordered array of selected clients. Order = signing order.
  const [picked, setPicked]   = useState([]);
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
    const pickedIds = new Set(picked.map((p) => p.id));
    return clients
      .filter((c) => c.email)
      .filter((c) => !pickedIds.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q));
  }, [clients, picked, query]);

  const add = (c) => setPicked((p) => [...p, c]);
  const remove = (id) => setPicked((p) => p.filter((x) => x.id !== id));
  const moveUp = (i) => setPicked((p) => i === 0 ? p : [
    ...p.slice(0, i - 1), p[i], p[i - 1], ...p.slice(i + 1),
  ]);
  const moveDown = (i) => setPicked((p) => i === p.length - 1 ? p : [
    ...p.slice(0, i), p[i + 1], p[i], ...p.slice(i + 2),
  ]);

  const submit = async () => {
    if (picked.length === 0) return;
    setBusy(true); setErr(null);
    try {
      // Pass an ordered recipients array. The send endpoint accepts
      // either this OR the legacy { clientId } shape.
      await onSend(picked.map((c) => ({ clientId: c.id })));
    } catch (e) {
      setErr(e.message || 'Could not send');
      setBusy(false);
    }
  };

  useEscapeKey(onClose);
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="send-document-title" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card scroll" style={{
        padding: 0, width: '100%', maxWidth: 540, maxHeight: '82vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="metric-label">Send for signing</div>
            <h3 style={{ margin: '4px 0 0', fontSize: 16, fontWeight: 600 }}>{documentName}</h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        {/* Picked signers, in order */}
        {picked.length > 0 && (
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--accent-soft) 30%, transparent)',
          }}>
            <div className="metric-label" style={{ marginBottom: 8 }}>
              Signing order — {picked.length} signer{picked.length === 1 ? '' : 's'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {picked.map((c, i) => (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderRadius: 8,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 99,
                    background: 'var(--accent)', color: 'var(--accent-ink)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, flexShrink: 0,
                  }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.email}
                    </div>
                  </div>
                  <button onClick={() => moveUp(i)} disabled={i === 0}
                    className="btn btn-ghost" style={{ padding: 4, opacity: i === 0 ? 0.3 : 1 }}>
                    <Icons.ArrowDown size={12} sw={2} style={{ transform: 'rotate(180deg)' }}/>
                  </button>
                  <button onClick={() => moveDown(i)} disabled={i === picked.length - 1}
                    className="btn btn-ghost" style={{ padding: 4, opacity: i === picked.length - 1 ? 0.3 : 1 }}>
                    <Icons.ArrowDown size={12} sw={2}/>
                  </button>
                  <button onClick={() => remove(c.id)} className="btn btn-ghost"
                    style={{ padding: 4, color: 'var(--danger)' }}>
                    <Icons.X size={12} sw={2}/>
                  </button>
                </div>
              ))}
            </div>
            {picked.length > 1 && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.45 }}>
                Sequential signing: signer 1 gets the email immediately. Each next signer is auto-emailed when the previous one completes.
              </div>
            )}
          </div>
        )}

        {/* Search + candidate list */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 11px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>
            <Icons.Search size={14} stroke="var(--muted)"/>
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search clients to add" autoFocus
              style={{ flex: 1, background: 'none', border: 0, outline: 'none', fontSize: 13, color: 'var(--fg)' }}/>
          </div>
        </div>

        <div className="scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 160 }}>
          {loading ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
              {clients.length === 0
                ? 'Add clients first to send them documents.'
                : picked.length > 0 ? 'No more matching clients.' : 'Clients need an email to receive a signing link.'}
            </div>
          ) : candidates.map((c) => {
            const initials = (c.name || '?').split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
            return (
              <button key={c.id} onClick={() => add(c)} style={{
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
                <Icons.Plus size={14} stroke="var(--accent)" sw={2}/>
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

        <div style={{
          padding: '12px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 10, alignItems: 'center',
        }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {picked.length} selected
          </span>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} className="btn btn-outline" disabled={busy}>Cancel</button>
          <button onClick={submit} disabled={busy || picked.length === 0}
            className="btn btn-primary"
            style={{ opacity: (busy || picked.length === 0) ? 0.6 : 1 }}>
            {busy ? 'Sending…' : `Send to ${picked.length || '…'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

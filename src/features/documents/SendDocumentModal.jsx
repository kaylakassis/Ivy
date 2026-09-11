// Multi-recipient send modal. Pick one or more clients, optionally
// reorder them, then send. Each gets a per-signer token (sequential
// signing) - only the first one's email goes out immediately; the
// next signer is auto-emailed when the previous completes.
import React, { useState, useMemo, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { useAuth } from '../../lib/auth.jsx';

const SELF_ID = '__self';
// Field labels that name the business side of an agreement - if the
// document has one of these, the owner is meant to sign it too.
const OWNER_ROLE = /\b(coach|provider|trainer|business|owner|company|therapist|stylist|photographer|consultant)\b/i;
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

export default function SendDocumentModal({ documentName, fields = [], onSend, onClose }) {
  const { user } = useAuth();
  const self = useMemo(() => ({
    id: SELF_ID, self: true,
    name: `${user?.name || 'You'} (you)`,
    email: user?.email || '',
  }), [user]);
  // Does this document have a line for the business to sign? If so, and
  // at which position (e.g. a "Coach signature" at signerIndex 0 means
  // the owner is meant to be signer 1).
  const ownerRole = useMemo(() => {
    const f = (fields || []).find((x) => x.type === 'signature' && OWNER_ROLE.test(x.label || ''));
    return f ? { label: f.label, index: Number.isInteger(f.signerIndex) ? f.signerIndex : 0 } : null;
  }, [fields]);
  const [clients, setClients] = useState([]);
  // Inline "add a new person" form - shown when the search finds nobody.
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);
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
  // Put the owner in the slot the document expects (signer 1 for a
  // "Coach signature" line), keeping everyone else in their order.
  const addSelfAt = (index) => setPicked((p) => {
    if (p.some((x) => x.id === SELF_ID)) return p;
    const next = p.slice();
    next.splice(Math.min(index, next.length), 0, self);
    return next;
  });
  const addNewPerson = async () => {
    const name = newName.trim();
    const email = newEmail.trim().toLowerCase();
    if (!name) { setErr('Enter their name'); return; }
    if (!looksLikeEmail(email)) { setErr('Enter a valid email address'); return; }
    setAdding(true); setErr(null);
    try {
      const r = await api.post('/clients', { name, email, source: 'document' });
      const c = r.client || r;
      setClients((cs) => [...cs, c]);
      add(c);
      setNewName(''); setNewEmail(''); setQuery('');
    } catch (e) {
      setErr(e.message || 'Could not add them');
    } finally {
      setAdding(false);
    }
  };
  // Prefill the new-person form from whatever was typed in the search.
  useEffect(() => {
    const q = query.trim();
    if (looksLikeEmail(q)) { setNewEmail(q); }
    else if (q && !newName) { setNewName(q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
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
      await onSend(picked.map((c) => (c.self ? { self: true } : { clientId: c.id })));
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
              Signing order - {picked.length} signer{picked.length === 1 ? '' : 's'}
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

        {/* This document has a line for the business to sign. */}
        {ownerRole && !picked.some((c) => c.id === SELF_ID) && (
          <div style={{
            margin: '12px 16px 0', padding: '10px 12px', borderRadius: 10,
            background: 'var(--accent-soft)', border: '1px solid var(--accent)',
            display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5,
          }}>
            <Icons.Edit size={14} sw={1.8} stroke="var(--accent)"/>
            <span style={{ flex: 1, color: 'var(--fg-2)' }}>
              This document has a <b>{ownerRole.label}</b> line, so you sign it too.
            </span>
            <button type="button" className="btn btn-primary" style={{ padding: '5px 10px', fontSize: 12 }}
              onClick={() => addSelfAt(ownerRole.index)}>
              Add me as signer {ownerRole.index + 1}
            </button>
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
          {/* The owner can always sign too. Sits above the client list. */}
          {!loading && self.email && !picked.some((c) => c.id === SELF_ID) && !query.trim() && (
            <button onClick={() => add(self)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 16px', border: 0, background: 'transparent',
              borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{
                width: 36, height: 36, borderRadius: 99,
                background: 'var(--accent)', color: 'var(--accent-ink)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}><Icons.Edit size={15} sw={1.8}/></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{self.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>Countersign it yourself · {self.email}</div>
              </div>
              <Icons.Plus size={14} stroke="var(--accent)" sw={2}/>
            </button>
          )}
          {loading ? (
            <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: '18px 16px 22px' }}>
              <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                {clients.length === 0
                  ? 'No clients yet. Add the person here and they become a client too.'
                  : query.trim() ? `No client matches "${query.trim()}". Add them as a new person:` : picked.length > 0 ? 'No more matching clients.' : 'Clients need an email to receive a signing link.'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Their name"
                  aria-label="New signer name" style={newInput}/>
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Their email" type="email"
                  aria-label="New signer email" style={newInput}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNewPerson(); } }}/>
                <button type="button" className="btn btn-outline" onClick={addNewPerson} disabled={adding}
                  style={{ justifyContent: 'center' }}>
                  <Icons.Plus size={12} sw={2}/> {adding ? 'Adding…' : 'Add as signer'}
                </button>
              </div>
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

const newInput = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13.5, outline: 'none',
};

// Choose (or change) who a draft invoice is for, from inside the invoice
// editor. Before this, a new invoice said "No client yet" and the only
// place to pick one was the Send step, so an invoice that was marked paid
// or collected in person never got a client at all.
//
// Opens in place under the invoice title: a search box and the owner's
// clients. Picking one saves straight away.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function InvoiceClientPicker({ invoice, onPick, mobile = false }) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open || clients) return undefined;
    let live = true;
    api.get('/clients')
      .then((r) => live && setClients(r.clients || []))
      .catch(() => live && setClients([]));
    return () => { live = false; };
  }, [open, clients]);
  useEffect(() => { if (open && !mobile) inputRef.current?.focus(); }, [open, mobile]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (clients || [])
      .filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q))
      .slice(0, 50);
  }, [clients, query]);

  const pick = async (c) => {
    setBusy(c.id); setErr(null);
    try {
      await onPick({ clientId: c.id, clientName: c.name, clientEmail: c.email || null });
      setOpen(false); setQuery('');
    } catch (e) {
      setErr(e.message || 'Could not set the client. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const has = !!invoice.clientId || !!invoice.clientName;
  return (
    <div style={{ marginTop: 8 }}>
      {!open && (
        <button type="button" className={has ? 'btn btn-ghost' : 'btn btn-outline'} onClick={() => setOpen(true)}
          style={{ fontSize: 12.5, padding: has ? '4px 8px' : '7px 12px', marginLeft: has ? -8 : 0, minHeight: mobile ? 40 : undefined }}>
          <Icons.Users size={13}/> {has ? 'Change client' : 'Choose a client'}
        </button>
      )}
      {open && (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 10, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
            <Icons.Search size={14} stroke="var(--muted)"/>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your clients" aria-label="Search your clients"
              autoCapitalize="none" autoCorrect="off"
              style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', color: 'var(--fg)', fontSize: 16 }}/>
            <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setQuery(''); setErr(null); }}
              style={{ fontSize: 12.5, padding: '4px 8px' }}>Cancel</button>
          </div>
          <div className="scroll" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {clients === null && <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)' }}>Loading your clients…</div>}
            {clients !== null && matches.length === 0 && (
              <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                {clients.length === 0 ? 'You have no clients yet. Add one in Clients, then come back.' : 'No client matches that.'}
              </div>
            )}
            {matches.map((c) => (
              <button key={c.id} type="button" onClick={() => pick(c)} disabled={!!busy}
                style={{
                  all: 'unset', position: 'relative', boxSizing: 'border-box', width: '100%', cursor: busy ? 'wait' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', minHeight: 44,
                  borderBottom: '1px solid var(--border)',
                  background: c.id === invoice.clientId ? 'var(--accent-soft)' : 'transparent',
                }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || 'Unnamed client'}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.email || 'No email on file (you can still mark it paid or collect in person)'}
                  </span>
                </span>
                {busy === c.id ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>Saving…</span>
                  : c.id === invoice.clientId ? <Icons.Check size={14} stroke="var(--accent)"/> : null}
              </button>
            ))}
          </div>
          {err && <div role="alert" style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
